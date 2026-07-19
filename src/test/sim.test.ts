// QUA-119 simulation tests. Bundled by esbuild and run under plain node
// (npm run test:sim), which doubles as proof the sim is DOM-free. Throws on
// failure so node exits nonzero without needing process/@types/node.

import { TICK_DT, TICK_RATE, PRODUCTION, DEVELOPMENT, GARRISON_CAP, SPECS } from "../config";
import {
  Fleet,
  GameState,
  Planet,
  applyCommand,
  sendFleet,
  tick,
  planetLevel,
  garrisonCap,
} from "../sim";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`sim test FAILED: ${msg}`);
}

function closeTo(actual: number, expected: number, msg: string, eps = 1e-9): void {
  assert(Math.abs(actual - expected) <= eps, `${msg} (got ${actual}, want ${expected})`);
}

/** Hardcoded state for unit cases — no mapgen, no rng consumption. */
function mkState(planets: Planet[], fleets: Fleet[] = []): GameState {
  const maxFleetId = fleets.reduce((m, f) => Math.max(m, f.id), -1);
  return {
    tick: 0,
    seed: 0,
    rng: { s: 0 },
    planets,
    fleets,
    nextFleetId: maxFleetId + 1,
    phase: "playing",
    ai: [],
  };
}

function planet(id: number, opts: Partial<Planet>): Planet {
  return {
    id,
    x: 0,
    y: 0,
    size: "medium",
    owner: "neutral",
    garrison: 0,
    heldTicks: 0,
    spec: "standard",
    nextSpec: "standard",
    convertTicks: 0,
    ...opts,
  };
}

// 1. Production accrual: per-size rates; neutrals produce nothing.
{
  const s = mkState([
    planet(0, { owner: "player", size: "small" }),
    planet(1, { owner: "player", size: "medium", x: 200 }),
    planet(2, { owner: "ai1", size: "large", x: 400 }),
    planet(3, { owner: "neutral", size: "large", x: 600, garrison: 7 }),
  ]);
  tick(s, 1);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, 1.0, "small production over 2s");
  closeTo(s.planets[1]!.garrison, 2.0, "medium production over 2s");
  closeTo(s.planets[2]!.garrison, 3.0, "large production over 2s");
  closeTo(s.planets[3]!.garrison, 7, "neutral produced nothing");
  assert(s.tick === 2, "tick counter incremented once per tick() call");
}

// 1b. Development levels (QUA-128): heldTicks accrues for owned planets only;
// the level flips at exactly 90s/240s held; neutrals never develop.
{
  const L2_TICKS = DEVELOPMENT.levelTimes[1] * TICK_RATE;
  const L3_TICKS = DEVELOPMENT.levelTimes[2] * TICK_RATE;

  const s = mkState([
    planet(0, { owner: "player" }),
    planet(1, { owner: "neutral", garrison: 5, x: 300 }),
  ]);
  tick(s, TICK_DT);
  assert(s.planets[0]!.heldTicks === 1, "owned planet accrued a held tick");
  assert(s.planets[1]!.heldTicks === 0, "neutral planet accrued nothing");

  const p = planet(0, { owner: "player" });
  p.heldTicks = L2_TICKS - 1;
  assert(planetLevel(p) === 1, "one tick short of 90s is still L1");
  p.heldTicks = L2_TICKS;
  assert(planetLevel(p) === 2, "exactly 90s held reaches L2");
  p.heldTicks = L3_TICKS - 1;
  assert(planetLevel(p) === 2, "one tick short of 240s is still L2");
  p.heldTicks = L3_TICKS;
  assert(planetLevel(p) === 3, "exactly 240s held reaches L3");
  p.owner = "neutral";
  assert(planetLevel(p) === 1, "neutral is always L1 regardless of heldTicks");
}

// 1c. Development production multipliers: L2 produces ×1.5, L3 ×2.
{
  const l2 = planet(0, { owner: "player" });
  l2.heldTicks = DEVELOPMENT.levelTimes[1] * TICK_RATE;
  const l3 = planet(1, { owner: "player", x: 300 });
  l3.heldTicks = DEVELOPMENT.levelTimes[2] * TICK_RATE;
  const s = mkState([l2, l3]);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, PRODUCTION.medium * 1.5, "L2 production ×1.5");
  closeTo(s.planets[1]!.garrison, PRODUCTION.medium * 2, "L3 production ×2");
}

