// QUA-119 simulation tests. Bundled by esbuild and run under plain node
// (npm run test:sim), which doubles as proof the sim is DOM-free. Throws on
// failure so node exits nonzero without needing process/@types/node.

import {
  TICK_DT,
  TICK_RATE,
  PRODUCTION,
  DEVELOPMENT,
  GARRISON_CAP,
  SPECS,
  INTERCEPT,
  SIZE_RADIUS,
  SHIP_SPEED,
} from "../config";
import {
  Fleet,
  GameState,
  Planet,
  applyCommand,
  sendFleet,
  tick,
  update,
  planetLevel,
  garrisonCap,
  defenderStrengthMult,
} from "../sim";
import { predictBattle, predictRoute } from "../predict";

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
    battles: [],
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

/** Tick until every battle has resolved (combat is no longer instant): lands
 * any due arrivals, then grinds the fight to completion. Returns ticks run. */
function fight(s: GameState, max = 2000): number {
  let t = 0;
  do {
    tick(s, TICK_DT);
    t += 1;
  } while (s.battles.length > 0 && t < max);
  assert(t < max, `battle failed to terminate within ${max} ticks`);
  return t;
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
    [{ id: 0, owner: "player", ships: 20, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
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
// (L3 also defends at ×1.5 via DEVELOPMENT.defendMult, so the assault must be
// decisive: 20 v 5 effective 5×1.2×1.5 = 9.)
{
  const target = planet(1, { x: 100, owner: "ai1", garrison: 5 });
  target.heldTicks = DEVELOPMENT.levelTimes[2] * TICK_RATE; // an L3 planet
  const s = mkState(
    [planet(0, { owner: "player" }), target],
    [{ id: 0, owner: "player", ships: 20, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  fight(s);
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

// 1h. Defence spec: the garrison's battle strength doubles (×1.2 bonus × 2
// spec = 2.4/ship). Strength multiplies damage OUTPUT, not hit points, so the
// force a garrison of G at multiplier m repels scales as G × m^(1.2/2.2):
// standard 10 falls to ~11+, defence 10 repels up to ~16. A force that cracks
// the standard planet bounces off the defence one; only overwhelming force
// flips it. Capture clears the spec.
{
  const mk = (ships: number, spec: "standard" | "defence") =>
    mkState(
      [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 10, spec })],
      [{ id: 0, owner: "player", ships, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
    );

  const std = mk(14, "standard"); // 14 > ~11: cracks it
  fight(std);
  assert(std.planets[1]!.owner === "player", "14 attackers flip a standard planet");

  const hold = mk(14, "defence"); // 14 < ~16: repelled
  fight(hold);
  assert(hold.planets[1]!.owner === "ai1", "defence spec held off 14 attackers");
  assert(hold.planets[1]!.garrison > 0, "the defenders survive the failed attack");

  const flip = mk(45, "defence");
  fight(flip);
  assert(flip.planets[1]!.owner === "player", "overwhelming force flips a defence planet");
  assert(flip.planets[1]!.garrison > 0, "capture leaves surviving attackers as garrison");
  assert(flip.planets[1]!.spec === "standard", "capture clears specialisation");
}

// 1i. Naval spec: ×1.5 production, but defends at ×0.75 (glass shipyard).
{
  const s = mkState([planet(0, { owner: "player", spec: "naval" })]);
  tick(s, 1);
  closeTo(s.planets[0]!.garrison, PRODUCTION.medium * 1.5, "naval production ×1.5");

  // Glass jaw: naval defends at ×0.9/ship (1.2 × 0.75) vs ×1.2 standard —
  // the repel threshold drops below the raw garrison. The same 10-ship force
  // that loses to a standard garrison of 10 cracks the shipyard.
  const mkAttack = (spec: "standard" | "naval") =>
    mkState(
      [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 10, spec })],
      [{ id: 0, owner: "player", ships: 10, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
    );
  const vsStandard = mkAttack("standard");
  fight(vsStandard);
  assert(vsStandard.planets[1]!.owner === "ai1", "10 attackers lose to a standard garrison of 10");
  const vsNaval = mkAttack("naval");
  fight(vsNaval);
  assert(vsNaval.planets[1]!.owner === "player", "glass shipyard fell to the same force");
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

// 1k. A converting planet defends without spec bonuses (battle strength drops
// to garrison × 1.2 × level), and capture mid-conversion resets spec, pending
// spec, and timer. The same force loses to the spec once it's active.
{
  const mk = (convertTicks: number) => {
    const target = planet(1, { x: 100, owner: "ai1", garrison: 10, spec: "defence" });
    target.nextSpec = "economy";
    target.convertTicks = convertTicks;
    return mkState(
      [planet(0, { owner: "player" }), target],
      [{ id: 0, owner: "player", ships: 15, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
    );
  };
  const converting = mk(600); // long enough that the timer outlasts the fight
  fight(converting);
  const q = converting.planets[1]!;
  assert(q.owner === "player", "converting defence planet fell without its ×2");
  assert(q.spec === "standard" && q.nextSpec === "standard" && q.convertTicks === 0,
    "capture mid-conversion reset everything");

  const active = mk(0); // spec online: repel threshold rises to ~16 > 15
  fight(active);
  assert(active.planets[1]!.owner === "ai1", "the same force loses once the spec is active");
}

// 1l. Interception (QUA-129), exact chord case: a fleet crossing a hostile
// zone loses zoneDps × dt per tick, whole ships only, remainder carried.
// The zone planet sits at its garrison cap so its dps is constant (no
// production) and every number is exact.
//
// Layout: player planets at x=0 and x=1000 (y=800), ai1 medium at (500,800),
// garrison 50 (= cap). Zone radius 44×2.5 = 110 → x ∈ [390,610]. The fleet's
// post-move position is x = k·10/3 at tick k (300-tick flight): nominally
// k ∈ [117,183], but the k=117 entry lands exactly on the zone edge and float
// accumulation of progress puts it a hair outside — 66 in-zone ticks at
// dps 0.05×50 = 2.5.
{
  const zoneTicks = 66;
  const dps = INTERCEPT.damageRate * GARRISON_CAP.medium;
  const mkRun = (ships: number, garrison: number, convertTicks = 0) => {
    const zone = planet(2, { x: 500, y: 800, owner: "ai1", garrison });
    if (convertTicks > 0) {
      zone.convertTicks = convertTicks;
      zone.nextSpec = "standard";
    }
    return mkState(
      [
        planet(0, { x: 0, y: 800, owner: "player" }),
        planet(1, { x: 1000, y: 800, owner: "player" }),
        zone,
      ],
      [{ id: 0, owner: "player", ships, originId: 0, destId: 1, progress: 0, damage: 0 }]
    );
  };

  const s = mkRun(30, GARRISON_CAP.medium);
  for (let t = 0; t < 250; t++) tick(s, TICK_DT);
  assert(s.fleets.length === 1, "fleet still in flight past the zone");
  assert(s.fleets[0]!.ships === 28, "30-ship fleet lost 2 whole ships crossing the zone");
  closeTo(
    s.fleets[0]!.damage,
    zoneTicks * dps * TICK_DT - 2,
    "fractional attrition remainder carried",
    1e-6
  );

  // Weak garrison inflicts only minor losses (kept constant via a conversion
  // freeze so the arithmetic stays exact); garrison 0 inflicts nothing.
  const weak = mkRun(30, 5, 600);
  for (let t = 0; t < 250; t++) tick(weak, TICK_DT);
  assert(weak.fleets[0]!.ships === 30, "garrison-5 zone stripped no whole ship");
  closeTo(
    weak.fleets[0]!.damage,
    zoneTicks * INTERCEPT.damageRate * 5 * TICK_DT,
    "garrison-5 zone accrued only minor damage",
    1e-6
  );

  const empty = mkRun(30, 0, 600);
  for (let t = 0; t < 250; t++) tick(empty, TICK_DT);
  assert(empty.fleets[0]!.ships === 30 && empty.fleets[0]!.damage === 0,
    "garrison-0 zone inflicts nothing");
}

// 1m. Overlapping zones stack; a fleet ground to zero despawns in transit and
// never resolves an arrival; own zones never fire on friendly fleets.
{
  const s = mkState(
    [
      planet(0, { x: 0, y: 800, owner: "player" }),
      planet(1, { x: 1000, y: 800, owner: "player" }),
      planet(2, { x: 450, y: 800, owner: "ai1", garrison: GARRISON_CAP.medium }),
      planet(3, { x: 550, y: 800, owner: "ai1", garrison: GARRISON_CAP.medium }),
    ],
    [{ id: 0, owner: "player", ships: 30, originId: 0, destId: 1, progress: 0, damage: 0 }]
  );
  // Zones cover x ∈ [340,560] and [440,660] → 133 in-zone ticks in total
  // (edge ticks land in or out by float accumulation, as above).
  for (let t = 0; t < 250; t++) tick(s, TICK_DT);
  const dps = INTERCEPT.damageRate * GARRISON_CAP.medium;
  assert(s.fleets[0]!.ships === 25, "stacked zones cost 5 whole ships");
  closeTo(s.fleets[0]!.damage, 133 * dps * TICK_DT - 5, "stacked remainder carried", 1e-6);

  const doomed = mkState(
    [
      planet(0, { x: 0, y: 800, owner: "player" }),
      planet(1, { x: 1000, y: 800, owner: "neutral", garrison: 1 }),
      planet(2, { x: 500, y: 800, owner: "ai1", garrison: GARRISON_CAP.medium }),
    ],
    [{ id: 0, owner: "player", ships: 2, originId: 0, destId: 1, progress: 0, damage: 0 }]
  );
  for (let t = 0; t < 320; t++) tick(doomed, TICK_DT);
  assert(doomed.fleets.length === 0, "2-ship fleet was ground to zero in transit");
  assert(doomed.planets[1]!.owner === "neutral", "despawned fleet never arrived");
  closeTo(doomed.planets[1]!.garrison, 1, "despawned fleet touched nothing");

  const friendly = mkState(
    [
      planet(0, { x: 0, y: 800, owner: "player" }),
      planet(1, { x: 1000, y: 800, owner: "player" }),
      planet(2, { x: 500, y: 800, owner: "player", garrison: GARRISON_CAP.medium }),
    ],
    [{ id: 0, owner: "player", ships: 10, originId: 0, destId: 1, progress: 0, damage: 0 }]
  );
  for (let t = 0; t < 250; t++) tick(friendly, TICK_DT);
  assert(
    friendly.fleets[0]!.ships === 10 && friendly.fleets[0]!.damage === 0,
    "own zones never fire on friendly fleets"
  );
}

// 1n. predictRoute (QUA-129 shared estimator): closed-form chord math is
// exact, and tracks the sim closely when garrisons are constant.
{
  const mk = () =>
    mkState(
      [
        planet(0, { x: 0, y: 800, owner: "player" }),
        planet(1, { x: 1000, y: 800, owner: "player" }),
        planet(2, { x: 500, y: 800, owner: "ai1", garrison: GARRISON_CAP.medium }),
      ],
      [{ id: 0, owner: "player", ships: 30, originId: 0, destId: 1, progress: 0, damage: 0 }]
    );
  const dps = INTERCEPT.damageRate * GARRISON_CAP.medium;
  const zoneR = SIZE_RADIUS.medium * INTERCEPT.zoneRadiusFactor;

  const pred = predictRoute(mk(), "player", 0, 1, 30);
  closeTo(pred.losses, (dps * 2 * zoneR) / SHIP_SPEED, "chord losses exact (220u at 2.5/s)");
  assert(pred.survivors === 27, "survivors floor(30 - 2.75) = 27");
  assert(pred.segments.length === 1, "one hostile segment");
  closeTo(pred.segments[0]!.t0, 0.39, "segment entry");
  closeTo(pred.segments[0]!.t1, 0.61, "segment exit");

  // Predictor vs sim: constant-garrison zone → estimate within quantisation.
  const s = mk();
  for (let t = 0; t < 250; t++) tick(s, TICK_DT);
  const simLost = 30 - s.fleets[0]!.ships;
  assert(Math.abs(simLost - pred.losses) <= 1, "prediction within one ship of the sim");

  // A route ending inside a zone (attacking the zone's planet) clamps the
  // segment at the destination: 110u of exposure on the 500u approach.
  const clamped = predictRoute(mk(), "player", 0, 2, 30);
  closeTo(clamped.losses, (dps * zoneR) / SHIP_SPEED, "clamped segment losses exact");
  closeTo(clamped.segments[0]!.t0, (500 - zoneR) / 500, "clamped segment entry");
  closeTo(clamped.segments[0]!.t1, 1, "clamped segment ends at the destination");
}

// 2. Fleet travel timing: full screen width (1000u) in 5s = 300 ticks at 60Hz.
// ±1-tick tolerance — never assert exact float boundaries.
{
  const s = mkState(
    [planet(0, { owner: "player", x: 0, y: 800 }), planet(1, { x: 1000, y: 800, garrison: 99 })],
    [{ id: 0, owner: "player", ships: 1, originId: 0, destId: 1, progress: 0, damage: 0 }]
  );
  for (let t = 0; t < 298; t++) tick(s, TICK_DT);
  assert(s.fleets.length === 1, "fleet still in flight at tick 298");
  for (let t = 0; t < 4; t++) tick(s, TICK_DT);
  assert(s.fleets.length === 0, "fleet arrived by tick 302 (nominal 300 = 5.0s)");
}

// 3. Capture: a decisive assault wins the battle, flips the planet, and the
// surviving attackers become the new garrison. The arriving fleet is consumed
// into the battle immediately (no lingering fleet object).
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, garrison: 5 })],
    [{ id: 0, owner: "player", ships: 12, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  tick(s, TICK_DT);
  assert(s.fleets.length === 0, "arrived fleet removed");
  assert(s.battles.length === 1, "hostile arrival opened a battle, not an instant flip");
  assert(s.planets[1]!.owner === "neutral", "no instant capture");
  fight(s);
  assert(s.planets[1]!.owner === "player", "planet flipped to attacker");
  const survivors = Math.floor(s.planets[1]!.garrison);
  assert(survivors >= 1 && survivors < 12, "survivors became the new garrison");
}

// 4. Failed attack: a too-small force is ground down by the garrison (worth
// ×1.2 each), ownership unchanged; the fight cost the defender some ships.
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 10 })],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  fight(s);
  assert(s.planets[1]!.owner === "ai1", "failed attack did not flip ownership");
  const left = s.planets[1]!.garrison;
  assert(left > 0 && left < 10, `defenders paid for the win, hold survivors (got ${left})`);
  assert(s.battles.length === 0, "battle cleaned up after the attacker died");
}

// 4b. Mutual destruction in one tick: both sides' casualties are computed
// from start-of-tick strengths and both applied; the attacker is checked
// first, so the defender holds at 0 with ownership unchanged (the successor
// of the old exact-tie rule). Hand-built accumulators put both sides one
// whole ship from death on the same tick.
{
  const s = mkState([planet(0, { garrison: 1 })]);
  s.battles.push({
    planetId: 0,
    defenderDamage: 0.995,
    attackers: [{ owner: "player", ships: 1, damage: 0.995 }],
  });
  tick(s, TICK_DT);
  assert(s.planets[0]!.owner === "neutral", "mutual destruction keeps defender ownership");
  assert(Math.floor(s.planets[0]!.garrison) === 0, "defender holds at 0");
  assert(s.battles.length === 0, "battle over");
}

// 5. Reinforcement: friendly arrival adds to the garrison.
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "player", garrison: 4 })],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
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
// fleets array is built in REVERSE id order; id order means the player fleet
// (lower id) opens the battle and holds the head-pool slot — the pairwise
// rule says only attackers[0] trades with the defender — while the later ai1
// arrival queues behind it. This pins pool-creation order.
{
  const s = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 200, owner: "ai1" }),
      planet(2, { x: 100, garrison: 5 }),
    ],
    [
      { id: 5, owner: "ai1", ships: 3, originId: 1, destId: 2, progress: 0.999, damage: 0 },
      { id: 2, owner: "player", ships: 6, originId: 0, destId: 2, progress: 0.999, damage: 0 },
    ]
  );
  tick(s, TICK_DT);
  const b = s.battles[0]!;
  assert(s.battles.length === 1, "both hostile arrivals share one battle");
  assert(b.attackers.length === 2, "two pools, one per faction");
  assert(b.attackers[0]!.owner === "player", "lower fleet id opened the battle: head pool");
  assert(b.attackers[1]!.owner === "ai1", "higher fleet id queued second");
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
    [{ id: 0, owner: "ai1", ships: 4, originId: 1, destId: 2, progress: 0.2, damage: 0 }]
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
// 9. Ticked battles (combat rework acceptance).
// ---------------------------------------------------------------------------

