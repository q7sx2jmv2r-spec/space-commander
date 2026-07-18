// Seeded map generation. DOM-free; consumes the game's PRNG so the map is
// part of the seeded stream. RNG values are drawn in a fixed order (size,
// x, y — then one garrison draw per accepted pair) on every attempt,
// including rejected ones, so a given seed always yields the same map.
// QUA-121 replaces this with generateMap(seed, factionCount).

import {
  Size,
  WORLD_W,
  WORLD_H,
  HOME_SIZE,
  HOME_GARRISON,
  NEUTRAL_GARRISON,
  SIZE_RADIUS,
  EDGE_MARGIN,
  PLANET_GAP,
  PAIR_COUNT,
  ATTEMPTS_PER_PAIR,
} from "./config";
import { RngState, nextFloat, nextRange } from "./rng";
import type { Planet } from "./sim";

function fits(planets: Planet[], x: number, y: number, r: number): boolean {
  if (
    x - r < EDGE_MARGIN ||
    x + r > WORLD_W - EDGE_MARGIN ||
    y - r < EDGE_MARGIN ||
    y + r > WORLD_H - EDGE_MARGIN
  ) {
    return false;
  }
  for (const p of planets) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (Math.sqrt(dx * dx + dy * dy) < SIZE_RADIUS[p.size] + r + PLANET_GAP) return false;
  }
  return true;
}

function sampleSize(rng: RngState): Size {
  const t = nextFloat(rng);
  if (t < 1 / 3) return "small";
  if (t < 2 / 3) return "medium";
  return "large";
}

/** Two symmetric home planets plus up to PAIR_COUNT point-mirrored neutral
 * pairs (mirrored through the world center, same size and garrison) so both
 * sides face a fair map. Pairs that can't be placed are skipped. Player home
 * is at the bottom for one-handed thumb reach. */
export function generatePlanets(rng: RngState): Planet[] {
  const planets: Planet[] = [
    { id: 0, x: WORLD_W / 2, y: 1380, size: HOME_SIZE, owner: "player", garrison: HOME_GARRISON },
    { id: 1, x: WORLD_W / 2, y: 220, size: HOME_SIZE, owner: "ai1", garrison: HOME_GARRISON },
  ];

  for (let pair = 0; pair < PAIR_COUNT; pair++) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_PAIR; attempt++) {
      const size = sampleSize(rng);
      const r = SIZE_RADIUS[size];
      const x = nextRange(rng, EDGE_MARGIN + r, WORLD_W - EDGE_MARGIN - r);
      const y = nextRange(rng, EDGE_MARGIN + r, WORLD_H / 2);
      const mx = WORLD_W - x;
      const my = WORLD_H - y;
      if (!fits(planets, x, y, r)) continue;
      const first: Planet = { id: planets.length, x, y, size, owner: "neutral", garrison: 0 };
      if (!fits(planets.concat(first), mx, my, r)) continue;

      // Garrison drawn only after placement succeeds — still deterministic,
      // since success is a pure function of the draws made so far. Both
      // members of a mirrored pair share the value for fairness.
      const range = NEUTRAL_GARRISON[size];
      const garrison = range.min + Math.floor(nextFloat(rng) * (range.max - range.min + 1));
      first.garrison = garrison;
      planets.push(first);
      planets.push({ id: planets.length, x: mx, y: my, size, owner: "neutral", garrison });
      break;
    }
  }
  return planets;
}