// 1d. Soft garrison cap: production halts at the cap (clamped exactly), but
// reinforcement pushes past it and is never clamped down; the cap itself
// scales with level.
{
  const s = mkState([planet(0, { owner: "player", garrison: GARRISON_CAP.medium - 0.5 })]);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, GARRISON_CAP.medium, "production clamps at the cap");
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, GARRISON_CAP.medium, "at-cap planet produces nothing");

  const capL2 = planet(0, { owner: "player", garrison: GARRISON_CAP.medium });
  capL2.heldTicks = DEVELOPMENT.levelTimes[1] * TICK_RATE;
  closeTo(garrisonCap(capL2), GARRISON_CAP.medium * 1.5, "L2 cap ×1.5");
  const s2 = mkState([capL2]);
  tick(s2, 1);
  closeTo(
    s2.planets[0]!.garrison,
    GARRISON_CAP.medium + PRODUCTION.medium * 1.5,
    "L2 planet produces past the L1 cap"
  );

  // Reinforcement exceeds the cap and stays there (soft cap, no clamping).
  const s3 = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 100, owner: "player", garrison: GARRISON_CAP.medium }),
    ],
    [{ id: 0, owner: "player", ships: 20, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s3, TICK_DT);
  closeTo(
    s3.planets[1]!.garrison,
    GARRISON_CAP.medium + 20,
    "reinforcement lands above the cap un-clamped"
  );
  tick(s3, TICK_DT);
  closeTo(s3.planets[1]!.garrison, GARRISON_CAP.medium + 20, "above-cap garrison stops producing");
}

