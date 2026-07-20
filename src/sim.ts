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
  INTERCEPT,
  SIZE_RADIUS,
  BATTLE,
} from "./config";
import { RngState, createRng, mixSeed, nextRange } from "./rng";
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
  /** Fractional interception damage accumulator (QUA-129): whole numbers are
   * decremented from `ships` as they accrue, the remainder carries. */
  damage: number;
}

/** One hostile faction's force in a battle. Ships are whole; `damage` is the
 * fractional casualty accumulator (same QUA-129 pattern as Fleet.damage). */
export interface BattlePool {
  owner: Owner;
  ships: number;
  damage: number;
}

/** An active fight at a planet: the garrison versus one or more hostile
 * pools. Only `attackers[0]` (earliest arrival) trades casualties with the
 * defender — later pools queue inert until the head pool dies or the planet
 * flips (pairwise resolution; simultaneous three-way is out of scope). At
 * most one battle exists per planet. Plain JSON data, like all of GameState. */
export interface Battle {
  planetId: number;
  /** Fractional defender casualties pending against the garrison. */
  defenderDamage: number;
  attackers: BattlePool[];
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
  /** Active battles, at most one per planet, in creation order. Iteration
   * order never affects outcomes: each battle only touches its own planet and
   * draws its rolls from a keyed RNG, not the shared stream. */
  battles: Battle[];
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

/** Per-ship strength multiplier for a garrison defending in a battle: the
 * structural defender bonus × development level × specialisation. The single
 * source of truth shared by the sim's combat step, the outcome predictor
 * (predict.ts) and the AI — they must never disagree. */
export function defenderStrengthMult(p: Planet): number {
  return (
    BATTLE.defenderBonus * DEVELOPMENT.defendMult[planetLevel(p) - 1]! * defendMultiplier(p)
  );
}

/** Interception zone radius in world units (QUA-129); 0 for neutrals. The
 * defence spec widens it (offline while converting). */
export function zoneRadius(p: Planet): number {
  if (p.owner === NEUTRAL) return 0;
  const specMult = p.spec === "defence" && p.convertTicks === 0 ? SPECS.defence.zoneRadiusMult : 1;
  return SIZE_RADIUS[p.size] * INTERCEPT.zoneRadiusFactor * specMult;
}

/** Ships/sec a zone strips from an enemy fleet inside it: 5% of the displayed
 * garrison count per second × level × defence-spec multiplier. Read live each
 * tick — a garrison being whittled down intercepts ever more weakly, and an
 * emptied one (garrison 0) inflicts nothing. */
export function zoneDps(p: Planet): number {
  if (p.owner === NEUTRAL) return 0;
  const specMult = p.spec === "defence" && p.convertTicks === 0 ? SPECS.defence.zoneDamageMult : 1;
  return (
    INTERCEPT.damageRate *
    Math.floor(p.garrison) *
    DEVELOPMENT.interceptMult[planetLevel(p) - 1]! *
    specMult
  );
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
    damage: 0,
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
 * reinforces the garrison (mid-battle too — that's the defender's
 * reinforcement path). A hostile arrival never resolves instantly: it joins
 * its faction's pool in the planet's battle, or opens a new battle (also vs
 * neutrals and empty garrisons — one uniform rule). Battles are fought over
 * the following ticks by stepBattles(). */
function resolveArrival(state: GameState, planet: Planet, fleet: Fleet): void {
  if (planet.owner === fleet.owner) {
    planet.garrison += fleet.ships;
    return;
  }
  const battle = state.battles.find((b) => b.planetId === planet.id);
  if (battle) {
    const pool = battle.attackers.find((a) => a.owner === fleet.owner);
    if (pool) pool.ships += fleet.ships;
    else battle.attackers.push({ owner: fleet.owner, ships: fleet.ships, damage: 0 });
    return;
  }
  state.battles.push({
    planetId: planet.id,
    defenderDamage: 0,
    attackers: [{ owner: fleet.owner, ships: fleet.ships, damage: 0 }],
  });
}

/** One combat round for every active battle. Per battle per tick, both sides
 * deal strength^exponent × rate × roll casualties/sec (config.BATTLE), where
 * the defender's per-ship strength is defenderStrengthMult(planet) and the
 * attacker fights unboosted. Rolls come from a throwaway RNG keyed by
 * (seed, tick, planetId) — never state.rng, so battle count can't shift the
 * shared stream, and a JSON snapshot resumes bit-identically. Fractional
 * casualties accrue in accumulators; only whole ships are removed (QUA-129
 * pattern). Casualties are computed from start-of-tick strengths and both
 * applied; the attacker is checked first, so mutual destruction leaves the
 * defender holding at 0 (the old exact-tie rule). A flip installs the head
 * pool's survivors as the new garrison — who immediately enjoy the defender
 * bonus against any queued pools — and resets development and specialisation
 * (QUA-128/130). */
function stepBattles(state: GameState, dt: number): void {
  if (state.battles.length === 0) return;
  for (const b of state.battles) {
    const p = state.planets[b.planetId]!;
    const pool = b.attackers[0]!;

    const r = createRng(mixSeed(mixSeed(state.seed, state.tick), b.planetId));
    const defRoll = nextRange(r, BATTLE.rollMin, BATTLE.rollMax); // defender first — fixed draw order
    const attRoll = nextRange(r, BATTLE.rollMin, BATTLE.rollMax);

    const defStr = Math.floor(p.garrison) * defenderStrengthMult(p);
    const attStr = pool.ships;
    pool.damage += Math.pow(defStr, BATTLE.exponent) * BATTLE.rate * dt * defRoll;
    b.defenderDamage += Math.pow(attStr, BATTLE.exponent) * BATTLE.rate * dt * attRoll;

    const poolWhole = Math.floor(pool.damage);
    if (poolWhole > 0) {
      pool.ships = Math.max(0, pool.ships - poolWhole);
      pool.damage -= poolWhole;
    }
    const defWhole = Math.floor(b.defenderDamage);
    if (defWhole > 0) {
      p.garrison = Math.max(0, p.garrison - defWhole);
      b.defenderDamage -= defWhole;
    }

    if (pool.ships <= 0) {
      // Head pool wiped; the next queued pool (if any) fights from next tick.
      b.attackers.shift();
    } else if (Math.floor(p.garrison) <= 0) {
      // Garrison wiped (a stranded sub-1 fraction can't fight): capture.
      p.owner = pool.owner;
      p.garrison = pool.ships; // may exceed the soft cap, like reinforcement
      p.heldTicks = 0; // development resets on capture (QUA-128)
      p.spec = "standard"; // capture clears specialisation (QUA-130)
      p.nextSpec = "standard";
      p.convertTicks = 0;
      b.attackers.shift();
      b.defenderDamage = 0; // the new defender starts a clean accumulator
    }
  }
  state.battles = state.battles.filter((b) => b.attackers.length > 0);
}

/** Advance the simulation by one step of `dt` seconds. Spec step order
 * (QUA-119, extended by QUA-128/129/130 and the battle rework) — do not
 * reorder:
 *   1. production + development + conversion timers on owned planets —
 *      skipped entirely at planets with an active battle (a siege freezes
 *      production, development and conversion)
 *   2. advance fleet progress
 *   3. interception attrition on in-transit fleets; destroyed fleets despawn
 *      (a besieged planet's zone still fires — it weakens as the garrison is
 *      ground down, since zoneDps reads the live count)
 *   4. resolve arrivals, simultaneous arrivals in FLEET-ID order — hostile
 *      arrivals join or open battles; reinforcements landing this tick fight
 *      from this tick
 *   5. battle combat round (stepBattles)
 *   6. increment tick counter */
export function tick(state: GameState, dt: number): GameState {
  const inBattle = new Set<number>();
  for (const b of state.battles) inBattle.add(b.planetId);

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
    if (inBattle.has(p.id)) continue; // sieges freeze production/dev/convert
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

  // Interception (QUA-129): every hostile zone containing the fleet fires at
  // once (overlaps stack). Fleets that reached progress 1 this tick are
  // exempt — they land and fight at full strength. Fractional damage accrues
  // per fleet; only whole ships are ever removed.
  let anyDestroyed = false;
  for (const f of state.fleets) {
    if (f.progress >= 1) continue;
    const origin = state.planets[f.originId]!;
    const target = state.planets[f.destId]!;
    const fx = origin.x + (target.x - origin.x) * f.progress;
    const fy = origin.y + (target.y - origin.y) * f.progress;
    let dps = 0;
    for (const p of state.planets) {
      if (p.owner === NEUTRAL || p.owner === f.owner) continue;
      if (dist(p.x, p.y, fx, fy) <= zoneRadius(p)) dps += zoneDps(p);
    }
    if (dps > 0) {
      f.damage += dps * dt;
      const whole = Math.floor(f.damage);
      if (whole > 0) {
        f.ships -= whole;
        f.damage -= whole;
        if (f.ships <= 0) anyDestroyed = true;
      }
    }
  }
  if (anyDestroyed) {
    // Ground to zero in transit: despawn without ever arriving.
    state.fleets = state.fleets.filter((f) => f.ships > 0);
  }

  // Resolve in id order regardless of array order (ids are assigned in launch
  // order, so this is oldest-launch-first and stays deterministic even if the
  // fleets array is ever reordered). Never sort state.fleets itself — render
  // matches prev/curr fleets by id and relies on stable array order.
  const arrived = state.fleets.filter((f) => f.progress >= 1);
  if (arrived.length > 0) {
    arrived.sort((a, b) => a.id - b.id);
    for (const f of arrived) {
      resolveArrival(state, state.planets[f.destId]!, f);
    }
    state.fleets = state.fleets.filter((f) => f.progress < 1);
  }

  stepBattles(state, dt);

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
  // A faction whose last force is a besieging pool is still alive.
  for (const b of state.battles) {
    for (const a of b.attackers) {
      if (a.owner === PLAYER) playerAlive = true;
      else aiAlive = true;
    }
  }
  if (!playerAlive) state.phase = "aiWon";
  else if (!aiAlive) state.phase = "playerWon";
}
