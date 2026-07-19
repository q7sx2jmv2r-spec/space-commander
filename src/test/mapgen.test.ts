// QUA-121 map-generator tests. Bundled by esbuild and run under plain node
// (npm run test:mapgen), which also proves mapgen is DOM-free. Throws on
// failure so node exits nonzero without a test framework.

import {
  FactionCount,
  WORLD_W,
  WORLD_H,
  SIZE_RADIUS,
  EDGE_MARGIN,
  PLANET_COUNT,
  SECTOR_NEUTRALS,
  CENTER_CLUSTER,
  EDGE_GAP_FACTOR,
  MIN_CENTER_DIST,
  HOME_GARRISON,
} from "../config";
import { generateMap } from "../mapgen";
import type { GameState, Planet } from "../sim";

const CX = WORLD_W / 2;
const CY = WORLD_H / 2;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`mapgen test FAILED: ${msg}`);
}

function d(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Independent re-validation (does NOT trust the generator's own checks). */
function checkMap(state: GameState, fc: FactionCount, seed: number): void {
  const ps = state.planets;
  const where = `seed ${seed}, ${fc} factions`;

  // Counts in the spec range.
  const range = PLANET_COUNT[fc];
  assert(ps.length >= range.min && ps.length <= range.max, `${where}: planet count ${ps.length} outside [${range.min},${range.max}]`);

  // Bounds.
  for (const p of ps) {
    const r = SIZE_RADIUS[p.size];
    assert(
      p.x - r >= EDGE_MARGIN && p.x + r <= WORLD_W - EDGE_MARGIN && p.y - r >= EDGE_MARGIN && p.y + r <= WORLD_H - EDGE_MARGIN,
      `${where}: planet ${p.id} out of bounds at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
    );
  }

  // Pairwise spacing: edge gap and centre distance.
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]!;
      const b = ps[j]!;
      const ra = SIZE_RADIUS[a.size];
      const rb = SIZE_RADIUS[b.size];
      const center = d(a.x, a.y, b.x, b.y);
      const gap = center - ra - rb;
      const need = EDGE_GAP_FACTOR * Math.max(ra, rb);
      assert(gap >= need - 1e-6, `${where}: planets ${a.id},${b.id} edge gap ${gap.toFixed(1)} < ${need.toFixed(1)}`);
      assert(center >= MIN_CENTER_DIST - 1e-6, `${where}: planets ${a.id},${b.id} centre dist ${center.toFixed(1)} < ${MIN_CENTER_DIST.toFixed(1)}`);
    }
  }

  // Ids are dense 0..n-1 (render.ts and sim.ts index planets by id).
  ps.forEach((p, idx) => assert(p.id === idx, `${where}: planet at index ${idx} has id ${p.id}`));

  // Homes: exactly factionCount, large, standard garrison, equidistant from centre.
  const homes: Planet[] = ps.filter((p) => p.owner !== "neutral");
  assert(homes.length === fc, `${where}: expected ${fc} homes, got ${homes.length}`);
  assert(homes.some((h) => h.owner === "player"), `${where}: no player home`);
  const d0 = d(CX, CY, homes[0]!.x, homes[0]!.y);
  for (const h of homes) {
    assert(h.size === "large", `${where}: home ${h.id} is ${h.size}, not large`);
    assert(h.garrison === HOME_GARRISON, `${where}: home ${h.id} garrison ${h.garrison} != ${HOME_GARRISON}`);
    assert(Math.abs(d(CX, CY, h.x, h.y) - d0) <= 1.5, `${where}: home ${h.id} not equidistant from centre`);
  }

  // Structural split: neutral count must decompose into fc replicated sectors
  // of k∈[3,6] plus a centre cluster of c∈[2,5].
  const neutrals = ps.length - fc;
  let feasible = false;
  for (let k = SECTOR_NEUTRALS.min; k <= SECTOR_NEUTRALS.max && !feasible; k++) {
    const c = neutrals - fc * k;
    if (c >= CENTER_CLUSTER.min && c <= CENTER_CLUSTER.max) feasible = true;
  }
  assert(feasible, `${where}: ${neutrals} neutrals don't split into ${fc}·k + c (k∈[3,6], c∈[2,5])`);
}

const FACTS: FactionCount[] = [2, 3];

// 1. Determinism: same seed + faction count → bit-identical GameState.
for (const fc of FACTS) {
  const a = JSON.stringify(generateMap(4242, fc));
  const b = JSON.stringify(generateMap(4242, fc));
  assert(a === b, `same seed produced different ${fc}-faction maps`);
}

// 2. Seed matters: different seeds → different maps (sanity).
{
  const a = JSON.stringify(generateMap(1, 2));
  const b = JSON.stringify(generateMap(2, 2));
  assert(a !== b, "different seeds produced identical maps");
}

// 3. Faction count changes the map.
{
  const a = JSON.stringify(generateMap(99, 2));
  const b = JSON.stringify(generateMap(99, 3));
  assert(a !== b, "2- and 3-faction maps identical for the same seed");
}

// 4. 100 seeds × {2,3}: never overlapping / out of bounds / unfair.
let generated = 0;
for (let seed = 0; seed < 100; seed++) {
  for (const fc of FACTS) {
    const state = generateMap(seed, fc);
    checkMap(state, fc, seed);
    generated++;
  }
}

// 5. JSON round-trip (state must be plain serializable data, like the sim).
{
  const state = generateMap(7, 3);
  const round = JSON.parse(JSON.stringify(state)) as GameState;
  assert(JSON.stringify(state) === JSON.stringify(round), "map state failed JSON round-trip");
}

console.log(`mapgen tests OK (determinism, seed/faction variance, ${generated} maps validated over 100 seeds × {2,3}, round-trip)`);
