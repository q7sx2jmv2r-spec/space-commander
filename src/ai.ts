// AI opponents (QUA-123, extended by QUA-132). One controller per AI faction,
// dispatched by sim.update() when a faction's next-decision tick comes due.
// Controllers read GameState and return Command intents — they never mutate
// planets or fleets directly. Every random draw (interval jitter) comes from
// the seeded state.rng in a fixed order, so a seed reproduces the whole game;
// everything added for QUA-132 (routing, specialisation, valuation) is pure
// sorting and arithmetic with id tie-breaks, drawing no randomness at all.
//
// Heuristics are deliberately readable over clever (they get hand-tuned in
// QUA-126); tier differences live in AI_TIERS config data, not in code paths.

import {
  Owner,
  Spec,
  AiTier,
  AiTierConfig,
  AI_TIERS,
  PRODUCTION,
  SHIP_SPEED,
  TICK_RATE,
  DEVELOPMENT,
} from "./config";
import { nextRange } from "./rng";
import { planetLevel, garrisonCap, defendMultiplier } from "./sim";
import { predictRoute } from "./predict";
import type { Command, GameState, Planet } from "./sim";

/** Per-opponent AI state. Lives inside GameState so snapshot/resume keeps
 * bit-perfect determinism — an external timer would desync replays. */
