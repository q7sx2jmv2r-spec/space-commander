// Seeded, symmetric map generation (QUA-121). DOM-free and fully
// deterministic: generateMap(seed, factionCount) draws every random value
// from a seeded PRNG in a fixed order, so the same (seed, factionCount)
// always yields a bit-identical GameState.
//
// Algorithm: budget a planet count, build ONE faction's sector (a large home
// plus a few nearby neutrals), replicate it to the other factions as an
// isometry about the world centre (mirror for 2, 120°/240° rotation for 3),
// jitter the replicated planets, then add a non-replicated contested cluster
// at the centre. Candidates that violate the spacing/fairness constraints are
// rejected and the map is regenerated from a mixed sub-seed.

import {
  Size,
  Owner,
  FactionCount,
  WORLD_W,
  WORLD_H,
  HOME_SIZE,
  HOME_GARRISON,
  NEUTRAL_GARRISON,
  SIZE_RADIUS,
  EDGE_MARGIN,
  PLANET_COUNT,
  SECTOR_NEUTRALS,
  CENTER_CLUSTER,
  HOME_DIST,
  SECTOR_RADIUS,
  SECTOR_HALF_ANGLE,
  CENTER_CLUSTER_RADIUS,
  JITTER_FRACTION,
  EDGE_GAP_FACTOR,
  MIN_CENTER_DIST,
  HOME_DIST_TOLERANCE,
  PLACEMENT_TRIES,
  MAX_MAP_ATTEMPTS,
} from "./config";
import { AiTier } from "./config";
import { RngState, createRng, nextFloat, nextRange } from "./rng";
import { AiState, nextDecisionDelay } from "./ai";
import type { GameState, Planet } from "./sim";

const CX = WORLD_W / 2;
const CY = WORLD_H / 2;

/** Owners for factions 0..2. Index 0 (player) sits at the bottom for thumb
 * reach; ai2 only appears in 3-faction maps (its render colour already
 * exists — it stays passive until QUA-123 gives it an AI). */
const FACTION_OWNERS: Owner[] = ["player", "ai1", "ai2"];

/** Deterministic sub-seed for retry N, so each attempt explores a different
 * map while staying a pure function of the original seed. */
