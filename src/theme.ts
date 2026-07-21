// Contour design-system tokens (QUA-127). Single source for every canvas
// color; the DOM mirror lives in index.html's :root variables — keep the two
// in sync by hand (same convention as the --sai-* insets, but in the other
// direction). Source of truth: docs/contour-design-system.html.
//
// DOM-free on purpose: importable anywhere, including future node-run tools.

import type { Owner, Spec } from "./config";

// ---- Core surface & text tokens ----
export const BG = "#0d2015";
export const BG_RAISE = "#112b1d";
export const LINE = "#1d4530";
export const LINE_DIM = "#173a28";
export const TXT = "#eafff0";
export const DIM = "#9db8a8";
export const INK = "#0d1420";

/** Full canvas font stack. Space Grotesk is loaded from Google Fonts in
 * index.html; offline the stack degrades to system-ui without layout jumps
 * big enough to matter (numerals are haloed either way). */
export const FONT = '"Space Grotesk", system-ui, sans-serif';

/** rgba() from a #rrggbb hex. Module-load helper only — the frame loop must
 * never build color strings; anything alpha-blended per frame is precomputed
 * below or uses globalAlpha. */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface OwnerTheme {
  /** Base identity color: zones, tracers, siege dots, hostile overdraw. */
  fill: string;
  /** Highlight: dart bodies, level pulses, arrival poofs, estimate text. */
  hi: string;
  /** Body gradient stops, light → dark across the silhouette. */
  grad: readonly [string, string];
  /** Ambient glow strength — the player pops, neutrals recede. */
  glowAlpha: number;
  /** Precomputed stroke so drawTracers never string-builds per frame. */
  tracerStroke: string;
}

function ownerTheme(fill: string, hi: string, grad: readonly [string, string], glowAlpha: number): OwnerTheme {
  return { fill, hi, grad, glowAlpha, tracerStroke: hexA(fill, 0.85) };
}

/** Five-owner palette. Game's ai1 is the spec's "enemy" (violet→magenta). */
export const OWNER: Record<Owner, OwnerTheme> = {
  player: ownerTheme("#7df0a5", "#a9ffcb", ["#a9ffcb", "#5ad98a"], 0.5),
  ai1: ownerTheme("#d94a97", "#f08ac2", ["#8b7cf7", "#d94a97"], 0.38),
  ai2: ownerTheme("#f2b04e", "#ffd08a", ["#ffd08a", "#e09a30"], 0.38),
  ai3: ownerTheme("#6fb8f0", "#a8d8ff", ["#a8d8ff", "#4f9ede"], 0.38),
  neutral: ownerTheme("#57806b", "#6a9480", ["#6a9480", "#3c5f4d"], 0.22),
};

export type PlanetShape = "circle" | "hex" | "ring" | "square";

/** The shape language (QUA-127, DECIDED): spec changes the silhouette so
 * types read at a glance and in peripheral vision — rim glyphs did not at
 * mobile sizes. */
export const SPEC_SHAPE: Record<Spec, PlanetShape> = {
  standard: "circle",
  defence: "hex",
  naval: "ring",
  economy: "square",
};
