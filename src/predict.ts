// Route-attrition prediction (QUA-129). The single shared estimator behind
// the player's trajectory preview (QUA-131) and the AI's zone-aware routing
// (QUA-132) — both must agree with each other, and closely with the sim.
//
// Closed-form: intersect the straight route with every hostile zone circle
// and charge zoneDps × crossing time. Garrisons, levels and specs are read
// as they are NOW and frozen, while the sim integrates them live tick by
// tick — so this is deliberately an estimate (label it as one in UI).
// DOM-free; deterministic (pure function of the state passed in).

import { BATTLE, SHIP_SPEED, TICK_DT } from "./config";
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

export interface BattlePrediction {
  attackerWins: boolean;
  /** Whole ships the winning side keeps (attacker survivors on a win, the
   * remaining garrison on a loss). */
  survivors: number;
  /** Battle length in sim ticks. */
  ticks: number;
}

/** Iteration cap: any real battle ends orders of magnitude sooner; this only
 * guards against pathological inputs (e.g. thousands vs thousands). */
const PREDICT_BATTLE_MAX_TICKS = 1200;

/** Predicted outcome of a battle at mean roll (1.0): the exact stepBattles
 * loop with the variance removed. `defenderMult` is the per-ship strength
 * multiplier from sim.defenderStrengthMult(planet), frozen at now like the
 * rest of the estimator. Shared by the drag-preview and the AI's attack
 * feasibility so the defender bonus is learnable, not hidden math. */
export function predictBattle(
  attackerShips: number,
  defenderGarrison: number,
  defenderMult: number
): BattlePrediction {
  let att = Math.floor(attackerShips);
  let gar = defenderGarrison;
  let attDamage = 0;
  let defDamage = 0;
  let t = 0;
  while (t < PREDICT_BATTLE_MAX_TICKS) {
    t += 1;
    const defStr = Math.floor(gar) * defenderMult;
    attDamage += Math.pow(defStr, BATTLE.exponent) * BATTLE.rate * TICK_DT;
    defDamage += Math.pow(att, BATTLE.exponent) * BATTLE.rate * TICK_DT;
    const attWhole = Math.floor(attDamage);
    if (attWhole > 0) {
      att = Math.max(0, att - attWhole);
      attDamage -= attWhole;
    }
    const defWhole = Math.floor(defDamage);
    if (defWhole > 0) {
      gar = Math.max(0, gar - defWhole);
      defDamage -= defWhole;
    }
    // Attacker checked first: mutual destruction is a defender hold at 0.
    if (att <= 0) return { attackerWins: false, survivors: Math.floor(gar), ticks: t };
    if (Math.floor(gar) <= 0) return { attackerWins: true, survivors: att, ticks: t };
  }
  // Cap hit (absurd inputs): call it for whoever holds more raw strength.
  const attackerWins = att > Math.floor(gar) * defenderMult;
  return { attackerWins, survivors: attackerWins ? att : Math.floor(gar), ticks: t };
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