// 1e. Capture resets development: the flipped planet drops to heldTicks 0/L1.
{
  const target = planet(1, { x: 100, owner: "ai1", garrison: 5 });
  target.heldTicks = DEVELOPMENT.levelTimes[2] * TICK_RATE; // an L3 planet
  const s = mkState(
    [planet(0, { owner: "player" }), target],
    [{ id: 0, owner: "player", ships: 8, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "player", "planet flipped");
  assert(s.planets[1]!.heldTicks === 0, "capture reset heldTicks");
  assert(planetLevel(s.planets[1]!) === 1, "captured L3 planet resets to L1");
}

// 1f. Specialisation conversion (QUA-130): pays 15 ships up front, runs 10s
// with no production, then the new spec applies; production resumes after.
{
  const s = mkState([planet(0, { owner: "player", garrison: 20 })]);
  applyCommand(s, { type: "convert", owner: "player", planet: 0, to: "defence" });
  const p = s.planets[0]!;
  closeTo(p.garrison, 20 - SPECS.costShips, "conversion cost deducted immediately");
  const total = Math.round(SPECS.convertTime * TICK_RATE);
  assert(p.convertTicks === total, "conversion timer started");
  assert(p.spec === "standard" && p.nextSpec === "defence", "old spec current until completion");

  for (let t = 0; t < total; t++) tick(s, TICK_DT);
  closeTo(p.garrison, 20 - SPECS.costShips, "no production during the 10s conversion");
  assert(p.spec === "defence" && p.convertTicks === 0, "spec applied when the timer ran out");
  tick(s, TICK_DT);
  closeTo(p.garrison, 20 - SPECS.costShips + PRODUCTION.medium * TICK_DT, "production resumed");
}

// 1g. Conversion refusals are silent no-ops: below cost, wrong owner, and
// re-converting to the current spec while idle.
{
  const s = mkState([
    planet(0, { owner: "player", garrison: 10 }),
    planet(1, { owner: "ai1", garrison: 20, x: 300 }),
    planet(2, { owner: "player", garrison: 20, x: 600 }),
  ]);
  applyCommand(s, { type: "convert", owner: "player", planet: 0, to: "naval" });
  assert(s.planets[0]!.convertTicks === 0, "below-cost convert refused");
  closeTo(s.planets[0]!.garrison, 10, "below-cost convert deducted nothing");
  applyCommand(s, { type: "convert", owner: "player", planet: 1, to: "naval" });
  assert(s.planets[1]!.convertTicks === 0, "wrong-owner convert refused");
  applyCommand(s, { type: "convert", owner: "player", planet: 2, to: "standard" });
  assert(s.planets[2]!.convertTicks === 0, "same-spec convert is a no-op");
  closeTo(s.planets[2]!.garrison, 20, "same-spec convert deducted nothing");
}

// 1h. Defence spec: garrison fights at ×2 — an attack that would flip a
// standard planet fails (killing ships/mult defenders), and a flip pays the
// full multiplied price. Capture clears the spec.
{
  const mk = (ships: number) =>
    mkState(
      [
        planet(0, { owner: "player" }),
        planet(1, { x: 100, owner: "ai1", garrison: 10, spec: "defence" }),
      ],
      [{ id: 0, owner: "player", ships, originId: 0, destId: 1, progress: 0.999 }]
    );

  const hold = mk(19); // 19 < (10 + prod)×2 — would flip a standard planet
  tick(hold, TICK_DT);
  assert(hold.planets[1]!.owner === "ai1", "defence spec held off 19 attackers");
  closeTo(
    hold.planets[1]!.garrison,
    10 + PRODUCTION.medium * TICK_DT - 19 / 2,
    "failed attack kills ships/defendMult defenders"
  );

  const flip = mk(21); // 21 > (10 + prod)×2
  tick(flip, TICK_DT);
  assert(flip.planets[1]!.owner === "player", "overwhelming force flips a defence planet");
  closeTo(
    flip.planets[1]!.garrison,
    21 - (10 + PRODUCTION.medium * TICK_DT) * 2,
    "flip pays garrison × defendMult"
  );
  assert(flip.planets[1]!.spec === "standard", "capture clears specialisation");
}

// 1i. Naval spec: ×1.5 production, but defends at ×0.75 (glass shipyard).
{
  const s = mkState([planet(0, { owner: "player", spec: "naval" })]);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, PRODUCTION.medium * 1.5, "naval production ×1.5");

  const s2 = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 100, owner: "ai1", garrison: 10, spec: "naval" }),
    ],
    [{ id: 0, owner: "player", ships: 9, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s2, TICK_DT);
  assert(s2.planets[1]!.owner === "player", "glass shipyard fell below its raw garrison");
  closeTo(
    s2.planets[1]!.garrison,
    9 - (10 + PRODUCTION.medium * 1.5 * TICK_DT) * 0.75,
    "naval flip pays garrison × 0.75"
  );
}

// 1j. Economy spec: own production ×0.5, +15% empire-wide per economy planet
// (additive), enemies unaffected, converting economy planets don't count.
{
  const s = mkState([
    planet(0, { owner: "player", spec: "economy" }),
    planet(1, { owner: "player", x: 300 }),
    planet(2, { owner: "ai1", x: 600 }),
  ]);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, PRODUCTION.medium * 0.5 * 1.15, "economy own production ×0.5×1.15");
  closeTo(s.planets[1]!.garrison, PRODUCTION.medium * 1.15, "friendly planet gets +15%");
  closeTo(s.planets[2]!.garrison, PRODUCTION.medium, "enemy production unaffected");

  const s2 = mkState([
    planet(0, { owner: "player", spec: "economy" }),
    planet(1, { owner: "player", spec: "economy", x: 300 }),
    planet(2, { owner: "player", x: 600 }),
    planet(3, { owner: "player", spec: "economy", nextSpec: "standard", convertTicks: 60, x: 900 }),
  ]);
  tick(s2, 1);
  closeTo(s2.planets[2]!.garrison, PRODUCTION.medium * 1.3, "two economy planets stack to +30%");
}