export interface AiState {
  owner: Owner;
  tier: AiTier;
  nextDecisionTick: number;
  /** Planet being groomed for a specialisation conversion (QUA-132), or -1.
   * Sticky across decisions: the groomed planet is spared as a send source
   * so it can bank production toward the conversion cost — without the
   * stickiness, banking makes it the fattest planet, which would make it the
   * next attack source and drain it again. */
  groomId: number;
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

/** Effective ships an attack must exceed when a fleet launched now arrives:
 * the garrison plus its production over the travel time (level multiplier
 * applied, capped, neutrals and converting planets produce 0), multiplied by
 * the spec's defence strength (QUA-130/132). */
function defenseAtArrival(target: Planet, from: Planet): number {
  const travel = dist(from, target) / SHIP_SPEED;
  let garrison = target.garrison;
  if (target.owner !== "neutral" && target.convertTicks === 0) {
    const cap = garrisonCap(target);
    if (garrison < cap) {
      const rate = PRODUCTION[target.size] * DEVELOPMENT.productionMult[planetLevel(target) - 1]!;
      garrison = Math.min(cap, garrison + rate * travel);
    }
  }
  return garrison * defendMultiplier(target);
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

// Specialisation is an empire-shape move, not an opening: below this many
// owned planets the AI keeps expanding instead — converting (or grooming) a
// 1-2 planet empire's main source paralyses it while the enemy snowballs.
const SPECS_MIN_PLANETS = 3;

/** Overwhelming-force margin: an L3 defence fortress only scores normally
 * when the send would exceed this multiple of its effective defence. */
const FORTRESS_OVERWHELM = 3;

/** Candidate targets, cheapest-first: low effective defence and short
 * distance win, with QUA-132 valuation — developed targets cost more, enemy
 * economy planets are juicier, and an L3 defence fortress is near-untouchable
 * without overwhelming force. Deterministic tie-break by planet id. */
function scoreTargets(state: GameState, cfg: AiTierConfig, source: Planet, owner: Owner): Scored[] {
  const sendable = Math.floor(source.garrison * cfg.attackFraction);
  const out: Scored[] = [];
  for (const p of state.planets) {
    if (p.owner === owner) continue;
    const d = dist(source, p);
    let score =
      p.garrison * defendMultiplier(p) * cfg.garrisonWeight +
      d * cfg.distanceWeight +
      (planetLevel(p) - 1) * cfg.levelWeight;
    if (cfg.countersEmptied && p.owner !== "neutral" && p.garrison <= EMPTIED_GARRISON) {
      score *= EMPTIED_SCORE_FACTOR;
    }
    if (p.owner !== "neutral" && p.spec === "economy") {
      score *= cfg.economyScoreFactor;
    }
    if (p.spec === "defence" && planetLevel(p) === 3) {
      if (sendable <= FORTRESS_OVERWHELM * p.garrison * defendMultiplier(p)) {
        score *= cfg.fortressScoreFactor;
      }
    }
    out.push({ planet: p, score, d });
  }
  out.sort((a, b) => a.score - b.score || a.planet.id - b.planet.id);
  return out;
}

/** Reinforce owned planets whose known incoming hostiles exceed what they can
 * hold (spec: medium reinforces the directly threatened; hard also moves when
 * the threat merely exceeds the garrison of a neighbour it can save). The
 * planet groomed for conversion (planSpecs) is never used as a helper — it
 * has to bank its garrison or specialisation starves. */
function planDefense(
  state: GameState,
  ai: AiState,
  cfg: AiTierConfig,
  commands: Command[],
  budget: number,
  groomedId: number
): number {
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
      if (h.id === planet.id || h.id === groomedId) continue;
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

/** Hard's corridor play (QUA-132): when the direct route is too hot, find a
 * stepping-stone planet — owned, or a neutral this send could capture — that
 * shortens the exposed final leg and is itself safely reachable; the best
 * candidate minimises the predicted final-leg losses (first-lowest in planet
 * array order = deterministic id tie-break). Multi-leg journeys need no AI
 * state: the next decision simply continues from the hop. */
function findStagingHop(
  state: GameState,
  cfg: AiTierConfig,
  ai: AiState,
  source: Planet,
  target: Planet,
  sendable: number
): Planet | null {
  let best: Planet | null = null;
  let bestLoss = Infinity;
  for (const hop of state.planets) {
    if (hop.id === source.id || hop.id === target.id) continue;
    if (hop.owner !== ai.owner) {
      if (hop.owner !== "neutral") continue;
      if (sendable <= defenseAtArrival(hop, source)) continue; // can't take it
    }
    if (dist(hop, target) >= dist(source, target)) continue; // must close in
    const leg = predictRoute(state, ai.owner, source.id, hop.id, sendable);
    if (leg.losses > cfg.maxAttritionFraction * sendable) continue; // hop leg too hot
    const finalLeg = predictRoute(state, ai.owner, hop.id, target.id, sendable);
    if (finalLeg.losses < bestLoss) {
      best = hop;
      bestLoss = finalLeg.losses;
    }
  }
  return best;
}

/** One attack per remaining budget slot. Every send is routed with the shared
 * predictor first (QUA-132): routes losing more than maxAttritionFraction of
 * the fleet are rejected — hard stages through a hop instead, everyone else
 * moves to the next-cheapest target. Single-source when possible; hard pools
 * 2–3 sources for targets no single planet can crack. */
function planAttacks(
  state: GameState,
  ai: AiState,
  cfg: AiTierConfig,
  commands: Command[],
  budget: number,
  groomedId: number
): void {
  if (budget <= 0) return;
  // The planet being groomed for conversion (planSpecs) is spared as a source.
  const mine = state.planets
    .filter((p) => p.owner === ai.owner && p.id !== groomedId)
    .sort((a, b) => b.garrison - a.garrison || a.id - b.id);
  if (mine.length === 0) return;

  const source = mine[0]!;
  const sendable = Math.floor(source.garrison * cfg.attackFraction);
  if (sendable < 1) return;
  const reserveOk = (p: Planet, frac: number) =>
    p.garrison * (1 - frac) >= p.garrison * cfg.reserveFraction;
  const tooHot = (losses: number, ships: number) => losses > cfg.maxAttritionFraction * ships;

  const targets = scoreTargets(state, cfg, source, ai.owner);
  for (const t of targets) {
    if (budget <= 0) return;
    const target = t.planet;
    const route = predictRoute(state, ai.owner, source.id, target.id, sendable);

    if (tooHot(route.losses, sendable)) {
      if (cfg.stagesHops) {
        const hop = findStagingHop(state, cfg, ai, source, target, sendable);
        if (hop && reserveOk(source, cfg.attackFraction) && leavesDefensible(state, source, sendable)) {
          log(ai, state, `stage toward p${target.id} via p${hop.id}: direct route loses ${route.losses.toFixed(1)}/${sendable}`);
          send(commands, ai, [source.id], hop.id, cfg.attackFraction);
          budget -= 1;
        }
      }
      continue; // never fly the suicide route
    }
    const survivors = sendable - route.losses;

    if (!cfg.checksFeasibility) {
      // Easy: naive — compares raw garrisons only, happily mispredicts
      // (but even easy won't exceed its attrition tolerance, above).
      if (sendable > target.garrison) {
        log(ai, state, `attack p${target.id}: naive ${sendable} vs ${target.garrison.toFixed(0)}, from p${source.id}`);
        send(commands, ai, [source.id], target.id, cfg.attackFraction);
        return; // easy never issues more than one send
      }
      continue;
    }

    const needed = defenseAtArrival(target, source);
    if (survivors > needed) {
      if (!reserveOk(source, cfg.attackFraction) || !leavesDefensible(state, source, sendable)) continue;
      log(ai, state, `attack p${target.id}: ${sendable} (−${route.losses.toFixed(1)} in transit) vs ${needed.toFixed(1)} at arrival, from p${source.id} (score ${t.score.toFixed(1)})`);
      send(commands, ai, [source.id], target.id, cfg.attackFraction);
      budget -= 1;
      continue;
    }

    if (cfg.combinesFleets && mine.length >= 2) {
      // Pool the 2–3 strongest planets; each contributes attackFraction and
      // pays its own predicted route attrition.
      const pool: Planet[] = [];
      let pooledSurvivors = 0;
      for (const p of mine) {
        if (pool.length === 3) break;
        const contrib = Math.floor(p.garrison * cfg.attackFraction);
        if (contrib < 1) continue;
        if (!leavesDefensible(state, p, contrib)) continue;
        const r = predictRoute(state, ai.owner, p.id, target.id, contrib);
        if (tooHot(r.losses, contrib)) continue;
        pool.push(p);
        pooledSurvivors += contrib - r.losses;
      }
      const neededPooled = defenseAtArrival(target, pool[pool.length - 1] ?? source);
      if (pool.length >= 2 && pooledSurvivors > neededPooled) {
        log(ai, state, `pooled attack p${target.id}: ${pooledSurvivors.toFixed(1)} surviving from [${pool.map((p) => `p${p.id}`).join(",")}] vs ${neededPooled.toFixed(1)} at arrival`);
        send(commands, ai, pool.map((p) => p.id), target.id, cfg.attackFraction);
        budget -= 1;
      }
    }
    // Neither alone nor pooled: try the next-cheapest target.
  }
}

/** Specialisation strategy (QUA-132, medium+): each decision classifies owned
 * planets — *border* (an enemy planet among the borderNeighbors nearest
 * planets) or *interior* — and converts at most one planet toward its desired
 * spec: border → defence; interior → economy, except the navalCount interior
 * planets closest to the enemy front → naval. Converts only from a planet
 * that is idle, safe (no inbound hostiles) and garrisoned comfortably above
 * the 15-ship cost. Hard (reconsidersSpecs) also re-converts planets whose
 * desired spec changed as the border moved; the conversion cost throttles
 * thrash. Pure sorting with id tie-breaks — no RNG.
 *
 * Returns the id of a planet being GROOMED for conversion (wants one but is
 * still short of convertGarrisonMin), or -1. planAttacks spares that planet
 * as a send source so it can bank production toward the cost — without this,
 * an aggressive tier's constant sends keep every garrison below the gate and
 * specialisation never happens. */
function planSpecs(state: GameState, ai: AiState, cfg: AiTierConfig, commands: Command[]): number {
  if (!cfg.usesSpecs) return -1;
  const enemies = state.planets.filter((p) => p.owner !== ai.owner && p.owner !== "neutral");
  if (enemies.length === 0) return -1;
  const mine = state.planets.filter((p) => p.owner === ai.owner);
  // Specialise only from a position of strength — both dominance (not behind
  // on planet count) and affordability (spare ships empire-wide). Paying
  // conversion taxes from a desperate fight is how the early attempts at
  // this heuristic lost games.
  if (mine.length < SPECS_MIN_PLANETS || mine.length < enemies.length) return -1;
  let totalGarrison = 0;
  for (const p of mine) totalGarrison += p.garrison;
  if (totalGarrison < cfg.specsMinEmpireGarrison) return -1;

  const isBorder = (p: Planet): boolean => {
    const neighbours = state.planets
      .filter((o) => o.id !== p.id)
      .sort((a, b) => dist(p, a) - dist(p, b) || a.id - b.id);
    const k = Math.min(cfg.borderNeighbors, neighbours.length);
    for (let i = 0; i < k; i++) {
      const o = neighbours[i]!;
      if (o.owner !== ai.owner && o.owner !== "neutral") return true;
    }
    return false;
  };
  const border = new Set<number>();
  for (const p of mine) if (isBorder(p)) border.add(p.id);

  const enemyDist = (p: Planet): number => {
    let d = Infinity;
    for (const e of enemies) d = Math.min(d, dist(p, e));
    return d;
  };
  const navalIds = new Set(
    mine
      .filter((p) => !border.has(p.id))
      .sort((a, b) => enemyDist(a) - enemyDist(b) || a.id - b.id)
      .slice(0, cfg.navalCount)
      .map((p) => p.id)
  );

  const desiredFor = (p: Planet): Spec =>
    border.has(p.id) ? "defence" : navalIds.has(p.id) ? "naval" : "economy";
  const isCandidate = (p: Planet): boolean =>
    p.convertTicks === 0 &&
    p.spec !== desiredFor(p) &&
    (p.spec === "standard" || cfg.reconsidersSpecs);

  // Validate the sticky groom target: drop it once converted, captured, or
  // no longer wanting a conversion.
  if (ai.groomId >= 0) {
    const g = state.planets[ai.groomId];
    if (!g || g.owner !== ai.owner || !isCandidate(g)) ai.groomId = -1;
  }

  // Convert anything that is ready — fat enough and not under attack. The
  // groomed planet is usually the one that gets here.
  for (const p of mine) {
    if (!isCandidate(p)) continue;
    if (p.garrison < cfg.convertGarrisonMin || incomingHostile(state, p) > 0) continue;
    const desired = desiredFor(p);
    log(ai, state, `convert p${p.id} → ${desired} (${border.has(p.id) ? "border" : "interior"})`);
    commands.push({ type: "convert", owner: ai.owner, planet: p.id, to: desired });
    if (ai.groomId === p.id) ai.groomId = -1;
    return ai.groomId; // at most one conversion per decision
  }

  // Pick a new groom target when idle: the fattest candidate (first id on
  // ties) that is NOT the empire's strongest planet — that one is the attack
  // source and sparing it would pacify the whole AI. A threatened planet may
  // still bank (held-back ships defend it); it just can't convert until the
  // attack clears.
  if (ai.groomId === -1) {
    let strongest = mine[0]!;
    for (const p of mine) {
      if (p.garrison > strongest.garrison) strongest = p;
    }
    let groom: Planet | null = null;
    for (const p of mine) {
      if (p.id === strongest.id || !isCandidate(p)) continue;
      if (groom === null || p.garrison > groom.garrison) groom = p;
    }
    if (groom) {
      ai.groomId = groom.id;
      log(ai, state, `groom p${groom.id} → ${desiredFor(groom)} (g=${groom.garrison.toFixed(1)}/${cfg.convertGarrisonMin})`);
    }
  }
  return ai.groomId;
}

/** Full decision for one AI: specialisation planning first (its groomed
 * planet must be known before anything can drain it; at most one conversion,
 * outside the send budget), then defense, then attacks within the
 * per-decision send cap. Returns intents; never touches state. */
export function aiDecide(state: GameState, ai: AiState): Command[] {
  const cfg = AI_TIERS[ai.tier];
  const commands: Command[] = [];
  let budget = cfg.maxSendsPerDecision;
  const groomedId = planSpecs(state, ai, cfg, commands);
  if (cfg.reinforces) {
    budget = planDefense(state, ai, cfg, commands, budget, groomedId);
  }
  planAttacks(state, ai, cfg, commands, budget, groomedId);
  if (commands.length === 0) log(ai, state, "no viable action");
  return commands;
}

/** Ticks until the next decision, jittered inside the tier's interval via the
 * seeded PRNG (deterministic). */
export function nextDecisionDelay(state: GameState, tier: AiTier): number {
  const cfg = AI_TIERS[tier];
  return Math.max(1, Math.round(nextRange(state.rng, cfg.interval.min, cfg.interval.max) * TICK_RATE));
}
