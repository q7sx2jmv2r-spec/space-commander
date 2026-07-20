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

/** Send-amount steps the QUA-131 chip cycles through (must include the
 * SEND_FRACTION default). */
export const FRACTION_STEPS: readonly number[] = [0.25, 0.5, 1];

/** Visual/hit-test radius per size class. Also the basis of interception-zone
 * radii (QUA-129: zone = visual radius × zoneRadiusFactor), so this constant
 * is sim-affecting — change it and replays change. */
export const SIZE_RADIUS: Record<Size, number> = { small: 32, medium: 44, large: 56 };

// ---------------------------------------------------------------------------
// Interception zones (QUA-129). Owned planets project a circular zone that
// strips ships from enemy fleets flying through it, scaling with the live
// garrison, development level, and defence spec. Neutrals project none.
// ---------------------------------------------------------------------------

export const INTERCEPT = {
  /** Zone radius = SIZE_RADIUS[size] × this. */
  zoneRadiusFactor: 2.5,
  /** Ships/sec lost per (displayed) garrison ship — 5% of the garrison count
   * per second, per the spec's worked example. */
  damageRate: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Planet development (QUA-128). Planets level up the longer one owner holds
// them uninterrupted; capture resets to L1. Level scales production, the
// garrison cap, and interception strength (QUA-129). One tunable object per
// the ticket; arrays are indexed by level-1.
// ---------------------------------------------------------------------------

export const DEVELOPMENT = {
  /** Seconds of uninterrupted holding to reach L1/L2/L3. */
  levelTimes: [0, 90, 240],
  productionMult: [1, 1.5, 2],
  capMult: [1, 1.5, 2],
  /** Interception-zone damage scaling per level (consumed by QUA-129). */
  interceptMult: [1, 1.5, 2],
  /** Battle defender-strength scaling per level. Gentler than the other level
   * arrays because it multiplies into an already-stacked product
   * (× BATTLE.defenderBonus × the spec's defendMult): L3 defence would be
   * ×4.8 per ship at [1,1.5,2] — near-untouchable — vs ×3.6 here. */
  defendMult: [1, 1.25, 1.5],
} as const;

/** Base (L1) garrison cap per size — a SOFT cap: production halts at the cap,
 * but reinforcement and capture surpluses may exceed it and are never clamped
 * down (silently deleting arriving ships would be invisible loss). Roughly a
 * minute of unattended base production per size. */
export const GARRISON_CAP: Record<Size, number> = { small: 30, medium: 50, large: 80 };

// ---------------------------------------------------------------------------
// Planet specialisation (QUA-130). Level (QUA-128) is *how much*, spec is
// *what kind*: effects multiply with development. Converting costs ships and
// downtime so it's a commitment, not a free toggle mid-fight. Capture clears
// specialisation along with development.
// ---------------------------------------------------------------------------

export type Spec = "standard" | "defence" | "naval" | "economy";

export const SPECS = {
  /** Ships deducted from the garrison to start a conversion. */
  costShips: 15,
  /** Seconds of conversion downtime: no production, no spec bonuses. */
  convertTime: 10,
  /** Garrison defends at ×2; interception zone ×1.6 radius, ×2 damage. */
  defence: { defendMult: 2, zoneRadiusMult: 1.6, zoneDamageMult: 2 },
  /** Shipyard: ×1.5 production but a glass jaw on defence. */
  naval: { productionMult: 1.5, defendMult: 0.75 },
  /** Own production halves, but every economy planet adds +15% empire-wide
   * production (additive stacking). The greedy option you must protect. */
  economy: { productionMult: 0.5, empireBonus: 0.15 },
} as const;

// ---------------------------------------------------------------------------
// Ticked battles. Combat at a planet is a short fight over many ticks, not an
// instant trade: per tick each side inflicts
//   strength^exponent × rate × roll(rollMin–rollMax)  casualties/sec × dt,
// where defender strength = floor(garrison) × defenderBonus ×
// DEVELOPMENT.defendMult[level-1] × the spec's defendMult, and attacker
// strength is the raw pool size. The superlinear exponent makes lopsided
// attacks cheap and marginal attacks ruinous — the anti-snipe lever. If
// planets still revolve in playtests, raise exponent toward 1.3 or
// defenderBonus toward 1.3 before touching anything else.
// ---------------------------------------------------------------------------

export const BATTLE = {
  /** Superlinear strength exponent. */
  exponent: 1.2,
  /** Structural defender advantage: each garrison ship fights at this. */
  defenderBonus: 1.2,
  /** Casualties/sec per strength^exponent unit. 0.35 puts decisive fights at
   * ~60–120 ticks (30v20 ≈ 74) and near-ties at ~150–280. */
  rate: 0.35,
  /** Per-side per-tick roll bounds (seeded, keyed by tick + planet id). */
  rollMin: 0.9,
  rollMax: 1.1,
} as const;

// ---------------------------------------------------------------------------
// AI difficulty tiers (QUA-123). Pure data — ai.ts interprets these; adding a
// tier means adding a block here, never new logic. Tuned by hand in QUA-126.
// ---------------------------------------------------------------------------

export type AiTier = "easy" | "medium" | "hard";

export interface AiTierConfig {
  /** Seconds between decisions [min, max); jittered per decision via the
   * seeded PRNG. */
  interval: { min: number; max: number };
  /** Fraction of a source's garrison launched per attack send. */
  attackFraction: number;
  /** Fraction of a helper's garrison launched per reinforcement send. */
  reinforceFraction: number;
  /** Keep at least this fraction of a source's garrison at home. */
  reserveFraction: number;
  /** Target scoring: score = garrison·garrisonWeight + dist·distanceWeight;
   * lowest score wins (cheapest capture). */
  garrisonWeight: number;
  distanceWeight: number;
  /** Max sends issued in one decision (burst cap for large maps). */
  maxSendsPerDecision: number;
  /** Checks incoming hostile fleets and reinforces threatened planets. */
  reinforces: boolean;
  /** Refuses attacks that provably can't capture (garrison + production over
   * travel time); easy ships anyway — its mistakes are part of its charm. */
  checksFeasibility: boolean;
  /** Pools 2–3 source planets to take targets no single planet could. */
  combinesFleets: boolean;
  /** Prioritizes enemy planets that were just emptied by a big send. */
  countersEmptied: boolean;
  // --- QUA-132: zone awareness, specialisation strategy, valuation ---
  /** Reject any send whose predicted interception losses (predict.ts — the
   * same estimator as the player preview) exceed this fraction of the fleet. */
  maxAttritionFraction: number;
  /** Stage too-hot attacks through a friendly/capturable hop that shortens
   * the exposed final leg — hard's corridor game. */
  stagesHops: boolean;
  /** Converts planets (QUA-130): border → defence, interior → economy/naval. */
  usesSpecs: boolean;
  /** Re-converts planets whose desired spec changed as the border moved. */
  reconsidersSpecs: boolean;
  /** A planet is "border" when an enemy planet is among its k nearest. */
  borderNeighbors: number;
  /** Interior planets nearest the front to keep as Naval shipyards. */
  navalCount: number;
  /** Convert only when the garrison comfortably exceeds the 15-ship cost;
   * below it, the candidate planet is "groomed" — spared as an attack source
   * so it can bank production toward the conversion. */
  convertGarrisonMin: number;
  /** Specialisation also needs the empire's total planetside garrison at or
   * above this (affordability) — together with not being behind on planet
   * count (dominance), this keeps conversion taxes out of desperate fights. */
  specsMinEmpireGarrison: number;
  /** Target-score multiplier for enemy economy planets (<1 = juicier). */
  economyScoreFactor: number;
  /** Target-score multiplier for an L3 defence fortress when overwhelming
   * force isn't available (>1 = near-untouchable). */
  fortressScoreFactor: number;
  /** Additive score per target development level above 1 — favours the
   * low-level fringe of an enemy's territory over its developed core. */
  levelWeight: number;
}

export const AI_TIERS: Record<AiTier, AiTierConfig> = {
  easy: {
    interval: { min: 4, max: 6 },
    attackFraction: 0.5,
    reinforceFraction: 0,
    reserveFraction: 0,
    garrisonWeight: 1,
    distanceWeight: 1 / 150, // mostly nearest-first
    maxSendsPerDecision: 1,
    reinforces: false,
    checksFeasibility: false,
    combinesFleets: false,
    countersEmptied: false,
    maxAttritionFraction: 0.6, // will happily fly through moderate fire
    stagesHops: false,
    usesSpecs: false, // easy never converts
    reconsidersSpecs: false,
    borderNeighbors: 3,
    navalCount: 0,
    convertGarrisonMin: 20,
    specsMinEmpireGarrison: 50,
    economyScoreFactor: 1, // no spec/level awareness in easy's scoring
    fortressScoreFactor: 1,
    levelWeight: 0,
  },
  // Ticked battles retuned medium/hard (matchup-swept): the strength exponent
  // makes many thin sends self-destructive and rewards fewer, fatter punches,
  // so both tiers dropped to one larger send per decision; the conversion
  // gates rose because spec taxes paid mid-war bleed an empire that now needs
  // decisive force concentrations.
  medium: {
    interval: { min: 2, max: 3 },
    attackFraction: 0.6,
    reinforceFraction: 0.3,
    reserveFraction: 0.15,
    garrisonWeight: 1,
    distanceWeight: 1 / 100, // garrison/distance flavour: cheap AND close
    maxSendsPerDecision: 1,
    reinforces: true,
    checksFeasibility: true,
    combinesFleets: false,
    countersEmptied: false,
    maxAttritionFraction: 0.4,
    stagesHops: false, // medium re-targets rather than staging corridors
    usesSpecs: true,
    reconsidersSpecs: false,
    borderNeighbors: 3,
    navalCount: 1,
    convertGarrisonMin: 35,
    specsMinEmpireGarrison: 80,
    economyScoreFactor: 0.7,
    fortressScoreFactor: 4,
    levelWeight: 3,
  },
  hard: {
    interval: { min: 1, max: 2 },
    attackFraction: 0.7,
    reinforceFraction: 0.35,
    reserveFraction: 0.1,
    garrisonWeight: 1,
    distanceWeight: 1 / 100,
    maxSendsPerDecision: 1,
    reinforces: true,
    checksFeasibility: true,
    combinesFleets: true,
    countersEmptied: true,
    maxAttritionFraction: 0.25,
    stagesHops: true, // captures stepping stones toward a target
    usesSpecs: true,
    reconsidersSpecs: true,
    borderNeighbors: 3,
    navalCount: 2,
    convertGarrisonMin: 35,
    specsMinEmpireGarrison: 80,
    economyScoreFactor: 0.6,
    fortressScoreFactor: 8,
    levelWeight: 5,
  },
};

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
