// Deterministic game simulation (QUA-119). This module must stay DOM-free
// (it runs under plain node in the test suite) and must never touch
// Math.random or Date.now — all randomness flows through the RngState inside
// GameState, and draw order is part of the determinism contract.

import {
  Owner,
  Size,
  Spec,
  TICK_DT,
  TICK_RATE,
  PRODUCTION,
  SHIP_SPEED,
  DEVELOPMENT,
  GARRISON_CAP,
  SPECS,
} from "./config";
import { RngState } from "./rng";
import { generateMap } from "./mapgen";
import { AiState, aiDecide, nextDecisionDelay } from "./ai";

export type { Owner, Size, Spec };
export type { AiState };
export { TICK_DT, TICK_RATE, WORLD_W, WORLD_H } from "./config";

export const NEUTRAL: Owner = "neutral";
export const PLAYER: Owner = "player";
export const AI1: Owner = "ai1";

export interface Planet {
  id: number; // index in planets[]; stable for the whole game
  x: number;
  y: number;
  size: Size;
  owner: Owner;
  garrison: number; // fractional internally; use Math.floor for display/sending
  /** Ticks held by the current owner (QUA-128). Integer, incremented once per
   * tick; reset to 0 when the planet changes hands. Level is derived from
   * this via planetLevel(), never stored. */
  heldTicks: number;
  /** Specialisation (QUA-130). `spec` keeps its old value while a conversion
   * runs (convertTicks > 0, completing into `nextSpec`), but its bonuses are
   * offline during the downtime. Capture resets all three. */
  spec: Spec;
  nextSpec: Spec;
  convertTicks: number;
}

export interface Fleet {
  id: number;
  owner: Owner;
  ships: number; // integer
  originId: number;
  destId: number;
  /** 0..1 along the origin→destination center line. Position is derived, not
   * stored: origin/dest planets never move, so the lerp is exact. */
  progress: number;
}

export interface SendCommand {
  type: "send";
  owner: Owner;
  from: number[]; // source planet ids, sorted ascending
  to: number;
  /** Fraction of each source garrison to send (0..1]. */
  fraction: number;
}

/** Start converting an owned planet to a specialisation type (QUA-130). */
export interface ConvertCommand {
  type: "convert";
  owner: Owner;
  planet: number;
  to: Spec;
}

export type Command = SendCommand | ConvertCommand;

export type Phase = "playing" | "playerWon" | "aiWon";

/** Whole game state. Must stay JSON-serializable: plain data only, no
 * functions, no NaN/Infinity, so games can be snapshotted and replayed. */
export interface GameState {
  tick: number;
  seed: number; // for display/debug; rng holds the live PRNG state
  rng: RngState;
  planets: Planet[];
  fleets: Fleet[];
  nextFleetId: number;
  phase: Phase;
  /** AI opponents (QUA-123). Inside GameState (not an external controller) so
   * a JSON snapshot resumes bit-identically, decision timers included. */
  ai: AiState[];
}

/** Standard skirmish start. Map generation (seeding, layout, fairness) lives
 * in mapgen.ts; this is a thin wrapper so callers get a 2-faction game from a
 * seed. Use generateMap directly for other faction counts. */
export function createGame(seed: number): GameState {
  return generateMap(seed, 2);
}

/** Development level (QUA-128), derived from time held so it can never desync
 * from heldTicks. Neutral planets never develop. */
export function planetLevel(p: Planet): 1 | 2 | 3 {
  if (p.owner === NEUTRAL) return 1;
  if (p.heldTicks >= DEVELOPMENT.levelTimes[2] * TICK_RATE) return 3;
  if (p.heldTicks >= DEVELOPMENT.levelTimes[1] * TICK_RATE) return 2;
  return 1;
}

/** Soft garrison cap (QUA-128): production stops here; reinforcement and
 * capture surpluses may exceed it (see GARRISON_CAP). */
