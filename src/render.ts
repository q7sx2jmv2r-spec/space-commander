// Rendering + coordinate mapping (QUA-120). Reads sim state, never writes it.
// The world→screen transform lives here and input.ts uses screenToWorld so
// there is exactly one mapping in the codebase.

import {
  GameState,
  Fleet,
  Owner,
  Planet,
  PLAYER,
  WORLD_W,
  WORLD_H,
  defenderStrengthMult,
  planetLevel,
  zoneRadius,
  zoneDps,
} from "./sim";
import { SIZE_RADIUS, SPECS, TICK_RATE } from "./config";
import { predictBattle, predictPath } from "./predict";
import type { InputView } from "./input";

const BG = "#0b0e1a";
// ai2/ai3 colors are reserved for QUA-123; distinguishable by brightness as
// well as hue.
const OWNER_FILL: Record<Owner, string> = {
  neutral: "#3a4060",
  player: "#1d4d80",
  ai1: "#802c2c",
  ai2: "#805a1d",
  ai3: "#5a2c80",
};
const OWNER_STROKE: Record<Owner, string> = {
  neutral: "#8b93b8",
  player: "#4da6ff",
  ai1: "#ff5d5d",
  ai2: "#ffb84d",
  ai3: "#c05dff",
};

/** Breathing room (css px) between the world edge and the safe area. */
const VIEW_MARGIN = 12;
/** Capture flash: expanding ring drawn for this long after an owner change. */
const FLASH_MS = 600;
/** Level-up pulse (QUA-128): shorter, thinner sibling of the capture flash. */
const LEVEL_PULSE_MS = 450;
/** Level pips (QUA-128): dot radius and angular spacing on the planet rim. */
const PIP_RADIUS = 4;
const PIP_ANGLE_STEP = 0.24;
/** Spec glyph half-size (QUA-130), drawn on the lower rim. */
const GLYPH = 5;
/** Total conversion downtime in ticks, for the radial progress sweep. */
const CONVERT_TICKS_TOTAL = Math.round(SPECS.convertTime * TICK_RATE);
/** Interception-zone ring alpha (QUA-129): subtle at rest, hot while firing. */
const ZONE_ALPHA_IDLE = 0.12;
const ZONE_ALPHA_FIRING = 0.4;
const TRACER_ALPHA = 0.55;
/** In-transit fleet death effect duration and ring-buffer size. */
const POOF_MS = 400;
const POOF_SLOTS = 16;
/** Battle impact rings: shorter, smaller poof siblings that fire where a side
 * lost a whole ship this tick. Fixed ring buffer, like poofs. */
const BATTLE_HIT_MS = 300;
const BATTLE_HIT_SLOTS = 24;
/** Besieger badge: distance beyond the planet rim, and the angular fan for
 * multiple queued pools (head pool at 12 o'clock, deterministic). */
const SIEGE_OFFSET = 26;
const SIEGE_ANGLE_STEP = 0.9;
/** Hostile stretches of the trajectory preview (QUA-131/129). */
const HOSTILE_COLOR = "#ff5d5d";
/** Passive enemy/neutral info tooltip lifetime (QUA-131). */
const TOOLTIP_MS = 1500;
/** Minimum on-screen garrison font (css px) so counters stay legible on
 * phones, where the world scale can shrink text below readability. */
const MIN_GARRISON_FONT = 14;
/** Fleet counts render at a fixed on-screen size... */
const FLEET_FONT = 11;
/** ...and are dropped entirely when the marker itself is this small (css px)
 * — at that point the count is unreadable noise. */
const MIN_FLEET_COUNT_RADIUS = 2.5;

/** Safe-area insets (css px), mirrored from env(safe-area-inset-*) via the
 * --sai-* custom properties set in index.html. Cached — getComputedStyle is
 * too expensive per frame — and refreshed on canvas resize, which covers
 * rotation (the only time insets change). */
const safeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function readInset(cs: CSSStyleDeclaration, prop: string): number {
  const v = Number.parseFloat(cs.getPropertyValue(prop));
  return Number.isFinite(v) ? v : 0;
}