// 1k. A converting planet defends without spec bonuses, and capture
// mid-conversion resets spec, pending spec, and timer.
{
  const target = planet(1, { x: 100, owner: "ai1", garrison: 10, spec: "defence" });
  target.nextSpec = "economy";
  target.convertTicks = 300;
  const s = mkState(
    [planet(0, { owner: "player" }), target],
    [{ id: 0, owner: "player", ships: 12, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "player", "converting defence planet fell at ×1");
  closeTo(s.planets[1]!.garrison, 2, "no production while converting; 1:1 trade");
  const q = s.planets[1]!;
  assert(q.spec === "standard" && q.nextSpec === "standard" && q.convertTicks === 0,
    "capture mid-conversion reset everything");
}

// 2. Fleet travel timing: full screen width (1000u) in 5s = 300 ticks at 60Hz.
// ±1-tick tolerance — never assert exact float boundaries.
{
  const s = mkState(
    [planet(0, { owner: "player", x: 0, y: 800 }), planet(1, { x: 1000, y: 800, garrison: 99 })],
    [{ id: 0, owner: "player", ships: 1, originId: 0, destId: 1, progress: 0 }]
  );
  for (let t = 0; t < 298; t++) tick(s, TICK_DT);
  assert(s.fleets.length === 1, "fleet still in flight at tick 298");
  for (let t = 0; t < 4; t++) tick(s, TICK_DT);
  assert(s.fleets.length === 0, "fleet arrived by tick 302 (nominal 300 = 5.0s)");
}

// 3. Capture flip: arriving ships > garrison flips with the surplus.
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, garrison: 5 })],
    [{ id: 0, owner: "player", ships: 8, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "player", "planet flipped to attacker");
  closeTo(s.planets[1]!.garrison, 3, "surplus became the new garrison");
  assert(s.fleets.length === 0, "arrived fleet removed");
}

// 4. Failed attack: fewer ships reduce the garrison, ownership unchanged.
// Defender produces during the arrival tick (production is step 1, arrivals
// step 3), so the expected value includes one tick of medium production.
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 10 })],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "ai1", "failed attack did not flip ownership");
  closeTo(
    s.planets[1]!.garrison,
    10 + PRODUCTION.medium * TICK_DT - 6,
    "garrison reduced 1:1 after production"
  );
}

// 4b. Exact tie: defender holds at 0, ownership unchanged (neutral defender
// so no production muddies the equality).
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, garrison: 10 })],
    [{ id: 0, owner: "player", ships: 10, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "neutral", "tie keeps defender ownership");
  closeTo(s.planets[1]!.garrison, 0, "tie leaves garrison at 0");
}

// 5. Reinforcement: friendly arrival adds to the garrison.
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "player", garrison: 4 })],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.999 }]
  );
  tick(s, TICK_DT);
  assert(s.planets[1]!.owner === "player", "reinforced planet keeps owner");
  closeTo(
    s.planets[1]!.garrison,
    4 + PRODUCTION.medium * TICK_DT + 6,
    "reinforcement added after production"
  );
}

// 6. Simultaneous arrivals resolve in FLEET-ID order, not array order. The
// fleets array is built in REVERSE id order; id order gives: player-6 flips
// neutral-5 (garrison 1), then ai1-3 flips player-1 (final ai1, garrison 2).
// Array-mutation order would end neutral/player instead — this pins the rule.
{
  const s = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 200, owner: "ai1" }),
      planet(2, { x: 100, garrison: 5 }),
    ],
    [
      { id: 5, owner: "ai1", ships: 3, originId: 1, destId: 2, progress: 0.999 },
      { id: 2, owner: "player", ships: 6, originId: 0, destId: 2, progress: 0.999 },
    ]
  );
  tick(s, TICK_DT);
  assert(s.planets[2]!.owner === "ai1", "id-order resolution: ai1 lands last and flips");
  closeTo(s.planets[2]!.garrison, 2, "id-order resolution leaves garrison 2");
}

// 7. Serialization round-trip: JSON clone mid-flight must not change the
// future — lossless plain data.
{
  const a = mkState(
    [
      planet(0, { owner: "player", garrison: 12 }),
      planet(1, { x: 700, y: 500, owner: "ai1", garrison: 9, size: "large" }),
      planet(2, { x: 300, y: 900, garrison: 6, size: "small" }),
    ],
    [{ id: 0, owner: "ai1", ships: 4, originId: 1, destId: 2, progress: 0.2 }]
  );
  for (let t = 0; t < 10; t++) tick(a, TICK_DT);
  const b = JSON.parse(JSON.stringify(a)) as GameState;
  assert(JSON.stringify(a) === JSON.stringify(b), "JSON round-trip is lossless");
  for (let t = 0; t < 100; t++) {
    tick(a, TICK_DT);
    tick(b, TICK_DT);
  }
  assert(JSON.stringify(a) === JSON.stringify(b), "clone stays identical 100 ticks later");
}

