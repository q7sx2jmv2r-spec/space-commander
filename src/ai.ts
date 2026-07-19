// AI opponents (QUA-123). One controller per AI faction, dispatched by
// sim.update() when a faction's next-decision tick comes due. Controllers
// read GameState and return Command intents — they never mutate planets or
// fleets directly. Every random draw (interval jitter, tie-breaks) comes from
// the seeded state.rng in a fixed order, so a seed reproduces the whole game.
//
// Heuristics are deliberately readable over clever (they get hand-tuned in
// QUA-126); tier differences live in AI_TIERS config data, not in code paths.

import {
  Owner,
  AiTier,
  AiTierConfig,
  AI_TIERS,
  PRODUCTION,
  SHIP_SPEED,
  TICK_RATE,
} from "./config";
import { nextRange } from "./rng";
import type { Command, GameState, Planet } from "./sim";

/** Per-opponent AI state. Lives inside GameState so snapshot/resume keeps
 * bit-perfect determinism — an external timer would desync replays. */
export interface AiState {
  owner: Owner;
  tier: AiTier;
  nextDecisionTick: number;
}

// --- Debug log (toggleable; the QUA-126 tuning instrument) ------------------

let logEnabled = false;

export function setAiLog(on: boolean): void {
  logEnabled = on;
}

function log(ai: AiState, state: GameState, msg: string): void {
  if (logEnabled) console.log(`[${ai.owner}/${ai.tier}] t=${state.tick} ${msg}`);
}

// --- Shared helpers ---------------------------------------------------------

function dist(a: Planet, b: Planet): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Ships the target will hold when a fleet launched now arrives: current
 * garrison plus its production over the travel time (neutrals produce 0). */
function defenseAtArrival(target: Planet, from: Planet): number {
  const travel = dist(from, target) / SHIP_SPEED;
  const prod = target.owner === "neutral" ? 0 : PRODUCTION[target.size] * travel;
  return target.garrison + prod;
}

/** Total ships aboard hostile fleets currently inbound to `planet`. */
function incomingHostile(state: GameState, planet: Planet): number {
  let ships = 0;
  for (const f of state.fleets) {
    if (f.destId === planet.id && f.owner !== planet.owner) ships += f.ships;
  }
  return ships;
}

/** Total friendly reinforcements currently inbound to `planet`. */
function incomingFriendly(state: GameState, planet: Planet): number {
  let ships = 0;
  for (const f of state.fleets) {
    if (f.destId === planet.id && f.owner === planet.owner) ships += f.ships;
  }
  return ships;
}

/** Guardrail (medium/hard): after sending `ships`, could the source still
 * absorb every hostile fleet already known to be inbound? */
function leavesDefensible(state: GameState, source: Planet, ships: number): boolean {
  const threat = incomingHostile(state, source);
  if (threat === 0) return true;
  return source.garrison - ships + incomingFriendly(state, source) >= threat;
}

function send(
  commands: Command[],
  ai: AiState,
  from: number[],
  to: number,
  fraction: number
): void {
  commands.push({ type: "send", owner: ai.owner, from: [...from].sort((a, b) => a - b), to, fraction });
}

// --- Decision logic ---------------------------------------------------------

interface Scored {
  planet: Planet;
  score: number;
  d: number;
}

// A hostile-owned planet at or below this garrison reads as "just emptied by
// a big send" — hard counter-attacks it before it refills (countersEmptied).
const EMPTIED_GARRISON = 5;
const EMPTIED_SCORE_FACTOR = 0.4;

/** Candidate targets, cheapest-first: low garrison and short distance win.
 * Deterministic tie-break by planet id. */
function scoreTargets(state: GameState, cfg: AiTierConfig, source: Planet, owner: Owner): Scored[] {
  const out: Scored[] = [];
  for (const p of state.planets) {
    if (p.owner === owner) continue;
    const d = dist(source, p);
    let score = p.garrison * cfg.garrisonWeight + d * cfg.distanceWeight;
    if (cfg.countersEmptied && p.owner !== "neutral" && p.garrison <= EMPTIED_GARRISON) {
      score *= EMPTIED_SCORE_FACTOR;
    }
    out.push({ planet: p, score, d });
  }
  out.sort((a, b) => a.score - b.score || a.planet.id - b.planet.id);
  return out;
}

/** Reinforce owned planets whose known incoming hostiles exceed what they can
 * hold (spec: medium reinforces the directly threatened; hard also moves when
 * the threat merely exceeds the garrison of a neighbour it can save). */
