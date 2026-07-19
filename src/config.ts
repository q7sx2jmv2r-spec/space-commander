// All gameplay tunables live here (QUA-119) — never scatter balance numbers
// as literals through the sim. DOM-free.

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** Logical world size (portrait). Rendering scales this to fit the screen;
 * screen size never affects simulation results. */
export const WORLD_W = 1000;
export const WORLD_H = 1600;

export type Size = "small" | "medium" | "large";
export type Owner = "player" | "ai1" | "ai2" | "ai3" | "neutral";

/** Ships/sec produced by an owned planet. Neutrals produce nothing. */
export const PRODUCTION: Record<Size, number> = { small: 0.5, medium: 1.0, large: 1.5 };

/** Spec: a fleet crosses the full screen width in 5 seconds. */
export const SHIP_SPEED = WORLD_W / 5; // world units/sec

export const HOME_GARRISON = 20;
// QUA-121: home planets are large (biggest producers, clear anchors).
export const HOME_SIZE: Size = "large";

/** Neutral starting garrison range per size (spec: 5–15, scaled with size). */
export const NEUTRAL_GARRISON: Record<Size, { min: number; max: number }> = {
  small: { min: 5, max: 8 },
  medium: { min: 9, max: 12 },
  large: { min: 13, max: 15 },
};

/** Default fraction of garrison launched per send. */
export const SEND_FRACTION = 0.5;

/** Display/hit-test radius per size class. Rendering and input only — the
 * simulation itself never reads radii. */
export const SIZE_RADIUS: Record<Size, number> = { small: 32, medium: 44, large: 56 };

// AI (rescaled to the QUA-119 garrison scale; tiers arrive in QUA-123)
export const AI_PERIOD = 120; // ticks between decisions (2s)
export const AI_MIN_GARRISON = 10;
export const AI_DIST_DIVISOR = 250; // target score = garrison + dist/AI_DIST_DIVISOR

// ---------------------------------------------------------------------------
// Map generation (QUA-121). generateMap(seed, factionCount) builds symmetric,
// fair maps; these are its only tunables (no balance literals in mapgen.ts).
// ---------------------------------------------------------------------------

export type FactionCount = 2 | 3;

/** Keep planets this far from the world edge (world units, edge-to-edge). */
export const EDGE_MARGIN = 20;

/** Total planet count range per faction count (spec: 2→10–14, 3→14–20). */
export const PLANET_COUNT: Record<FactionCount, { min: number; max: number }> = {
  2: { min: 10, max: 14 },
  3: { min: 14, max: 20 },
};

/** Neutrals in each faction's (replicated) sector. */
export const SECTOR_NEUTRALS = { min: 3, max: 6 };

/** Neutrals in the non-replicated contested centre cluster. */
export const CENTER_CLUSTER = { min: 2, max: 5 };

/** Home distance from world centre, per faction count. 2 factions mirror
 * along the tall (vertical) axis so they can sit farther apart; 3 factions
 * rotate about the centre and must stay inside the inscribed circle. */
export const HOME_DIST: Record<FactionCount, number> = { 2: 540, 3: 400 };

/** Sector neutrals are placed by polar coords about the world centre: radius
 * in this band, angle within ±SECTOR_HALF_ANGLE of the home's bearing. The
 * band sits inside the home radius so neutrals read as "in front of" the home,
 * toward the contested middle. */
export const SECTOR_RADIUS: Record<FactionCount, { min: number; max: number }> = {
  2: { min: 200, max: 470 },
  3: { min: 190, max: 355 },
};
export const SECTOR_HALF_ANGLE: Record<FactionCount, number> = {
  2: (72 * Math.PI) / 180,
  3: (44 * Math.PI) / 180,
};

/** Contested centre cluster: neutrals within this radius of the world centre.
 * Kept well inside the sector inner radius so the cluster and the sectors
 * don't fight for the same space. */
export const CENTER_CLUSTER_RADIUS = 120;

/** Position jitter applied to replicated planets, as a fraction of map size,
 * so mirrored/rotated sectors don't look mechanically identical. */
export const JITTER_FRACTION = 0.05;

/** Minimum edge-to-edge gap between two planets, as a multiple of the larger
 * planet's radius (spec: "≥ 1.5× the largest planet radius" — read per pair,
 * i.e. the larger of the two, which is what keeps 14–20 planets placeable in
 * the portrait world's inscribed circle). */
export const EDGE_GAP_FACTOR = 1.5;

/** Spec: no two planets closer than 44pt in screen space at the default
 * viewport. Converted to world units at a reference portrait phone (the
 * QUA-120 world→screen scale there is ~0.37); kept DOM-free as a constant. */
export const MIN_CENTER_DIST = 44 / 0.37;

/** Home planets must be equidistant from the world centre within this
 * tolerance (world units) — small, only to absorb float error since the
 * replication transforms are exact isometries. */
export const HOME_DIST_TOLERANCE = 1;

/** Per-planet placement retries within one attempt, and whole-map attempts
 * before giving up and reseeding-and-throwing. */
export const PLACEMENT_TRIES = 40;
export const MAX_MAP_ATTEMPTS = 50;