// 8. sendFleet semantics.
{
  const s = mkState([
    planet(0, { owner: "player", garrison: 7 }),
    planet(1, { x: 500, garrison: 5 }),
  ]);
  sendFleet(s, 0, 1, 0.5);
  assert(s.fleets.length === 1, "send created a fleet");
  assert(s.fleets[0]!.ships === 3, "ship count floors (7 * 0.5 -> 3)");
  closeTo(s.planets[0]!.garrison, 4, "garrison deducted");

  const idBefore = s.nextFleetId;
  s.planets[0]!.garrison = 1;
  sendFleet(s, 0, 1, 0.5); // floor(0.5) = 0 -> no-op, not an error
  assert(s.fleets.length === 1, "0-ship send creates no fleet");
  assert(s.nextFleetId === idBefore, "0-ship send consumes no fleet id");
  closeTo(s.planets[0]!.garrison, 1, "0-ship send deducts nothing");

  sendFleet(s, 1, 0, 1); // neutral source
  sendFleet(s, 99, 0, 1); // missing source
  sendFleet(s, 0, 0, 1); // self-send
  assert(s.fleets.length === 1, "neutral/missing/self sends are no-ops");
}

// ---------------------------------------------------------------------------
// Acceptance scenario (QUA-119 "done when"): 3 planets, 2 owners, 1 fleet in
// transit; tick 100 times; production accumulates, the fleet arrives, the
// planet captures, and a new fleet spawns — all per spec numbers.
//
// Arithmetic: d(P0,P1)=600 -> 1/180 progress/tick; 0.51 + 89/180 >= 1 so the
// fleet arrives during tick 89. P1 (ai1, large) holds 3 + 89*0.025 = 5.225 at
// arrival; 6 > 5.225 flips it to player with 0.775, then 11 more large ticks
// -> 1.05. P0 (medium): 10 + 100/60 = 11.666. P2 (neutral): untouched 5.
// ---------------------------------------------------------------------------
{
  const s = mkState(
    [
      planet(0, { x: 200, y: 800, owner: "player", size: "medium", garrison: 10 }),
      planet(1, { x: 800, y: 800, owner: "ai1", size: "large", garrison: 3 }),
      planet(2, { x: 500, y: 400, owner: "neutral", size: "small", garrison: 5 }),
    ],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.51 }]
  );

  for (let t = 0; t < 100; t++) tick(s, TICK_DT);

  assert(s.tick === 100, "ran exactly 100 ticks");
  assert(s.fleets.length === 0, "fleet in transit arrived");
  closeTo(s.planets[0]!.garrison, 10 + 100 / 60, "P0 production accumulated");
  assert(Math.floor(s.planets[0]!.garrison) === 11, "P0 displays 11");
  assert(s.planets[1]!.owner === "player", "P1 captured by the arriving fleet");
  closeTo(s.planets[1]!.garrison, 6 - (3 + 89 * 0.025) + 11 * 0.025, "P1 surplus + production");
  assert(Math.floor(s.planets[1]!.garrison) === 1, "P1 displays 1");
  closeTo(s.planets[2]!.garrison, 5, "neutral P2 untouched");

  // New fleet spawns correctly per spec numbers.
  sendFleet(s, 0, 2, 0.5);
  assert(s.fleets.length === 1, "new fleet spawned");
  const f = s.fleets[0]!;
  assert(f.id === 1 && f.owner === "player" && f.originId === 0 && f.destId === 2, "fleet fields");
  assert(f.ships === 5, "floor(11.666 * 0.5) = 5 ships");
  closeTo(s.planets[0]!.garrison, 10 + 100 / 60 - 5, "P0 garrison after send");
  tick(s, TICK_DT); // d(P0,P2) = 500 -> progress 200/60/500 = 1/150
  closeTo(s.fleets[0]!.progress, 1 / 150, "fleet progress after one tick");
}

console.log("sim tests OK (production, travel, capture, tie, reinforce, id-order, JSON, sendFleet, acceptance)");
