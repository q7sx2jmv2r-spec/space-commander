// Seeded map generation. DOM-free; consumes the game's PRNG so the map is
// part of the seeded stream. RNG values are drawn in a fixed order (radius,
// x, y) on every attempt, including rejected ones, so a given seed always
// yields the same map.

import { RngState, nextRange } from "./rng";
import { Planet, WORLD_W, WORLD_H, NEUTRAL, PLAYER, AI } from "./sim";

const HOME_RADIUS = 45;
const HOME_START_SHIPS = 100;
const NEUTRAL_GARRISON_FACTOR = 0.6;
const MIN_RADIUS = 28;
const MAX_RADIUS = 60;
const EDGE_MARGIN = 20;
const PLANET_GAP = 30;
const PAIR_COUNT = 5;
const ATTEMPTS_PER_PAIR = 60;

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
    if (Math.sqrt(dx * dx + dy * dy) < p.r + r + PLANET_GAP) return false;
  }
  return true;
}

/** Two symmetric home planets plus up to PAIR_COUNT point-mirrored neutral
 * pairs (mirrored through the world center, same radius) so both sides face
 * a fair map. Pairs that can't be placed are skipped. Player home is at the
 * bottom for one-handed thumb reach. */
export function generatePlanets(rng: RngState): Planet[] {
  const planets: Planet[] = [
    { id: 0, x: WORLD_W / 2, y: 1380, r: HOME_RADIUS, owner: PLAYER, ships: HOME_START_SHIPS },
    { id: 1, x: WORLD_W / 2, y: 220, r: HOME_RADIUS, owner: AI, ships: HOME_START_SHIPS },
  ];

  for (let pair = 0; pair < PAIR_COUNT; pair++) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_PAIR; attempt++) {
      const r = nextRange(rng, MIN_RADIUS, MAX_RADIUS);
      const x = nextRange(rng, EDGE_MARGIN + r, WORLD_W - EDGE_MARGIN - r);
      const y = nextRange(rng, EDGE_MARGIN + r, WORLD_H / 2);
      const mx = WORLD_W - x;
      const my = WORLD_H - y;
      if (!fits(planets, x, y, r)) continue;
      const first: Planet = {
        id: planets.length,
        x,
        y,
        r,
        owner: NEUTRAL,
        ships: Math.round(r * NEUTRAL_GARRISON_FACTOR),
      };
      if (!fits(planets.concat(first), mx, my, r)) continue;
      planets.push(first);
      planets.push({
        id: planets.length,
        x: mx,
        y: my,
        r,
        owner: NEUTRAL,
        ships: Math.round(r * NEUTRAL_GARRISON_FACTOR),
      });
      break;
    }
  }
  return planets;
}