/** 1v1 duel: `att` player ships land on an ai1 medium holding `def`. */
function duel(att: number, def: number, seed: number) {
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: def })],
    [{ id: 0, owner: "player", ships: att, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  s.seed = seed;
  const ticks = fight(s);
  return { s, ticks, won: s.planets[1]!.owner === "player", left: Math.floor(s.planets[1]!.garrison) };
}

// 9a. The anti-snipe core: 21 v 20 loses across seeds (the ×1.2 defender
// bonus + superlinear exponent kill the free 21-beats-20 snipe), while 30 v 20
// reliably wins with meaningful survivors in a ~1–2s battle.
{
  for (const seed of [1, 7, 42, 1234, 987654, 0x5eed]) {
    const r = duel(21, 20, seed);
    assert(!r.won, `21 v 20: defender holds (seed ${seed})`);
    assert(r.s.battles.length === 0, "battle fully resolved");
  }
  for (const seed of [1, 7, 42, 1234]) {
    const r = duel(30, 20, seed);
    assert(r.won, `30 v 20: attacker wins (seed ${seed})`);
    assert(r.left >= 15, `30 v 20 keeps meaningful survivors (got ${r.left}, seed ${seed})`);
    assert(r.ticks >= 50 && r.ticks <= 130, `30 v 20 lasts ~1-2s (got ${r.ticks} ticks)`);
  }
}

// 9b. Determinism: same seed → bit-identical outcome; and battle rolls are
// keyed by (seed, tick, planet), so the shared state.rng stream is neither
// consumed nor consulted — perturbing it must change nothing.
{
  const a = duel(22, 20, 42); // 22 v 20 is the variance knife edge — ideal here
  const b = duel(22, 20, 42);
  assert(JSON.stringify(a.s) === JSON.stringify(b.s), "same seed → identical battle outcome");

  const c = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 20 })],
    [{ id: 0, owner: "player", ships: 22, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  c.seed = 42;
  c.rng.s = 0xdeadbeef; // a perturbed shared stream must not affect battles
  fight(c);
  assert(
    JSON.stringify(c.planets) === JSON.stringify(a.s.planets),
    "battle outcome independent of the shared rng stream"
  );
}

// 9c. Mid-battle serialization: a JSON snapshot taken during a fight resumes
// bit-identically (battle state is plain data; rolls are pure functions of
// seed/tick/planet).
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 20 })],
    [{ id: 0, owner: "player", ships: 30, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  s.seed = 7;
  for (let t = 0; t < 30; t++) tick(s, TICK_DT); // well inside the battle
  assert(s.battles.length === 1, "battle in progress at the snapshot point");
  const clone = JSON.parse(JSON.stringify(s)) as GameState;
  for (let t = 0; t < 200; t++) {
    tick(s, TICK_DT);
    tick(clone, TICK_DT);
  }
  assert(JSON.stringify(s) === JSON.stringify(clone), "mid-battle snapshot resumes identically");
}

// 9d. Reinforcement mid-battle, defender side: 30 v 20 flips the planet when
// unaided (9a), but 15 defenders landing ~30 ticks in turn the tide. The
// friendly arrival joins the garrison (no new pool).
{
  const s = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 1000, owner: "ai1", garrison: 20 }),
      planet(2, { x: 900, owner: "ai1", garrison: 0 }),
    ],
    [
      { id: 0, owner: "player", ships: 30, originId: 0, destId: 1, progress: 0.999, damage: 0 },
      // 100u from p2 to p1 at 200u/s = 30 ticks out.
      { id: 1, owner: "ai1", ships: 15, originId: 2, destId: 1, progress: 0, damage: 0 },
    ]
  );
  const relieved = fight(s);
  assert(relieved > 30, "the fight outlasted the relief fleet's approach");
  assert(s.planets[1]!.owner === "ai1", "mid-battle defender reinforcement saved the planet");
  assert(s.battles.length === 0, "battle resolved");
}

