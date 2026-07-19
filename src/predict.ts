// Route-attrition prediction (QUA-129). The single shared estimator behind
// the player's trajectory preview (QUA-131) and the AI's zone-aware routing
// (QUA-132) — both must agree with each other, and closely with the sim.
//
// Closed-form: intersect the straight route with every hostile zone circle
// and charge zoneDps × crossing time. Garrisons, levels and specs are read
// as they are NOW and frozen, while the sim integrates them live tick by
// tick — so this is deliberately an estimate (label it as one in UI).
// DOM-free; deterministic (pure function of the state passed in).

import { SHIP_SPEED } from "./config";
import { GameState, Owner, zoneRadius, zoneDps } from "./sim";

/** A hostile stretch of the route, as fractions of the full path (0..1). */
export interface HostileSegment {
  t0: number;
  t1: number;
}

export interface RoutePrediction {
  /** Estimated ships lost in transit (fractional). */
  losses: number;
  /** Estimated whole ships arriving: max(0, floor(ships - losses)). */
  survivors: number;
  /** Hostile-zone stretches for preview highlighting, in planet array order
   * (overlapping zones each contribute their own segment). */
  segments: HostileSegment[];
}

/** Predict attrition for `ships` of `owner` flying the straight line
 * (x0,y0)→(x1,y1) at SHIP_SPEED, from current garrisons/levels/specs. */
export function predictPath(
  state: GameState,
  owner: Owner,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ships: number
): RoutePrediction {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  let losses = 0;
  const segments: HostileSegment[] = [];

  if (len > 0) {
    for (const p of state.planets) {
      if (p.owner === "neutral" || p.owner === owner) continue;
      const dps = zoneDps(p);
      if (dps <= 0) continue; // emptied garrison: zone inflicts nothing
      const r = zoneRadius(p);
      // Solve |(x0,y0) + t·(dx,dy) − centre|² = r² for t, clamp to [0,1].
      const fx = x0 - p.x;
      const fy = y0 - p.y;
      const a = dx * dx + dy * dy;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - r * r;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      const t0 = Math.max(0, (-b - sq) / (2 * a));
      const t1 = Math.min(1, (-b + sq) / (2 * a));
      if (t1 <= t0) continue;
      losses += (dps * (t1 - t0) * len) / SHIP_SPEED;
      segments.push({ t0, t1 });
    }
  }

  return { losses, survivors: Math.max(0, Math.floor(ships - losses)), segments };
}

/** predictPath between two planets' centres — the common send-shaped case. */
export function predictRoute(
  state: GameState,
  owner: Owner,
  fromId: number,
  toId: number,
  ships: number
): RoutePrediction {
  const a = state.planets[fromId]!;
  const b = state.planets[toId]!;
  return predictPath(state, owner, a.x, a.y, b.x, b.y, ships);
}