function mixSeed(seed: number, attempt: number): number {
  let h = (seed ^ Math.imul(attempt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

function inBounds(x: number, y: number, r: number): boolean {
  return (
    x - r >= EDGE_MARGIN &&
    x + r <= WORLD_W - EDGE_MARGIN &&
    y - r >= EDGE_MARGIN &&
    y + r <= WORLD_H - EDGE_MARGIN
  );
}

/** True if a planet of radius r at (x,y) clears bounds and every existing
 * planet by both the edge-gap and centre-distance rules. */
function fits(planets: readonly Planet[], x: number, y: number, r: number): boolean {
  if (!inBounds(x, y, r)) return false;
  for (const p of planets) {
    const pr = SIZE_RADIUS[p.size];
    const minCenter = Math.max(pr + r + EDGE_GAP_FACTOR * Math.max(pr, r), MIN_CENTER_DIST);
    if (dist2(p.x, p.y, x, y) < minCenter * minCenter) return false;
  }
  return true;
}

/** Neutral size: varied, but weighted toward smaller planets. Big planets eat
 * a lot of clearance (the edge-gap scales with the larger radius), and the
 * 3-faction map packs 14–20 planets into the inscribed circle — an even split
 * pushes past the random-packing limit and generation starts failing. */
function sampleNeutralSize(rng: RngState): Size {
  const t = nextFloat(rng);
  if (t < 0.5) return "small";
  if (t < 0.85) return "medium";
  return "large";
}

/** Integer in [min, max], biased toward min. Denser maps (higher per-sector
 * and centre counts) are much harder to place under the spacing rules in the
 * portrait world, so we favour the sparser end while still covering the whole
 * spec range. */
function sampleLowBiased(rng: RngState, min: number, max: number): number {
  const t = nextFloat(rng);
  return min + Math.floor(t * t * (max - min + 1));
}

function neutralGarrison(rng: RngState, size: Size): number {
  const range = NEUTRAL_GARRISON[size];
  return range.min + Math.floor(nextFloat(rng) * (range.max - range.min + 1));
}

/** Bearing (radians) from the world centre to faction f's home. Faction 0
 * points straight down (screen y grows downward); the rest are spaced evenly
 * so the mirror (2) / rotation (3) transforms land each home on one. */
function homeAngle(f: number, factionCount: FactionCount): number {
  const step = (2 * Math.PI) / factionCount;
  return Math.PI / 2 + f * step;
}

/** Map a template (faction-0) point to faction f's sector: exact isometry
 * about the world centre — mirror across the horizontal axis for 2 factions,
 * rotation by f·120° for 3. Homes therefore stay equidistant from centre. */
function replicate(
  x: number,
  y: number,
  f: number,
  factionCount: FactionCount
): { x: number; y: number } {
  if (f === 0) return { x, y };
  if (factionCount === 2) return { x, y: WORLD_H - y };
  const a = f * ((2 * Math.PI) / 3);
  const dx = x - CX;
  const dy = y - CY;
  return {
    x: CX + dx * Math.cos(a) - dy * Math.sin(a),
    y: CY + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

interface SectorPlanet {
  x: number;
  y: number;
  size: Size;
  garrison: number;
}

/** One attempt at a full map. Returns the planet list, or null if placement
 * failed under the constraints (caller reseeds and retries). */
function tryBuild(rng: RngState, factionCount: FactionCount): Planet[] | null {
  // --- Budget: pick per-sector neutrals k and centre cluster c so the total
  // lands inside the spec range for this faction count. ---
  const total = PLANET_COUNT[factionCount];
  const k = sampleLowBiased(rng, SECTOR_NEUTRALS.min, SECTOR_NEUTRALS.max);
  // T = factionCount*(1+k) + c must fall in [total.min, total.max].
  const perFaction = factionCount * (1 + k);
  const cMin = Math.max(CENTER_CLUSTER.min, total.min - perFaction);
  const cMax = Math.min(CENTER_CLUSTER.max, total.max - perFaction);
  if (cMin > cMax) return null; // this k can't be budgeted; reseed picks another
  const c = sampleLowBiased(rng, cMin, cMax);

  const planets: Planet[] = [];

  // --- Contested centre cluster FIRST, on an empty board. It lives in a small
  // disc and can't dodge much, so placing it before the sectors (which have a
  // whole wedge of freedom to avoid it) keeps the success rate high. ---
  // Centre planets are always small: the cluster sits in a tight disc, and
  // small footprints let up to 5 of them coexist without overrunning it.
  const centerSize: Size = "small";
  const centerR = SIZE_RADIUS[centerSize];
  for (let i = 0; i < c; i++) {
    let placed = false;
    for (let tryN = 0; tryN < PLACEMENT_TRIES; tryN++) {
      const rad = nextRange(rng, 0, CENTER_CLUSTER_RADIUS);
      const ang = nextRange(rng, 0, 2 * Math.PI);
      const x = CX + rad * Math.cos(ang);
      const y = CY + rad * Math.sin(ang);
      if (!fits(planets, x, y, centerR)) continue;
      planets.push({ id: planets.length, x, y, size: centerSize, owner: "neutral", garrison: neutralGarrison(rng, centerSize), heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 });
      placed = true;
      break;
    }
    if (!placed) return null;
  }

  // --- Template sector (faction 0): a large home plus k nearby neutrals,
  // placed by polar coords about the world centre within the home's wedge.
  // Faction 0 is not transformed, so these are absolute coords and must clear
  // both the rest of the template and the centre cluster already on the board.
  const template: SectorPlanet[] = [];
  const homeA = homeAngle(0, factionCount);
  const homeR = HOME_DIST[factionCount];
  template.push({
    x: CX + homeR * Math.cos(homeA),
    y: CY + homeR * Math.sin(homeA),
    size: HOME_SIZE,
    garrison: HOME_GARRISON,
  });

  // Distribute the k neutrals across evenly-spaced radial rings within the
  // sector band (with jitter), rather than sampling radius uniformly. Even
  // spacing guarantees radial separation and keeps success high in the dense
  // 3-faction case, where uniform sampling would jam.
  const band = SECTOR_RADIUS[factionCount];
  const halfAngle = SECTOR_HALF_ANGLE[factionCount];
  const ringStep = (band.max - band.min) / k;
  for (let i = 0; i < k; i++) {
    const ringBase = band.min + (i + 0.5) * ringStep;
    let placed = false;
    for (let tryN = 0; tryN < PLACEMENT_TRIES; tryN++) {
      const size = sampleNeutralSize(rng);
      const r = SIZE_RADIUS[size];
      const rad = ringBase + nextRange(rng, -0.4 * ringStep, 0.4 * ringStep);
      const ang = homeA + nextRange(rng, -halfAngle, halfAngle);
      const x = CX + rad * Math.cos(ang);
      const y = CY + rad * Math.sin(ang);
      // Clear the rest of the template AND the centre cluster on the board.
      if (!fitsSector(template, x, y, r) || !fits(planets, x, y, r)) continue;
      template.push({ x, y, size, garrison: neutralGarrison(rng, size) });
      placed = true;
      break;
    }
    if (!placed) return null;
  }

  // --- Replicate the template to every faction, jittering the copies. ---
  const jitter = JITTER_FRACTION * Math.min(WORLD_W, WORLD_H);
  for (let f = 0; f < factionCount; f++) {
    const owner: Owner = FACTION_OWNERS[f]!;
    for (let pi = 0; pi < template.length; pi++) {
      const sp = template[pi]!;
      const isHome = pi === 0;
      const base = replicate(sp.x, sp.y, f, factionCount);
      const r = SIZE_RADIUS[sp.size];

      let px = base.x;
      let py = base.y;
      if (f !== 0 && !isHome) {
        // Jitter replicated neutrals; retry a few offsets, then reject the
        // attempt if none fit. Homes are never jittered (keeps them exactly
        // equidistant from centre); the template faction stays canonical.
        let ok = false;
        for (let tryN = 0; tryN < PLACEMENT_TRIES; tryN++) {
          const jx = nextRange(rng, -jitter, jitter);
          const jy = nextRange(rng, -jitter, jitter);
          if (fits(planets, base.x + jx, base.y + jy, r)) {
            px = base.x + jx;
            py = base.y + jy;
            ok = true;
            break;
          }
        }
        if (!ok) return null;
      } else if (!fits(planets, px, py, r)) {
        return null;
      }

      planets.push({
        id: planets.length,
        x: px,
        y: py,
        size: sp.size,
        owner: isHome ? owner : "neutral",
        garrison: sp.garrison,
        heldTicks: 0,
        spec: "standard",
        nextSpec: "standard",
        convertTicks: 0,
      });
    }
  }

  return validate(planets, factionCount) ? planets : null;
}

/** Fit check for template-space placement: identical rule to fits(), but the
 * template holds SectorPlanets (no id/owner yet). */
function fitsSector(sector: readonly SectorPlanet[], x: number, y: number, r: number): boolean {
  if (!inBounds(x, y, r)) return false;
  for (const p of sector) {
    const pr = SIZE_RADIUS[p.size];
    const minCenter = Math.max(pr + r + EDGE_GAP_FACTOR * Math.max(pr, r), MIN_CENTER_DIST);
    if (dist2(p.x, p.y, x, y) < minCenter * minCenter) return false;
  }
  return true;
}

/** Whole-map safety net: re-checks spacing, bounds, and home equidistance.
 * Incremental fits() already enforces spacing, so this mainly guards the
 * fairness invariant and catches any oversight. */
function validate(planets: readonly Planet[], factionCount: FactionCount): boolean {
  for (const p of planets) {
    if (!inBounds(p.x, p.y, SIZE_RADIUS[p.size])) return false;
  }
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const a = planets[i]!;
      const b = planets[j]!;
      const ra = SIZE_RADIUS[a.size];
      const rb = SIZE_RADIUS[b.size];
      const center = Math.sqrt(dist2(a.x, a.y, b.x, b.y));
      if (center - ra - rb < EDGE_GAP_FACTOR * Math.max(ra, rb) - 1e-6) return false;
      if (center < MIN_CENTER_DIST - 1e-6) return false;
    }
  }
  const homes = planets.filter((p) => p.owner !== "neutral");
  if (homes.length !== factionCount) return false;
  const d0 = Math.sqrt(dist2(CX, CY, homes[0]!.x, homes[0]!.y));
  for (const h of homes) {
    if (Math.abs(Math.sqrt(dist2(CX, CY, h.x, h.y)) - d0) > HOME_DIST_TOLERANCE) return false;
  }
  return true;
}

/**
 * Build a fresh, fair, seeded game map.
 *
 * @param seed  Reproducibility seed. If omitted, one is derived from the clock
 *              and logged so the map can be reproduced.
 * @param factionCount  2 (mirrored) or 3 (rotated) home factions.
 * @param aiTiers  Difficulty per AI faction (ai1, then ai2), padded with the
 *                 last entry / "medium" when shorter than the faction count.
 */
export function generateMap(
  seed?: number,
  factionCount: FactionCount = 2,
  aiTiers: readonly AiTier[] = []
): GameState {
  let s = seed;
  if (s === undefined) {
    s = Date.now() >>> 0;
    console.log(`[mapgen] no seed supplied; using seed=${s}`);
  }
  s = s >>> 0;

  for (let attempt = 0; attempt < MAX_MAP_ATTEMPTS; attempt++) {
    const genRng = createRng(mixSeed(s, attempt));
    const planets = tryBuild(genRng, factionCount);
    if (planets) {
      const state: GameState = {
        tick: 0,
        seed: s,
        // Gameplay RNG is a separate stream, decorrelated from the map-gen
        // stream and independent of how many attempts placement took, so the
        // in-game randomness (AI) stays reproducible per seed.
        rng: createRng(mixSeed(s, 0xa5a5a5)),
        planets,
        fleets: [],
        nextFleetId: 0,
        phase: "playing",
        ai: [],
      };
      for (let f = 1; f < factionCount; f++) {
        const tier = aiTiers[f - 1] ?? aiTiers[aiTiers.length - 1] ?? "medium";
        const ai: AiState = { owner: FACTION_OWNERS[f]!, tier, nextDecisionTick: 0 };
        ai.nextDecisionTick = nextDecisionDelay(state, tier);
        state.ai.push(ai);
      }
      return state;
    }
  }
  throw new Error(
    `mapgen: could not place a valid ${factionCount}-faction map for seed ${s} in ${MAX_MAP_ATTEMPTS} attempts`
  );
}