// 9e. Reinforcement mid-battle, attacker side: 21 v 20 dies alone (9a), but a
// second 10-ship wave landing ~30 ticks in joins the existing pool (same
// owner → merge, still one pool) and takes the planet.
{
  const s = mkState(
    [
      planet(0, { owner: "player" }),
      planet(1, { x: 1000, owner: "ai1", garrison: 20 }),
      planet(2, { x: 900, owner: "player", garrison: 0 }),
    ],
    [
      { id: 0, owner: "player", ships: 21, originId: 0, destId: 1, progress: 0.999, damage: 0 },
      { id: 1, owner: "player", ships: 10, originId: 2, destId: 1, progress: 0, damage: 0 },
    ]
  );
  for (let t = 0; t < 40; t++) tick(s, TICK_DT); // second wave has landed
  assert(s.battles.length === 1 && s.battles[0]!.attackers.length === 1,
    "same-owner wave merged into the existing pool");
  fight(s);
  assert(s.planets[1]!.owner === "player", "attacker reinforcement carried the assault");
}

// 9f. Defence spec and level multipliers stack on the defender bonus:
// 1.2 × 1.5 (L3) × 2 (defence) = 3.6 per ship, which lifts the repel
// threshold to 20 × 3.6^(1.2/2.2) ≈ 40 attackers.
{
  const fortress = () => {
    const p = planet(1, { x: 100, owner: "ai1", garrison: 20, spec: "defence" });
    p.heldTicks = DEVELOPMENT.levelTimes[2] * TICK_RATE;
    return p;
  };
  closeTo(defenderStrengthMult(fortress()), 3.6, "bonus × level × spec = 3.6");

  const held = mkState(
    [planet(0, { owner: "player" }), fortress()],
    [{ id: 0, owner: "player", ships: 34, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  fight(held);
  assert(held.planets[1]!.owner === "ai1", "L3 defence fortress repels 34 attackers");

  const broken = mkState(
    [planet(0, { owner: "player" }), fortress()],
    [{ id: 0, owner: "player", ships: 90, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  fight(broken);
  assert(broken.planets[1]!.owner === "player", "overwhelming force still cracks the fortress");
}

// 9g. Production, development and conversion freeze under siege and resume
// after (a 6-ship nuisance attack on 20 defenders can't win but takes time).
{
  const s = mkState(
    [planet(0, { owner: "player" }), planet(1, { x: 100, owner: "ai1", garrison: 20 })],
    [{ id: 0, owner: "player", ships: 6, originId: 0, destId: 1, progress: 0.999, damage: 0 }]
  );
  tick(s, TICK_DT); // arrival tick: production ran (no battle yet at step 1)
  const p = s.planets[1]!;
  const heldAtSiege = p.heldTicks;
  const garrisonAtSiege = p.garrison;
  tick(s, TICK_DT);
  assert(p.heldTicks === heldAtSiege, "development frozen under siege");
  assert(p.garrison <= garrisonAtSiege, "no production under siege");
  fight(s);
  assert(p.owner === "ai1", "nuisance attack repelled");
  const heldAfter = p.heldTicks;
  const garrisonAfter = p.garrison;
  for (let t = 0; t < 60; t++) tick(s, TICK_DT);
  assert(p.heldTicks === heldAfter + 60, "development resumed after the siege");
  closeTo(p.garrison, garrisonAfter + PRODUCTION.medium, "production resumed after the siege");
}

// 9h. Multi-faction pairwise: player and ai1 both assault a neutral. The
// head pool (player, lower fleet id) fights first and flips the planet; the
// queued ai1 pool then fights the new player garrison — which now enjoys the
// defender bonus — and, being far larger, takes the planet in turn.
{
  const s = mkState(
    [
      planet(0, { x: 0, owner: "player" }),
      planet(1, { x: 300, owner: "ai1" }),
      planet(2, { x: 100, garrison: 5 }),
    ],
    [
      { id: 0, owner: "player", ships: 12, originId: 0, destId: 2, progress: 0.999, damage: 0 },
      { id: 1, owner: "ai1", ships: 40, originId: 1, destId: 2, progress: 0.999, damage: 0 },
    ]
  );
  let flippedToPlayer = false;
  tick(s, TICK_DT); // land both fleets and open the battle
  for (let t = 0; t < 2000 && s.battles.length > 0; t++) {
    tick(s, TICK_DT);
    if (s.planets[2]!.owner === "player") {
      flippedToPlayer = true;
      assert(
        s.battles.length === 0 || s.battles[0]!.attackers[0]!.owner === "ai1",
        "after the flip the queued ai1 pool fights the new defender"
      );
    }
  }
  assert(flippedToPlayer, "head pool flipped the neutral first");
  assert(s.planets[2]!.owner === "ai1", "the queued pool then took the planet");
  assert(s.battles.length === 0, "all battles resolved");
}

// 9i. Win check: a faction whose last force is a besieging pool is alive.
{
  const s = mkState([
    planet(0, { x: 0, owner: "ai1", garrison: 50 }),
    planet(1, { x: 300, owner: "ai1", garrison: 5 }),
  ]);
  s.battles.push({
    planetId: 0,
    defenderDamage: 0,
    attackers: [{ owner: "player", ships: 3, damage: 0 }],
  });
  update(s, []);
  assert(s.phase === "playing", "player alive while its pool still besieges");
  for (let t = 0; t < 2000 && s.battles.length > 0; t++) update(s, []);
  assert(s.phase === "aiWon", "player eliminated once the pool is wiped");
}

// 9j. predictBattle (the preview/AI estimator) agrees with the sim: same
// winner, and survivors/duration close at mean roll (0.9–1.1 variance keeps
// the sim within a few ships of the rollless prediction).
{
  assert(!predictBattle(21, 20, 1.2).attackerWins, "predictor: 21 v 20 loses");
  assert(predictBattle(30, 20, 1.2).attackerWins, "predictor: 30 v 20 wins");
  const pred = predictBattle(30, 20, 1.2);
  const sim = duel(30, 20, 42);
  assert(Math.abs(pred.survivors - sim.left) <= 3,
    `predictor survivors near sim (${pred.survivors} vs ${sim.left})`);
  assert(Math.abs(pred.ticks - sim.ticks) <= 20,
    `predictor duration near sim (${pred.ticks} vs ${sim.ticks})`);
}

// ---------------------------------------------------------------------------
// Acceptance scenario (QUA-119 "done when", updated for ticked battles):
// 3 planets, 2 owners, 1 fleet in transit; production accumulates, the fleet
// arrives and opens a battle (visible mid-fight at tick 100), the battle
// resolves into a capture, and a new fleet spawns per spec numbers.
//
// Arithmetic: d(P0,P1)=600 -> 1/180 progress/tick; 0.51 + 89/180 >= 1 so the
// fleet arrives during tick 89. P1 (ai1, large) holds 3 + 89*0.025 = 5.225 at
// arrival; the 12-ship assault vs ~5×1.2 = 6 effective grinds it down over
// tens of ticks (production frozen under siege), then flips it.
// ---------------------------------------------------------------------------
{
  const s = mkState(
    [
      planet(0, { x: 200, y: 800, owner: "player", size: "medium", garrison: 10 }),
      planet(1, { x: 800, y: 800, owner: "ai1", size: "large", garrison: 3 }),
      planet(2, { x: 500, y: 400, owner: "neutral", size: "small", garrison: 5 }),
    ],
    [{ id: 0, owner: "player", ships: 12, originId: 0, destId: 1, progress: 0.51, damage: 0 }]
  );

  for (let t = 0; t < 100; t++) tick(s, TICK_DT);

  assert(s.tick === 100, "ran exactly 100 ticks");
  assert(s.fleets.length === 0, "fleet in transit arrived");
  closeTo(s.planets[0]!.garrison, 10 + 100 / 60, "P0 production accumulated");
  assert(Math.floor(s.planets[0]!.garrison) === 11, "P0 displays 11");
  assert(s.battles.length === 1, "the arrival opened a battle still raging at tick 100");
  assert(s.planets[1]!.owner === "ai1", "P1 not yet captured mid-battle");

  for (let t = 0; t < 100; t++) tick(s, TICK_DT);
  assert(s.battles.length === 0, "battle resolved well within 100 more ticks");
  assert(s.planets[1]!.owner === "player", "P1 captured by the surviving attackers");
  const p1 = Math.floor(s.planets[1]!.garrison);
  assert(p1 >= 7 && p1 <= 13, `P1 garrison is the survivors + resumed production (got ${p1})`);
  closeTo(s.planets[2]!.garrison, 5, "neutral P2 untouched");

  // New fleet spawns correctly per spec numbers.
  closeTo(s.planets[0]!.garrison, 10 + 200 / 60, "P0 production ran the full 200 ticks");
  sendFleet(s, 0, 2, 0.5);
  assert(s.fleets.length === 1, "new fleet spawned");
  const f = s.fleets[0]!;
  assert(f.id === 1 && f.owner === "player" && f.originId === 0 && f.destId === 2, "fleet fields");
  assert(f.ships === 6, "floor(13.333 * 0.5) = 6 ships");
  closeTo(s.planets[0]!.garrison, 10 + 200 / 60 - 6, "P0 garrison after send");
  tick(s, TICK_DT); // d(P0,P2) = 500 -> progress 200/60/500 = 1/150
  closeTo(s.fleets[0]!.progress, 1 / 150, "fleet progress after one tick");
}

console.log(
  "sim tests OK (production, development, caps, specialisation, interception, predictRoute, travel, battles, capture, reinforce, id-order, JSON, sendFleet, acceptance)"
);
