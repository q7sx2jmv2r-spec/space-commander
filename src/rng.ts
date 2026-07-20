// Seeded PRNG (mulberry32). The state object lives inside GameState and must
// stay JSON-serializable; every draw mutates it in place. Draw order is part
// of the determinism contract — never reorder or skip draws conditionally on
// anything outside the sim state.

export interface RngState {
  s: number; // uint32
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

export function nextU32(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Uniform float in [0, 1). */
export function nextFloat(r: RngState): number {
  return nextU32(r) / 4294967296;
}

/** Uniform float in [min, max). */
export function nextRange(r: RngState, min: number, max: number): number {
  return min + nextFloat(r) * (max - min);
}

/** Mix two integers into a decorrelated uint32 sub-seed. Used to derive
 * independent streams from one seed (mapgen retries, per-battle rolls keyed
 * by tick + planet id) without disturbing any live RngState. */
export function mixSeed(seed: number, key: number): number {
  let h = (seed ^ Math.imul(key + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