export function garrisonCap(p: Planet): number {
  return GARRISON_CAP[p.size] * DEVELOPMENT.capMult[planetLevel(p) - 1]!;
}

/** Combat multiplier for a defending garrison (QUA-130): each defender is
 * worth this many attackers. Spec bonuses are offline while converting. */
export function defendMultiplier(p: Planet): number {
  if (p.convertTicks > 0) return 1;
  if (p.spec === "defence") return SPECS.defence.defendMult;
  if (p.spec === "naval") return SPECS.naval.defendMult;
  return 1;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Launch `floor(garrison * fraction)` ships from one planet toward another.
 * Sending 0 ships is a no-op, not an error; invalid planets, neutral sources,
 * and self-sends are silently ignored (stale UI input must never throw). */
export function sendFleet(
  state: GameState,
  fromPlanetId: number,
  toPlanetId: number,
  fraction: number
): void {
  const source = state.planets[fromPlanetId];
  const target = state.planets[toPlanetId];
  if (!source || !target || fromPlanetId === toPlanetId) return;
  if (source.owner === NEUTRAL) return;

  const n = Math.floor(source.garrison * fraction);
  if (n < 1) return;
  source.garrison -= n;

  state.fleets.push({
    id: state.nextFleetId++,
    owner: source.owner,
    ships: n,
    originId: fromPlanetId,
    destId: toPlanetId,
    progress: 0,
  });
}

/** Start a specialisation conversion (QUA-130): costs SPECS.costShips from
 * the garrison plus SPECS.convertTime seconds of downtime (no production, no
 * spec bonuses). Re-converting later — even mid-conversion — is allowed and
 * pays the full cost again. Invalid or unaffordable requests are silently
 * ignored (stale UI input must never throw). */
export function convertPlanet(state: GameState, cmd: ConvertCommand): void {
  const p = state.planets[cmd.planet];
  if (!p || p.owner !== cmd.owner) return;
  if (p.garrison < SPECS.costShips) return;
  if (cmd.to === p.spec && p.convertTicks === 0) return; // no-op re-convert
  p.garrison -= SPECS.costShips;
  p.nextSpec = cmd.to;
  p.convertTicks = Math.round(SPECS.convertTime * TICK_RATE);
}

/** Validate and apply a command from a commander (player or AI): every
 * referenced planet must actually belong to the command's owner. */
export function applyCommand(state: GameState, cmd: Command): void {
  if (state.phase !== "playing") return;
  if (cmd.type === "convert") {
    convertPlanet(state, cmd);
    return;
  }
  for (const fromId of cmd.from) {
    const source = state.planets[fromId];
    if (!source || source.owner !== cmd.owner) continue;
    sendFleet(state, fromId, cmd.to, cmd.fraction);
  }
}

/** Fleet arrival: ownership is evaluated at arrival time. Same owner
 * reinforces; otherwise each defender is worth defendMultiplier(planet)
 * attackers (QUA-130; ×1 reduces to a plain 1:1 trade) — the planet flips
 * when the attackers exceed the multiplied garrison, paying its full
 * multiplied price; a failed attack kills ships/mult defenders (exact tie:
 * defender holds at 0, owner unchanged). Capture resets development and
 * specialisation. */
function resolveArrival(planet: Planet, fleet: Fleet): void {
  if (planet.owner === fleet.owner) {
    planet.garrison += fleet.ships;
    return;
  }
  const mult = defendMultiplier(planet);
  if (fleet.ships > planet.garrison * mult) {
    planet.owner = fleet.owner;
    planet.garrison = fleet.ships - planet.garrison * mult;
    planet.heldTicks = 0; // development resets on capture (QUA-128)
    planet.spec = "standard"; // capture clears specialisation (QUA-130)
    planet.nextSpec = "standard";
    planet.convertTicks = 0;
  } else {
    planet.garrison -= fleet.ships / mult;
  }
}

/** Advance the simulation by one step of `dt` seconds. Spec step order
 * (QUA-119, extended by QUA-128/130) — do not reorder:
 *   1. production + development + conversion timers on owned planets
 *   2. advance fleet progress
 *   3. resolve arrivals, simultaneous arrivals in FLEET-ID order
 *   4. increment tick counter */
export function tick(state: GameState, dt: number): GameState {
  // Empire-wide economy bonus (QUA-130): count each owner's completed economy
  // planets once, before the production loop — converting ones don't count.
  const econCount: Partial<Record<Owner, number>> = {};
  for (const p of state.planets) {
    if (p.owner !== NEUTRAL && p.spec === "economy" && p.convertTicks === 0) {
      econCount[p.owner] = (econCount[p.owner] ?? 0) + 1;
    }
  }

  for (const p of state.planets) {
    if (p.owner === NEUTRAL) continue; // neutrals neither produce nor develop
    if (p.convertTicks > 0) {
      // Converting: no production, but development continues (QUA-130).
      p.convertTicks -= 1;
      if (p.convertTicks === 0) p.spec = p.nextSpec;
      p.heldTicks += 1;
      continue;
    }
    const cap = garrisonCap(p);
    if (p.garrison < cap) {
      const specMult =
        p.spec === "naval"
          ? SPECS.naval.productionMult
          : p.spec === "economy"
            ? SPECS.economy.productionMult
            : 1;
      const empireMult = 1 + SPECS.economy.empireBonus * (econCount[p.owner] ?? 0);
      const rate =
        PRODUCTION[p.size] * DEVELOPMENT.productionMult[planetLevel(p) - 1]! * specMult * empireMult;
      p.garrison = Math.min(cap, p.garrison + rate * dt);
    }
    // After production, so a level-up takes effect from the next tick.
    p.heldTicks += 1;
  }

  for (const f of state.fleets) {
    const origin = state.planets[f.originId]!;
    const target = state.planets[f.destId]!;
    const d = dist(origin.x, origin.y, target.x, target.y);
    f.progress += (SHIP_SPEED * dt) / d;
  }

  // Resolve in id order regardless of array order (ids are assigned in launch
  // order, so this is oldest-launch-first and stays deterministic even if the
  // fleets array is ever reordered). Never sort state.fleets itself — render
  // matches prev/curr fleets by id and relies on stable array order.
  const arrived = state.fleets.filter((f) => f.progress >= 1);
  if (arrived.length > 0) {
    arrived.sort((a, b) => a.id - b.id);
    for (const f of arrived) {
      resolveArrival(state.planets[f.destId]!, f);
    }
    state.fleets = state.fleets.filter((f) => f.progress < 1);
  }

  state.tick += 1;
  return state;
}

/** Game-loop wrapper around tick(): external commands, then any AI whose
 * decision tick has come due (QUA-123 — tier logic lives in ai.ts; controllers
 * return intents which are applied here), then one fixed-dt tick, then the
 * win check. The acceptance/unit tests call tick() directly and stay AI-free. */
export function update(state: GameState, commands: readonly Command[]): void {
  if (state.phase !== "playing") return;

  for (const cmd of commands) {
    applyCommand(state, cmd);
  }

  // Fixed array order = fixed rng draw order = reproducible games.
  for (const ai of state.ai) {
    if (state.tick < ai.nextDecisionTick) continue;
    for (const cmd of aiDecide(state, ai)) {
      applyCommand(state, cmd);
    }
    ai.nextDecisionTick = state.tick + nextDecisionDelay(state, ai.tier);
  }

  tick(state, TICK_DT);

  let playerAlive = false;
  let aiAlive = false;
  for (const p of state.planets) {
    if (p.owner === PLAYER) playerAlive = true;
    else if (p.owner !== NEUTRAL) aiAlive = true;
  }
  for (const f of state.fleets) {
    if (f.owner === PLAYER) playerAlive = true;
    else aiAlive = true;
  }
  if (!playerAlive) state.phase = "aiWon";
  else if (!aiAlive) state.phase = "playerWon";
}
