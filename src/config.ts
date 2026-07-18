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
export const HOME_SIZE: Size = "medium";

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

// Map generation placement constraints
export const EDGE_MARGIN = 20;
export const PLANET_GAP = 30;
export const PAIR_COUNT = 5;
export const ATTEMPTS_PER_PAIR = 60;