function refreshSafeInsets(): void {
  const cs = getComputedStyle(document.documentElement);
  safeInsets.top = readInset(cs, "--sai-top");
  safeInsets.right = readInset(cs, "--sai-right");
  safeInsets.bottom = readInset(cs, "--sai-bottom");
  safeInsets.left = readInset(cs, "--sai-left");
}

export interface WorldTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// Dash patterns preallocated: setLineDash takes arrays and the draw loop must
// not allocate per frame. World-space values; visually stable enough across
// device scales that per-frame rescaling isn't worth it.
const AIM_DASH = [18, 14];
const BOX_DASH = [14, 10];
const NO_DASH: number[] = [];

// worldTransform returns this shared scratch object so the per-frame draw
// loop allocates nothing; callers must read it immediately, never retain it.
const scratchTransform: WorldTransform = { scale: 1, offsetX: 0, offsetY: 0 };

/** Uniform scale-to-fit of the logical world inside the screen's safe area
 * (css px), with a margin so nothing sits under notches or home indicators. */
export function worldTransform(cssW: number, cssH: number): WorldTransform {
  const availW = Math.max(1, cssW - safeInsets.left - safeInsets.right - 2 * VIEW_MARGIN);
  const availH = Math.max(1, cssH - safeInsets.top - safeInsets.bottom - 2 * VIEW_MARGIN);
  const scale = Math.min(availW / WORLD_W, availH / WORLD_H);
  scratchTransform.scale = scale;
  scratchTransform.offsetX = safeInsets.left + VIEW_MARGIN + (availW - WORLD_W * scale) / 2;
  scratchTransform.offsetY = safeInsets.top + VIEW_MARGIN + (availH - WORLD_H * scale) / 2;
  return scratchTransform;
}

export function screenToWorld(
  cssW: number,
  cssH: number,
  sx: number,
  sy: number
): { x: number; y: number } {
  const t = worldTransform(cssW, cssH);
  return { x: (sx - t.offsetX) / t.scale, y: (sy - t.offsetY) / t.scale };
}

export interface Renderer {
  render(
    prev: GameState,
    curr: GameState,
    alpha: number,
    fps: number,
    view: InputView
  ): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  const g = ctx;

  refreshSafeInsets();

  // Reused across frames (no per-frame allocation in the draw loop).
  const prevFleetById = new Map<number, Fleet>();

  // Interception visuals (QUA-129). `firing` marks planets whose zone holds a
  // hostile fleet this frame (brightens the ring); recomputed per frame from
  // interpolated fleet positions — a pure read, like every renderer diff.
  let firing: boolean[] = [];
  // Despawn poofs: fleets that vanished mid-flight (intercepted to zero).
  // Fixed ring buffer, no per-frame allocation.
  const poofX = new Float64Array(POOF_SLOTS);
  const poofY = new Float64Array(POOF_SLOTS);
  const poofAt = new Float64Array(POOF_SLOTS).fill(-1e9);
  let poofNext = 0;
  let lastPoofTick = -1;
  const currFleetIds = new Set<number>();

  // Battle impact rings: same fixed-ring-buffer pattern as poofs.
  const hitX = new Float64Array(BATTLE_HIT_SLOTS);
  const hitY = new Float64Array(BATTLE_HIT_SLOTS);
  const hitAt = new Float64Array(BATTLE_HIT_SLOTS).fill(-1e9);
  let hitNext = 0;
  let lastHitTick = -1;

  function spawnHit(x: number, y: number, now: number): void {
    hitX[hitNext] = x;
    hitY[hitNext] = y;
    hitAt[hitNext] = now;
    hitNext = (hitNext + 1) % BATTLE_HIT_SLOTS;
  }

  /** Where pool `index` of a siege sits: fanned around the rim from 12
   * o'clock. Deterministic and stable, so the badge doesn't jitter. */
  function siegeAngle(index: number): number {
    return -Math.PI / 2 + index * SIEGE_ANGLE_STEP;
  }

