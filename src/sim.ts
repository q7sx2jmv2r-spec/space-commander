// Deterministic game simulation (QUA-119). This module must stay DOM-free
// (it runs under plain node in the test suite) and must never touch
// Math.random or Date.now — all randomness flows through the RngState inside
// GameState, and draw order is part of the determinism contract.

import {
  Owner,
  Size,
  TICK_DT,
  TICK_RATE,
  PRODUCTION,
  SHIP_SPEED,
  DEVELOPMENT,
  GARRISON_CAP,
} from "./config";
import { RngState } from "./rng";
import { generateMap } from "./mapgen";
import { AiState, aiDecide, nextDecisionDelay } from "./ai";

export type { Owner, Size };
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
  /** Fraction of each source garrison to send (0..1]. UI sends 0.5 on tap,
   * 1.0 on double-tap. */
  fraction: number;
}
export type Command = SendCommand;

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

/** Validate and apply a send command from a commander (player or AI): each
 * listed source must actually belong to the command's owner. */
export function applyCommand(state: GameState, cmd: Command): void {
  if (state.phase !== "playing") return;
  for (const fromId of cmd.from) {
    const source = state.planets[fromId];
    if (!source || source.owner !== cmd.owner) continue;
    sendFleet(state, fromId, cmd.to, cmd.fraction);
  }
}

/** Fleet arrival: ownership is evaluated at arrival time. Same owner
 * reinforces; otherwise attackers trade 1:1 with the garrison and the planet
 * flips if they exceed it (exact tie: defender holds at 0, owner unchanged). */
function resolveArrival(planet: Planet, fleet: Fleet): void {
  if (planet.owner === fleet.owner) {
    planet.garrison += fleet.ships;
  } else if (fleet.ships > planet.garrison) {
    planet.owner = fleet.owner;
    planet.garrison = fleet.ships - planet.garrison;
    planet.heldTicks = 0; // development resets on capture (QUA-128)
  } else {
    planet.garrison -= fleet.ships;
  }
}

/** Advance the simulation by one step of `dt` seconds. Spec step order
 * (QUA-119, extended by QUA-128) — do not reorder:
 *   1. production + development on owned planets
 *   2. advance fleet progress
 *   3. resolve arrivals, simultaneous arrivals in FLEET-ID order
 *   4. increment tick counter */
export function tick(state: GameState, dt: number): GameState {
  for (const p of state.planets) {
    if (p.owner === NEUTRAL) continue; // neutrals neither produce nor develop
    const cap = garrisonCap(p);
    if (p.garrison < cap) {
      const rate = PRODUCTION[p.size] * DEVELOPMENT.productionMult[planetLevel(p) - 1]!;
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
