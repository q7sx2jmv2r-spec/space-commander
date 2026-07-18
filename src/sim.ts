// Deterministic game simulation. This module must stay DOM-free (it runs
// under plain node in the determinism test) and must never touch Math.random —
// all randomness flows through the RngState inside GameState, and draw order
// is part of the determinism contract.

import { RngState, createRng, nextFloat } from "./rng";
import { generatePlanets } from "./mapgen";

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** Logical world size (portrait). Rendering scales this to fit the screen;
 * screen size never affects simulation results. */
export const WORLD_W = 1000;
export const WORLD_H = 1600;

export const NEUTRAL = 0;
export const PLAYER = 1;
export const AI = 2;
export type Owner = 0 | 1 | 2;

// Balance constants — first-guess numbers, tune after playtesting.
export const FLEET_SPEED = 180; // world units/sec
export const PROD_DIVISOR = 20; // owned planet produces r/PROD_DIVISOR ships/sec
export const SEND_FRACTION = 0.5;
export const AI_PERIOD = 120; // ticks between AI decisions (2s)
export const AI_MIN_GARRISON = 20;

export interface Planet {
  id: number; // index in planets[]; stable for the whole game
  x: number;
  y: number;
  r: number;
  owner: Owner;
  ships: number; // fractional accumulator; use Math.floor for display/sending
}

export interface Fleet {
  id: number;
  owner: Owner; // PLAYER or AI only
  ships: number; // integer
  x: number;
  y: number;
  targetId: number;
}

export interface SendCommand {
  type: "send";
  owner: Owner;
  from: number[]; // source planet ids, sorted ascending
  to: number;
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

export function createGame(seed: number): GameState {
  const rng = createRng(seed);
  return {
    tick: 0,
    seed: seed >>> 0,
    rng,
    planets: generatePlanets(rng),
    fleets: [],
    nextFleetId: 0,
    phase: "playing",
  };
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Validate and apply a send command. Invalid commands and invalid source
 * entries are silently dropped — stale UI input must never throw. */
export function applyCommand(state: GameState, cmd: Command): void {
  if (state.phase !== "playing") return;
  const target = state.planets[cmd.to];
  if (!target) return;

  for (const fromId of cmd.from) {
    const source = state.planets[fromId];
    if (!source || source.owner !== cmd.owner || fromId === cmd.to) continue;
    const n = Math.floor(source.ships * SEND_FRACTION);
    if (n < 1) continue;
    source.ships -= n;

    const d = dist(source.x, source.y, target.x, target.y);
    const ux = (target.x - source.x) / d;
    const uy = (target.y - source.y) / d;
    state.fleets.push({
      id: state.nextFleetId++,
      owner: cmd.owner,
      ships: n,
      x: source.x + ux * source.r,
      y: source.y + uy * source.r,
      targetId: cmd.to,
    });
  }
}

/** AI decision: pure function of state + state.rng, so replays stay exact.
 * From its strongest planet, attack the cheapest-and-closest non-AI planet,
 * occasionally (25%) the second-best to be less mechanical. */
function runAI(state: GameState): void {
  let source: Planet | null = null;
  for (const p of state.planets) {
    if (p.owner === AI && (source === null || p.ships > source.ships)) {
      source = p;
    }
  }
  if (!source || Math.floor(source.ships) < AI_MIN_GARRISON) return;
  const src = source;

  const candidates = state.planets
    .filter((p) => p.owner !== AI)
    .map((p) => ({ id: p.id, score: p.ships + dist(src.x, src.y, p.x, p.y) / 50 }))
    .sort((a, b) => a.score - b.score || a.id - b.id);
  if (candidates.length === 0) return;

  let pick = candidates[0]!;
  if (candidates.length > 1 && nextFloat(state.rng) < 0.25) {
    pick = candidates[1]!;
  }
  applyCommand(state, { type: "send", owner: AI, from: [src.id], to: pick.id });
}

/** Fleet arrival: ownership is evaluated at arrival time. Same owner
 * reinforces; otherwise attackers trade 1:1 with the garrison and the planet
 * flips if they exceed it (exact tie: defender holds at 0). */
function resolveArrival(planet: Planet, fleet: Fleet): void {
  if (planet.owner === fleet.owner) {
    planet.ships += fleet.ships;
  } else if (fleet.ships > planet.ships) {
    planet.owner = fleet.owner;
    planet.ships = fleet.ships - planet.ships;
  } else {
    planet.ships -= fleet.ships;
  }
}

/** Advance the simulation by exactly one fixed tick. `commands` are external
 * (player) commands for this tick, applied in array order. Processing order
 * within a tick is fixed: commands, AI, production, fleet movement/arrivals,
 * win check — do not reorder. */
export function update(state: GameState, commands: readonly Command[]): void {
  if (state.phase !== "playing") return;
  state.tick += 1;

  for (const cmd of commands) {
    applyCommand(state, cmd);
  }

  if (state.tick % AI_PERIOD === 0) {
    runAI(state);
  }

  for (const p of state.planets) {
    if (p.owner !== NEUTRAL) {
      p.ships += (p.r / PROD_DIVISOR) * TICK_DT;
    }
  }

  let anyArrived = false;
  const step = FLEET_SPEED * TICK_DT;
  for (const f of state.fleets) {
    const target = state.planets[f.targetId]!;
    const d = dist(f.x, f.y, target.x, target.y);
    if (d <= target.r + step) {
      resolveArrival(target, f);
      f.targetId = -1; // mark arrived
      anyArrived = true;
    } else {
      f.x += ((target.x - f.x) / d) * step;
      f.y += ((target.y - f.y) / d) * step;
    }
  }
  if (anyArrived) {
    state.fleets = state.fleets.filter((f) => f.targetId !== -1);
  }

  let playerAlive = false;
  let aiAlive = false;
  for (const p of state.planets) {
    if (p.owner === PLAYER) playerAlive = true;
    else if (p.owner === AI) aiAlive = true;
  }
  for (const f of state.fleets) {
    if (f.owner === PLAYER) playerAlive = true;
    else aiAlive = true;
  }
  if (!playerAlive) state.phase = "aiWon";
  else if (!aiAlive) state.phase = "playerWon";
}