  /** Interpolated fleet position for this frame (matches drawFleets). */
  function fleetFramePos(
    curr: GameState,
    f: Fleet,
    alpha: number,
    out: { x: number; y: number; p: number }
  ): void {
    const pf = prevFleetById.get(f.id);
    const p = pf ? pf.progress + (f.progress - pf.progress) * alpha : f.progress;
    const origin = curr.planets[f.originId]!;
    const dest = curr.planets[f.destId]!;
    out.x = origin.x + (dest.x - origin.x) * p;
    out.y = origin.y + (dest.y - origin.y) * p;
    out.p = p;
  }
  const scratchPos = { x: 0, y: 0, p: 0 };

  /** Which zones are actively firing this frame (hostile fleet inside). */
  function updateFiring(curr: GameState, alpha: number): void {
    if (firing.length !== curr.planets.length) {
      firing = new Array<boolean>(curr.planets.length);
    }
    firing.fill(false);
    for (const f of curr.fleets) {
      if (f.progress >= 1) continue;
      fleetFramePos(curr, f, alpha, scratchPos);
      for (const p of curr.planets) {
        if (p.owner === "neutral" || p.owner === f.owner || firing[p.id]) continue;
        if (zoneDps(p) <= 0) continue;
        if (Math.hypot(p.x - scratchPos.x, p.y - scratchPos.y) <= zoneRadius(p)) {
          firing[p.id] = true;
        }
      }
    }
  }

  /** A fleet present last tick but gone now, short of arrival, was shot down
   * in transit: remember where for the fade-out poof. Runs once per sim tick
   * (prev/curr only change then), not per frame. */
  function updatePoofs(prev: GameState, curr: GameState, now: number): void {
    if (curr.tick < lastPoofTick) poofAt.fill(-1e9); // new game
    if (curr.tick === lastPoofTick) return;
    lastPoofTick = curr.tick;
    currFleetIds.clear();
    for (const f of curr.fleets) currFleetIds.add(f.id);
    for (const f of prev.fleets) {
      if (currFleetIds.has(f.id) || f.progress >= 0.98) continue;
      const origin = prev.planets[f.originId]!;
      const dest = prev.planets[f.destId]!;
      poofX[poofNext] = origin.x + (dest.x - origin.x) * f.progress;
      poofY[poofNext] = origin.y + (dest.y - origin.y) * f.progress;
      poofAt[poofNext] = now;
      poofNext = (poofNext + 1) % POOF_SLOTS;
    }
  }

  /** Spawn impact rings where a battle removed whole ships this tick: on the
   * planet rim when the garrison dropped (rim angle walked by tick — varied
   * but deterministic, no Math.random) and at the head pool's badge when the
   * attackers lost ships. Runs once per sim tick, like updatePoofs. */
  function updateBattleHits(prev: GameState, curr: GameState, now: number): void {
    if (curr.tick < lastHitTick) hitAt.fill(-1e9); // new game
    if (curr.tick === lastHitTick) return;
    lastHitTick = curr.tick;
    for (const b of curr.battles) {
      const p = curr.planets[b.planetId]!;
      const pp = prev.planets[b.planetId];
      const r = SIZE_RADIUS[p.size];
      if (pp && Math.floor(p.garrison) < Math.floor(pp.garrison)) {
        const a = (curr.tick * 2.4) % (Math.PI * 2);
        spawnHit(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, now);
      }
      const head = b.attackers[0];
      const pb = prev.battles.find((x) => x.planetId === b.planetId);
      if (head && pb) {
        const prevPool = pb.attackers.find((a) => a.owner === head.owner);
        if (prevPool && head.ships < prevPool.ships) {
          const a = siegeAngle(0);
          const d = r + SIEGE_OFFSET;
          spawnHit(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, now);
        }
      }
    }
  }

  // Capture-flash bookkeeping. Purely renderer-local — the sim has no
  // "recently captured" state; we detect owner changes by remembering what we
  // drew last frame. Indexed by planet id (== array index, stable per game).
  let flashOwners: Owner[] = [];
  let flashAt: number[] = [];
  // Level-up pulse (QUA-128): same diff-based pattern, keyed on the derived
  // level. Pulses only on an increase — the capture reset drops the level, and
  // the capture flash already covers that moment.
  let levelSeen: number[] = [];
  let levelPulseAt: number[] = [];
  let lastSeenTick = -1;