function planDefense(state: GameState, ai: AiState, cfg: AiTierConfig, commands: Command[], budget: number): number {
  const mine = state.planets.filter((p) => p.owner === ai.owner);
  for (const planet of mine) {
    if (budget <= 0) break;
    const threat = incomingHostile(state, planet);
    if (threat === 0) continue;
    const holding = planet.garrison + incomingFriendly(state, planet);
    if (holding >= threat) continue;

    // Nearest owned planet that can spare ships without dooming itself.
    let helper: Planet | null = null;
    let helperDist = Infinity;
    for (const h of mine) {
      if (h.id === planet.id) continue;
      const spare = Math.floor(h.garrison * cfg.reinforceFraction);
      if (spare < 1) continue;
      if (!leavesDefensible(state, h, spare)) continue;
      const d = dist(h, planet);
      if (d < helperDist) {
        helper = h;
        helperDist = d;
      }
    }
    if (helper) {
      log(ai, state, `reinforce p${planet.id}: threat ${threat} > holding ${holding.toFixed(1)}, sending ${cfg.reinforceFraction * 100}% from p${helper.id}`);
      send(commands, ai, [helper.id], planet.id, cfg.reinforceFraction);
      budget -= 1;
    }
  }
  return budget;
}

/** One attack per remaining budget slot. Single-source when possible; hard
 * pools 2–3 sources for targets no single planet can crack. */
function planAttacks(state: GameState, ai: AiState, cfg: AiTierConfig, commands: Command[], budget: number): void {
  if (budget <= 0) return;
  const mine = state.planets
    .filter((p) => p.owner === ai.owner)
    .sort((a, b) => b.garrison - a.garrison || a.id - b.id);
  if (mine.length === 0) return;

  const source = mine[0]!;
  const sendable = Math.floor(source.garrison * cfg.attackFraction);
  if (sendable < 1) return;
  const reserveOk = (p: Planet, frac: number) =>
    p.garrison * (1 - frac) >= p.garrison * cfg.reserveFraction;

  const targets = scoreTargets(state, cfg, source, ai.owner);
  for (const t of targets) {
    if (budget <= 0) return;
    const target = t.planet;
    const needed = defenseAtArrival(target, source);
    const canAlone = sendable > needed;

    if (!cfg.checksFeasibility) {
      // Easy: naive — compares raw garrisons only, happily mispredicts.
      if (sendable > target.garrison) {
        log(ai, state, `attack p${target.id}: naive ${sendable} vs ${target.garrison.toFixed(0)}, from p${source.id}`);
        send(commands, ai, [source.id], target.id, cfg.attackFraction);
        return; // easy never issues more than one send
      }
      continue;
    }

    if (canAlone) {
      if (!reserveOk(source, cfg.attackFraction) || !leavesDefensible(state, source, sendable)) continue;
      log(ai, state, `attack p${target.id}: ${sendable} vs ${needed.toFixed(1)} at arrival, from p${source.id} (score ${t.score.toFixed(1)})`);
      send(commands, ai, [source.id], target.id, cfg.attackFraction);
      budget -= 1;
      continue;
    }

    if (cfg.combinesFleets && mine.length >= 2) {
      // Pool the 2–3 strongest planets; each contributes attackFraction.
      const pool: Planet[] = [];
      let pooled = 0;
      for (const p of mine) {
        if (pool.length === 3) break;
        const contrib = Math.floor(p.garrison * cfg.attackFraction);
        if (contrib < 1) continue;
        if (!leavesDefensible(state, p, contrib)) continue;
        pool.push(p);
        pooled += contrib;
      }
      const neededPooled = defenseAtArrival(target, pool[pool.length - 1] ?? source);
      if (pool.length >= 2 && pooled > neededPooled) {
        log(ai, state, `pooled attack p${target.id}: ${pooled} from [${pool.map((p) => `p${p.id}`).join(",")}] vs ${neededPooled.toFixed(1)} at arrival`);
        send(commands, ai, pool.map((p) => p.id), target.id, cfg.attackFraction);
        budget -= 1;
      }
    }
    // Neither alone nor pooled: try the next-cheapest target.
  }
}

/** Full decision for one AI: defense first, then attacks, all within the
 * per-decision send cap. Returns intents; never touches state. */
export function aiDecide(state: GameState, ai: AiState): Command[] {
  const cfg = AI_TIERS[ai.tier];
  const commands: Command[] = [];
  let budget = cfg.maxSendsPerDecision;
  if (cfg.reinforces) {
    budget = planDefense(state, ai, cfg, commands, budget);
  }
  planAttacks(state, ai, cfg, commands, budget);
  if (commands.length === 0) log(ai, state, "no viable action");
  return commands;
}

/** Ticks until the next decision, jittered inside the tier's interval via the
 * seeded PRNG (deterministic). */
export function nextDecisionDelay(state: GameState, tier: AiTier): number {
  const cfg = AI_TIERS[tier];
  return Math.max(1, Math.round(nextRange(state.rng, cfg.interval.min, cfg.interval.max) * TICK_RATE));
}
