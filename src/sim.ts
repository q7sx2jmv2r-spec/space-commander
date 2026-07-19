// Deterministic game simulation (QUA-119). This module must stay DOM-free
// (it runs under plain node in the test suite) and must never touch
// Math.random or Date.now — all randomness flows through the RngState inside
// GameState, and draw order is part of the determinism contract.

import {
  Owner,
  Size,
  TICK_DT,
  PRODUCTION,
  SHIP_SPEED,
  SEND_FRACTION,
  AI_PERIOD,
  AI_MIN_GARRISON,
  AI_DIST_DIVISOR,
} from "./config";
import { RngState, nextFloat } from "./rng";
import { generateMap } from "./mapgen";

export type { Owner, Size };
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
}

/** Standard skirmish start. Map generation (seeding, layout, fairness) lives
 * in mapgen.ts; this is a thin wrapper so callers get a 2-faction game from a
 * seed. Use generateMap directly for other faction counts. */
export function createGame(seed: number): GameState {
  return generateMap(seed, 2);
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
  } else {
    planet.garrison -= fleet.ships;
  }
}

/** Advance the simulation by one step of `dt` seconds. Spec step order
 * (QUA-119) — do not reorder:
 *   1. production on owned planets
 *   2. advance fleet progress
 *   3. resolve arrivals, simultaneous arrivals in FLEET-ID order
 *   4. increment tick counter */
export function tick(state: GameState, dt: number): GameState {
  for (const p of state.planets) {
    if (p.owner !== NEUTRAL) {
      p.garrison += PRODUCTION[p.size] * dt;
    }
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

/** AI decision: pure function of state + state.rng, so replays stay exact.
 * From its strongest planet, attack the cheapest-and-closest non-AI planet,
 * occasionally (25%) the second-best to be less mechanical. QUA-123 replaces
 * this with configurable difficulty tiers. */
function runAI(state: GameState): void {
  let source: Planet | null = null;
  for (const p of state.planets) {
    if (p.owner === AI1 && (source === null || p.garrison > source.garrison)) {
      source = p;
    }
  }
  if (!source || Math.floor(source.garrison) < AI_MIN_GARRISON) return;
  const src = source;

  const candidates = state.planets
    .filter((p) => p.owner !== AI1)
    .map((p) => ({
      id: p.id,
      score: p.garrison + dist(src.x, src.y, p.x, p.y) / AI_DIST_DIVISOR,
    }))
    .sort((a, b) => a.score - b.score || a.id - b.id);
  if (candidates.length === 0) return;

  let pick = candidates[0]!;
  if (candidates.length > 1 && nextFloat(state.rng) < 0.25) {
    pick = candidates[1]!;
  }
  applyCommand(state, { type: "send", owner: AI1, from: [src.id], to: pick.id, fraction: SEND_FRACTION });
}

/** Game-loop wrapper around tick(): external commands, then AI, then one
 * fixed-dt tick, then the win check. The acceptance/unit tests call tick()
 * directly and stay AI-free. */
export function update(state: GameState, commands: readonly Command[]): void {
  if (state.phase !== "playing") return;

  for (const cmd of commands) {
    applyCommand(state, cmd);
  }

  // tick > 0 guard: the counter increments at the END of tick() per spec, so
  // without it the AI would act on the very first update.
  if (state.tick > 0 && state.tick % AI_PERIOD === 0) {
    runAI(state);
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