  function updateCaptureFlashes(curr: GameState, now: number): void {
    const n = curr.planets.length;
    // A tick going backwards means a new game started: re-baseline silently
    // so the initial ownership doesn't flash.
    if (flashOwners.length !== n || curr.tick < lastSeenTick) {
      flashOwners = new Array<Owner>(n);
      flashAt = new Array<number>(n).fill(-1e9);
      levelSeen = new Array<number>(n);
      levelPulseAt = new Array<number>(n).fill(-1e9);
      for (let i = 0; i < n; i++) {
        flashOwners[i] = curr.planets[i]!.owner;
        levelSeen[i] = planetLevel(curr.planets[i]!);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const owner = curr.planets[i]!.owner;
        if (owner !== flashOwners[i]) {
          flashOwners[i] = owner;
          flashAt[i] = now;
        }
        const level = planetLevel(curr.planets[i]!);
        if (level > levelSeen[i]!) levelPulseAt[i] = now;
        levelSeen[i] = level;
      }
    }
    lastSeenTick = curr.tick;
  }

  /** Match the canvas backing store to its CSS size × devicePixelRatio.
   * Called every frame: cheap when nothing changed, and it catches rotation
   * and mobile address-bar show/hide without relying on resize events. */
  function syncCanvasSize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      refreshSafeInsets();
    }
  }

  /** White text over a background-colored outline: keeps counters legible on
   * any owner color without resorting to a background box. Font size is in
   * world units (the current transform's). */
  function haloText(text: string, x: number, y: number, fontSize: number, fill = "#ffffff"): void {
    g.font = `bold ${fontSize}px system-ui, sans-serif`;
    g.lineJoin = "round";
    g.strokeStyle = BG;
    g.lineWidth = Math.max(3, fontSize / 5);
    g.strokeText(text, x, y);
    g.fillStyle = fill;
    g.fillText(text, x, y);
  }

  /** Interception-zone rings (QUA-129): always visible but subtle, in the
   * owner colour; brightened while the zone is actively firing. Drawn under
   * the planets. */
  function drawZones(curr: GameState, scale: number): void {
    for (const p of curr.planets) {
      const zr = zoneRadius(p);
      if (zr <= 0) continue;
      g.globalAlpha = firing[p.id] ? ZONE_ALPHA_FIRING : ZONE_ALPHA_IDLE;
      g.strokeStyle = OWNER_STROKE[p.owner];
      g.lineWidth = 1.5 / scale;
      g.beginPath();
      g.arc(p.x, p.y, zr, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** Tracer lines from each firing planet to the fleets it is hitting, so
   * interception losses read on screen. Drawn over fleets. */
  function drawTracers(curr: GameState, alpha: number, scale: number): void {
    g.globalAlpha = TRACER_ALPHA;
    g.lineWidth = 1.5 / scale;
    for (const f of curr.fleets) {
      if (f.progress >= 1) continue;
      fleetFramePos(curr, f, alpha, scratchPos);
      for (const p of curr.planets) {
        if (p.owner === "neutral" || p.owner === f.owner) continue;
        if (zoneDps(p) <= 0) continue;
        if (Math.hypot(p.x - scratchPos.x, p.y - scratchPos.y) > zoneRadius(p)) continue;
        g.strokeStyle = OWNER_STROKE[p.owner];
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(scratchPos.x, scratchPos.y);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  /** Besieging pools at embattled planets: a fleet-style badge per pool,
   * fanned around the rim, its count ticking down as the battle grinds.
   * Queued pools (pairwise rule — only attackers[0] fights) draw dimmed. */
  function drawBattles(curr: GameState, scale: number): void {
    for (const b of curr.battles) {
      const p = curr.planets[b.planetId]!;
      const pr = SIZE_RADIUS[p.size];
      for (let i = 0; i < b.attackers.length; i++) {
        const pool = b.attackers[i]!;
        const a = siegeAngle(i);
        const d = pr + SIEGE_OFFSET;
        const x = p.x + Math.cos(a) * d;
        const y = p.y + Math.sin(a) * d;
        const r = Math.min(16, 6 + 2 * Math.sqrt(pool.ships));
        g.fillStyle = OWNER_STROKE[pool.owner];
        if (i > 0) g.globalAlpha = 0.55;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        if (r * scale >= MIN_FLEET_COUNT_RADIUS) {
          g.textAlign = "center";
          g.textBaseline = "bottom";
          haloText(String(pool.ships), x, y - r - 4, FLEET_FONT / scale);
        }
      }
    }
  }

  /** Fade-out rings where battle casualties landed this tick: smaller,
   * shorter-lived poof siblings. */
  function drawBattleHits(now: number): void {
    for (let i = 0; i < BATTLE_HIT_SLOTS; i++) {
      const age = now - hitAt[i]!;
      if (age >= BATTLE_HIT_MS) continue;
      const t = age / BATTLE_HIT_MS;
      g.globalAlpha = 1 - t;
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1.5 * (1 - t);
      g.beginPath();
      g.arc(hitX[i]!, hitY[i]!, 3 + 10 * t, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** Fade-out rings where fleets were ground to zero in transit. */
  function drawPoofs(now: number): void {
    for (let i = 0; i < POOF_SLOTS; i++) {
      const age = now - poofAt[i]!;
      if (age >= POOF_MS) continue;
      const t = age / POOF_MS;
      g.globalAlpha = 1 - t;
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2 * (1 - t);
      g.beginPath();
      g.arc(poofX[i]!, poofY[i]!, 4 + 18 * t, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function drawPlanets(
    curr: GameState,
    selection: ReadonlySet<number>,
    scale: number,
    now: number
  ): void {
    for (const p of curr.planets) {
      const r = SIZE_RADIUS[p.size];
      g.fillStyle = OWNER_FILL[p.owner];
      g.strokeStyle = OWNER_STROKE[p.owner];
      g.lineWidth = 3;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      const flashAge = now - flashAt[p.id]!;
      if (flashAge < FLASH_MS) {
        const ft = flashAge / FLASH_MS;
        g.globalAlpha = 1 - ft;
        g.strokeStyle = OWNER_STROKE[p.owner];
        g.lineWidth = 2 + 6 * (1 - ft);
        g.beginPath();
        g.arc(p.x, p.y, r + 6 + 50 * ft, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }

      const pulseAge = now - levelPulseAt[p.id]!;
      if (pulseAge < LEVEL_PULSE_MS) {
        const pt = pulseAge / LEVEL_PULSE_MS;
        g.globalAlpha = 1 - pt;
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1.5 + 3 * (1 - pt);
        g.beginPath();
        g.arc(p.x, p.y, r + 4 + 30 * pt, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }

      if (selection.has(p.id)) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 4;
        g.beginPath();
        g.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
        g.stroke();
      }

      // Level pips (QUA-128): 1–3 notch dots on the upper rim — readable at a
      // glance on a phone, no text. Neutrals never develop, so no pips.
      if (p.owner !== "neutral") {
        const level = planetLevel(p);
        const start = -Math.PI / 2 - ((level - 1) / 2) * PIP_ANGLE_STEP;
        g.fillStyle = "#ffffff";
        for (let i = 0; i < level; i++) {
          const a = start + i * PIP_ANGLE_STEP;
          g.beginPath();
          g.arc(p.x + r * Math.cos(a), p.y + r * Math.sin(a), PIP_RADIUS, 0, Math.PI * 2);
          g.fill();
        }
      }

      drawSpecMarkers(p, r);

      // Font size floors at MIN_GARRISON_FONT css px regardless of world
      // scale — garrison counts must stay readable on small phone screens.
      const fontSize = Math.max(MIN_GARRISON_FONT / scale, r * 0.7);
      g.textAlign = "center";
      g.textBaseline = "middle";
      haloText(String(Math.floor(p.garrison)), p.x, p.y, fontSize);
    }
  }

  /** Specialisation identity (QUA-130): a white shape glyph on the lower rim
   * — shield (defence), chevron (naval), diamond (economy) — so types read by
   * shape, never colour alone. A converting planet keeps its old glyph (its
   * bonuses are equally stale) under a radial progress sweep. */
  function drawSpecMarkers(p: Planet, r: number): void {
    if (p.spec !== "standard") {
      const gx = p.x;
      const gy = p.y + r;
      g.fillStyle = "#ffffff";
      if (p.spec === "defence") {
        // Shield: flat top, point down.
        g.beginPath();
        g.moveTo(gx - GLYPH, gy - GLYPH * 0.8);
        g.lineTo(gx + GLYPH, gy - GLYPH * 0.8);
        g.lineTo(gx, gy + GLYPH);
        g.closePath();
        g.fill();
      } else if (p.spec === "naval") {
        // Chevron / wing.
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(gx - GLYPH, gy + GLYPH * 0.6);
        g.lineTo(gx, gy - GLYPH * 0.6);
        g.lineTo(gx + GLYPH, gy + GLYPH * 0.6);
        g.stroke();
      } else {
        // Economy: diamond.
        g.beginPath();
        g.moveTo(gx, gy - GLYPH);
        g.lineTo(gx + GLYPH, gy);
        g.lineTo(gx, gy + GLYPH);
        g.lineTo(gx - GLYPH, gy);
        g.closePath();
        g.fill();
      }
    }

    if (p.convertTicks > 0) {
      const frac = 1 - p.convertTicks / CONVERT_TICKS_TOTAL;
      g.strokeStyle = "#ffffff";
      g.lineWidth = 3;
      g.beginPath();
      g.arc(p.x, p.y, r + 4, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
      g.stroke();
    }
  }

  /** Live gesture feedback (QUA-122/131): trajectory preview while aiming a
   * drag-send — hostile-zone stretches highlighted and an estimated arrival
   * count when snapped to a target (QUA-129's learnability requirement) —
   * plus the dashed rubber-band rectangle while box-selecting. Allocates only
   * during an active drag, never in the steady-state loop. */
  function drawGestures(curr: GameState, view: InputView, scale: number): void {
    const drag = view.drag;
    if (!drag) return;
    if (drag.kind === "aim") {
      const target = drag.targetId >= 0 ? curr.planets[drag.targetId] : undefined;
      const ex = target ? target.x : drag.x;
      const ey = target ? target.y : drag.y;
      let survivors = 0;

      for (const id of view.selection) {
        const p = curr.planets[id];
        if (!p) continue;
        const ships = Math.floor(p.garrison * view.sendFraction);
        const pred = predictPath(curr, PLAYER, p.x, p.y, ex, ey, ships);
        survivors += pred.survivors;

        g.strokeStyle = OWNER_STROKE.player;
        g.lineWidth = 2 / scale;
        g.setLineDash(AIM_DASH);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(ex, ey);
        g.stroke();

        // Hostile stretches: solid hot overdraw on top of the dashed line.
        if (pred.segments.length > 0) {
          g.setLineDash(NO_DASH);
          g.strokeStyle = HOSTILE_COLOR;
          g.lineWidth = 3 / scale;
          for (const seg of pred.segments) {
            g.beginPath();
            g.moveTo(p.x + (ex - p.x) * seg.t0, p.y + (ey - p.y) * seg.t0);
            g.lineTo(p.x + (ex - p.x) * seg.t1, p.y + (ey - p.y) * seg.t1);
            g.stroke();
          }
        }
      }
      g.setLineDash(NO_DASH);
      g.fillStyle = OWNER_STROKE.player;
      g.beginPath();
      g.arc(ex, ey, 5 / scale, 0, Math.PI * 2);
      g.fill();

      // Outcome estimate at the snapped target — "~" marks it an estimate
      // (garrisons change in flight; everything is frozen at now). A friendly
      // target shows the arriving reinforcements; a hostile one runs the
      // mean-roll battle predictor so the defender bonus is learnable: a win
      // shows the expected post-battle survivors, a loss shows ✕.
      if (target) {
        g.textAlign = "center";
        g.textBaseline = "bottom";
        const ty = target.y - SIZE_RADIUS[target.size] - 10;
        const fontSize = Math.max(MIN_GARRISON_FONT / scale, 14);
        if (target.owner === PLAYER) {
          haloText(`~${survivors}`, target.x, ty, fontSize);
        } else {
          // Ships already besieging the target join the assault they'd land in.
          let pooled = survivors;
          const battle = curr.battles.find((b) => b.planetId === target.id);
          if (battle) {
            for (const pool of battle.attackers) {
              if (pool.owner === PLAYER) pooled += pool.ships;
            }
          }
          const outcome = predictBattle(
            pooled,
            Math.floor(target.garrison),
            defenderStrengthMult(target)
          );
          if (outcome.attackerWins) {
            haloText(`~${outcome.survivors}`, target.x, ty, fontSize);
          } else {
            haloText("✕", target.x, ty, fontSize, HOSTILE_COLOR);
          }
        }
      }
    } else {
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1.5 / scale;
      g.setLineDash(BOX_DASH);
      g.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
      g.setLineDash(NO_DASH);
    }
  }

  function drawFleets(curr: GameState, alpha: number, scale: number): void {
    for (const f of curr.fleets) {
      // Interpolate progress between ticks, then derive the position from the
      // (static) origin/dest planet centers — exact, no positional drift.
      const pf = prevFleetById.get(f.id);
      const p = pf ? pf.progress + (f.progress - pf.progress) * alpha : f.progress;
      const origin = curr.planets[f.originId]!;
      const dest = curr.planets[f.destId]!;
      const x = origin.x + (dest.x - origin.x) * p;
      const y = origin.y + (dest.y - origin.y) * p;
      const r = Math.min(16, 6 + 2 * Math.sqrt(f.ships));

      g.fillStyle = OWNER_STROKE[f.owner];
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();

      // Count only when the marker itself is visible enough for the number to
      // mean anything on screen; drawn at a fixed css size for legibility.
      if (r * scale >= MIN_FLEET_COUNT_RADIUS) {
        g.textAlign = "center";
        g.textBaseline = "bottom";
        haloText(String(f.ships), x, y - r - 4, FLEET_FONT / scale);
      }
    }
  }

  function render(
    prev: GameState,
    curr: GameState,
    alpha: number,
    fps: number,
    view: InputView
  ): void {
    syncCanvasSize();
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const now = performance.now();

    // prev-fleet index is shared by fleet interpolation, firing detection and
    // poof detection — build it once per frame, before any of them.
    prevFleetById.clear();
    for (const f of prev.fleets) prevFleetById.set(f.id, f);

    updateCaptureFlashes(curr, now);
    updatePoofs(prev, curr, now);
    updateBattleHits(prev, curr, now);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, cssW, cssH);

    const t = worldTransform(cssW, cssH);
    const scale = t.scale;
    g.translate(t.offsetX, t.offsetY);
    g.scale(scale, scale);

    g.strokeStyle = "#2a3150";
    g.lineWidth = 4;
    g.strokeRect(0, 0, WORLD_W, WORLD_H);

    updateFiring(curr, alpha);
    drawZones(curr, scale);
    drawPlanets(curr, view.selection, scale, now);
    drawBattles(curr, scale);
    drawFleets(curr, alpha, scale);
    drawTracers(curr, alpha, scale);
    drawPoofs(now);
    drawBattleHits(now);
    drawGestures(curr, view, scale);

    // Passive info tooltip from tapping an enemy/neutral planet (QUA-131):
    // garrison and level, display only, expires here.
    const tip = view.tooltip;
    if (tip && now - tip.shownAt < TOOLTIP_MS) {
      const p = curr.planets[tip.planetId];
      if (p) {
        g.textAlign = "center";
        g.textBaseline = "bottom";
        haloText(
          `${Math.floor(p.garrison)} · L${planetLevel(p)}`,
          p.x,
          p.y - SIZE_RADIUS[p.size] - 12,
          Math.max(MIN_GARRISON_FONT / scale, 14)
        );
      }
    }

    // HUD in screen space, tucked inside the safe area
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#8b93b8";
    g.font = "14px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "top";
    const hudX = safeInsets.left + 10;
    const hudY = safeInsets.top + 10;
    g.fillText(`${fps} fps`, hudX, hudY);
    g.fillText(`tick ${curr.tick}`, hudX, hudY + 18);
    g.fillText(`seed ${curr.seed}`, hudX, hudY + 36);
    // Game-over presentation is the DOM end panel (QUA-124), not the canvas.
  }

  return { render };
}
