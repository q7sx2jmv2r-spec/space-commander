// Rendering + coordinate mapping (QUA-120). Reads sim state, never writes it.
// The world→screen transform lives here and input.ts uses screenToWorld so
// there is exactly one mapping in the codebase.
//
// Visuals implement the Contour design system (QUA-127): topographic contour
// background + film grain, gradient planet bodies whose silhouette encodes
// the spec (circle/hex/ring/square), glowing dart fleets, and the five-owner
// mint/magenta/amber/ice/sage palette from src/theme.ts. Source of truth:
// docs/contour-design-system.html.

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
import { createRng, mixSeed, nextRange } from "./rng";
import { BG, DIM, FONT, LINE, LINE_DIM, OWNER, SPEC_SHAPE, TXT, hexA, PlanetShape } from "./theme";
import type { InputView } from "./input";

/** Owner → small-int encoding for the poof ring buffer's kind channel. */
const OWNER_INDEX: readonly Owner[] = ["player", "ai1", "ai2", "ai3", "neutral"];

/** Breathing room (css px) between the world edge and the safe area. */
const VIEW_MARGIN = 12;
/** Capture flash: expanding ring drawn for this long after an owner change. */
const FLASH_MS = 600;
/** Level-up pulse (QUA-128): shorter, thinner sibling of the capture flash. */
const LEVEL_PULSE_MS = 450;
/** Level pips (QUA-128): dot radius, orbit beyond the rim, and angular
 * spacing — the orbit clears every silhouette (hex reaches 1.08r < r+7). */
const PIP_RADIUS = 4;
const PIP_ORBIT = 7;
const PIP_ANGLE_STEP = 0.42;
/** Total conversion downtime in ticks, for the radial progress sweep. */
const CONVERT_TICKS_TOTAL = Math.round(SPECS.convertTime * TICK_RATE);
/** Interception-zone ring alpha (QUA-129): subtle at rest, hot while firing. */
const ZONE_ALPHA_IDLE = 0.18;
const ZONE_ALPHA_FIRING = 0.5;
/** Poofs: expanding rings where a fleet ended — white fade where one died in
 * transit, an owner-highlight ripple on the destination rim where one
 * arrived. Shared fixed ring buffer, like before. */
const POOF_MS = 450;
const POOF_SLOTS = 32;
/** Battle impact sparks: short white arc fragments that fire where a side
 * lost a whole ship this tick. Fixed ring buffer, like poofs. */
const BATTLE_HIT_MS = 300;
const BATTLE_HIT_SLOTS = 24;
/** Besieger dots: orbit distance beyond the planet rim, ring spacing for
 * queued pools, dot count/size, and orbit speed (rad/ms). */
const SIEGE_OFFSET = 26;
const SIEGE_RING_GAP = 12;
const SIEGE_DOTS = 5;
const SIEGE_DOT_RADIUS = 5;
const SIEGE_ORBIT_SPEED = 0.0014;
const SIEGE_ANGLE_STEP = 0.9;
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
/** Fullscreen film grain: tile size (device px) and per-pixel alpha. Kill
 * switch first if low-end frame times collapse; second fallback is baking the
 * grain into the cached contour layer so only the background is grained. */
const GRAIN_ENABLED = true;
const GRAIN_TILE = 128;
const GRAIN_ALPHA = 22;

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

// Dash scratch: setLineDash copies its argument, so one preallocated array
// mutated before each use keeps the draw loop allocation-free. Values are
// written in world units (css px ÷ scale) so dashes stay screen-consistent
// at any device scale. NO_DASH clears; CONVERT_DASH is planet-relative and
// deliberately fixed in world units.
const dashScratch: number[] = [0, 0];
const CONVERT_DASH = [6, 6];
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

  // Contour respects reduced motion: the marching-ants offset and siege-dot
  // orbits freeze; everything event-driven (flashes, poofs) stays.
  const reducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reused across frames (no per-frame allocation in the draw loop).
  const prevFleetById = new Map<number, Fleet>();

  // ---- Contour background layer (QUA-127) ----
  // The topographic rings replace a starfield. Generated once per
  // (seed, backing-store size) into an offscreen canvas at full resolution
  // and blitted each frame; ring geometry comes from a LOCAL rng derived via
  // mixSeed — state.rng is sim-only (determinism contract in rng.ts).
  const bgLayer = document.createElement("canvas");
  let bgSeed = -1;
  let bgW = -1;
  let bgH = -1;

  function regenBackground(seed: number, dpr: number, cssW: number, cssH: number): void {
    bgLayer.width = canvas.width;
    bgLayer.height = canvas.height;
    const b = bgLayer.getContext("2d");
    if (!b) return;
    b.fillStyle = BG;
    b.fillRect(0, 0, bgLayer.width, bgLayer.height);

    const t = worldTransform(cssW, cssH);
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.translate(t.offsetX, t.offsetY);
    b.scale(t.scale, t.scale);

    b.save();
    b.beginPath();
    b.rect(0, 0, WORLD_W, WORLD_H);
    b.clip();
    const rng = createRng(mixSeed(seed, 0xc0709));
    b.lineWidth = 2.5 / t.scale;
    for (let i = 0; i < 6; i++) {
      const ax = nextRange(rng, 0, WORLD_W);
      const ay = nextRange(rng, 0, WORLD_H);
      const rings = 2 + Math.floor(nextRange(rng, 0, 3));
      const step = nextRange(rng, 80, 130);
      const phase = nextRange(rng, 0, Math.PI * 2);
      const squash = nextRange(rng, 0.7, 1);
      for (let k = 1; k <= rings; k++) {
        b.strokeStyle = k % 2 ? LINE : LINE_DIM;
        b.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.08) {
          const rr = step * k + 22 * Math.sin(a * 3 + phase + k) + 14 * Math.sin(a * 5 + k);
          const px = ax + Math.cos(a) * rr;
          const py = ay + Math.sin(a) * rr * squash;
          if (a === 0) b.moveTo(px, py);
          else b.lineTo(px, py);
        }
        b.closePath();
        b.stroke();
      }
    }
    b.restore();

    b.strokeStyle = LINE;
    b.lineWidth = 2.5 / t.scale;
    b.strokeRect(0, 0, WORLD_W, WORLD_H);
  }

  // Film grain: a small noise tile repeated over the whole frame as the very
  // last draw, at identity transform so the grain is per DEVICE pixel — the
  // film look survives any DPR. Math.random is fine here: purely visual,
  // never touches the sim.
  let grainPattern: CanvasPattern | null = null;

  function ensureGrain(): void {
    if (grainPattern) return;
    const tile = document.createElement("canvas");
    tile.width = GRAIN_TILE;
    tile.height = GRAIN_TILE;
    const tg = tile.getContext("2d");
    if (!tg) return;
    const im = tg.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() * 255;
      im.data[i] = v;
      im.data[i + 1] = v;
      im.data[i + 2] = v;
      im.data[i + 3] = GRAIN_ALPHA;
    }
    tg.putImageData(im, 0, 0);
    grainPattern = g.createPattern(tile, "repeat");
  }

  // Body/glow gradients are position-independent (defined in planet-local
  // coordinates under translate), so they cache per owner|radius — the spec
  // file allocates per call, but this draw loop must not allocate per frame.
  const bodyGrads = new Map<string, CanvasGradient>();
  const glowGrads = new Map<string, CanvasGradient>();

  function bodyGrad(owner: Owner, r: number): CanvasGradient {
    const key = `${owner}|${r}`;
    let grad = bodyGrads.get(key);
    if (!grad) {
      const o = OWNER[owner];
      grad = g.createLinearGradient(-r, -r, r, r);
      grad.addColorStop(0, o.grad[0]);
      grad.addColorStop(1, o.grad[1]);
      bodyGrads.set(key, grad);
    }
    return grad;
  }

  function glowGrad(owner: Owner, r: number): CanvasGradient {
    const key = `${owner}|${r}`;
    let grad = glowGrads.get(key);
    if (!grad) {
      const o = OWNER[owner];
      grad = g.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2);
      grad.addColorStop(0, hexA(o.fill, o.glowAlpha));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      glowGrads.set(key, grad);
    }
    return grad;
  }

  /** Trace a planet silhouette as a path in planet-local coordinates (caller
   * has translated to the centre). "ring" bodies are circles — the Saturn
   * ring itself is strokeRing, drawn after the fill. */
  function traceShape(r: number, shape: PlanetShape): void {
    if (shape === "hex") {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const px = Math.cos(a) * r * 1.08;
        const py = Math.sin(a) * r * 1.08;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
    } else if (shape === "square") {
      // Manual rounded rect: roundRect is still patchy in TS lib/browsers.
      const s = r * 0.92;
      const cr = r * 0.34;
      g.moveTo(-s + cr, -s);
      g.lineTo(s - cr, -s);
      g.arcTo(s, -s, s, -s + cr, cr);
      g.lineTo(s, s - cr);
      g.arcTo(s, s, s - cr, s, cr);
      g.lineTo(-s + cr, s);
      g.arcTo(-s, s, -s, s - cr, cr);
      g.lineTo(-s, -s + cr);
      g.arcTo(-s, -s, -s + cr, -s, cr);
      g.closePath();
    } else {
      g.arc(0, 0, r, 0, Math.PI * 2);
    }
  }

  /** Saturn ring for naval planets, in planet-local coordinates: a bright
   * owner-highlight ellipse split by a thin background-colour line. */
  function strokeRing(owner: Owner, r: number): void {
    const o = OWNER[owner];
    g.strokeStyle = o.hi;
    g.globalAlpha = 0.9;
    g.lineWidth = 6;
    g.beginPath();
    g.ellipse(0, 0, r * 1.6, r * 0.52, -0.35, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = BG;
    g.globalAlpha = 0.6;
    g.lineWidth = 1.5;
    g.beginPath();
    g.ellipse(0, 0, r * 1.6, r * 0.52, -0.35, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  // Interception visuals (QUA-129). `firing` marks planets whose zone holds a
  // hostile fleet this frame (brightens the ring); recomputed per frame from
  // interpolated fleet positions — a pure read, like every renderer diff.
  let firing: boolean[] = [];
  // Poofs: fleets that ended mid-flight (intercepted to zero → white fade) or
  // arrived (owner ripple on the destination rim). Fixed ring buffer with a
  // kind channel (owner index, -1 = death) and a base radius channel.
  const poofX = new Float64Array(POOF_SLOTS);
  const poofY = new Float64Array(POOF_SLOTS);
  const poofAt = new Float64Array(POOF_SLOTS).fill(-1e9);
  const poofKind = new Int8Array(POOF_SLOTS);
  const poofR = new Float64Array(POOF_SLOTS);
  let poofNext = 0;
  let lastPoofTick = -1;
  const currFleetIds = new Set<number>();

  // Battle impact sparks: same fixed-ring-buffer pattern as poofs.
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

  /** Where pool `index` of a siege anchors: fanned around the rim from 12
   * o'clock. Deterministic and stable, so counts don't jitter. */
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

  /** A fleet present last tick but gone now either arrived (progress ≥ 0.98:
   * owner ripple at the destination) or was shot down in transit (white fade
   * where it died). Runs once per sim tick (prev/curr only change then), not
   * per frame. */
  function updatePoofs(prev: GameState, curr: GameState, now: number): void {
    if (curr.tick < lastPoofTick) poofAt.fill(-1e9); // new game
    if (curr.tick === lastPoofTick) return;
    lastPoofTick = curr.tick;
    currFleetIds.clear();
    for (const f of curr.fleets) currFleetIds.add(f.id);
    for (const f of prev.fleets) {
      if (currFleetIds.has(f.id)) continue;
      const origin = prev.planets[f.originId]!;
      const dest = prev.planets[f.destId]!;
      if (f.progress >= 0.98) {
        poofX[poofNext] = dest.x;
        poofY[poofNext] = dest.y;
        poofKind[poofNext] = OWNER_INDEX.indexOf(f.owner);
        poofR[poofNext] = SIZE_RADIUS[dest.size];
      } else {
        poofX[poofNext] = origin.x + (dest.x - origin.x) * f.progress;
        poofY[poofNext] = origin.y + (dest.y - origin.y) * f.progress;
        poofKind[poofNext] = -1;
        poofR[poofNext] = 4;
      }
      poofAt[poofNext] = now;
      poofNext = (poofNext + 1) % POOF_SLOTS;
    }
  }

  /** Spawn impact sparks where a battle removed whole ships this tick: on the
   * planet rim when the garrison dropped (rim angle walked by tick — varied
   * but deterministic, no Math.random) and at the head pool's anchor when the
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

  /** Text over a background-colour halo stroke (Contour numeral treatment):
   * keeps counters legible on any owner colour, glow, or contour line without
   * a background box. Font size is in world units (the current transform's). */
  function haloText(text: string, x: number, y: number, fontSize: number, fill = TXT): void {
    g.font = `700 ${fontSize}px ${FONT}`;
    g.lineJoin = "round";
    g.strokeStyle = BG;
    g.lineWidth = Math.max(3, fontSize / 5);
    g.strokeText(text, x, y);
    g.fillStyle = fill;
    g.fillText(text, x, y);
  }

  /** Interception-zone rings (QUA-129): dashed, in the owner colour, subtle
   * at rest and brightened while the zone is actively firing. Drawn under
   * the planets. */
  function drawZones(curr: GameState, scale: number): void {
    dashScratch[0] = 3 / scale;
    dashScratch[1] = 8 / scale;
    g.setLineDash(dashScratch);
    g.lineWidth = 2.5 / scale;
    for (const p of curr.planets) {
      const zr = zoneRadius(p);
      if (zr <= 0) continue;
      g.globalAlpha = firing[p.id] ? ZONE_ALPHA_FIRING : ZONE_ALPHA_IDLE;
      g.strokeStyle = OWNER[p.owner].fill;
      g.beginPath();
      g.arc(p.x, p.y, zr, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash(NO_DASH);
    g.globalAlpha = 1;
  }

  /** Tracer lines from each firing planet to the fleets it is hitting, so
   * interception losses read on screen. Drawn over fleets. */
  function drawTracers(curr: GameState, alpha: number, scale: number): void {
    g.lineWidth = 2.5 / scale;
    for (const f of curr.fleets) {
      if (f.progress >= 1) continue;
      fleetFramePos(curr, f, alpha, scratchPos);
      for (const p of curr.planets) {
        if (p.owner === "neutral" || p.owner === f.owner) continue;
        if (zoneDps(p) <= 0) continue;
        if (Math.hypot(p.x - scratchPos.x, p.y - scratchPos.y) > zoneRadius(p)) continue;
        g.strokeStyle = OWNER[p.owner].tracerStroke;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(scratchPos.x, scratchPos.y);
        g.stroke();
      }
    }
  }

  /** Besieging pools at embattled planets: rings of orbiting attacker dots in
   * the pool owner's colour, the head pool closest to the rim and queued
   * pools (pairwise rule — only attackers[0] fights) farther out and dimmed,
   * each with a halo pool count at its stable fan anchor. */
  function drawBattles(curr: GameState, scale: number, now: number): void {
    const orbit = reducedMotion ? 0 : now * SIEGE_ORBIT_SPEED;
    for (const b of curr.battles) {
      const p = curr.planets[b.planetId]!;
      const pr = SIZE_RADIUS[p.size];
      for (let i = 0; i < b.attackers.length; i++) {
        const pool = b.attackers[i]!;
        const d = pr + SIEGE_OFFSET + i * SIEGE_RING_GAP;
        if (i > 0) g.globalAlpha = 0.55;
        g.fillStyle = OWNER[pool.owner].fill;
        for (let k = 0; k < SIEGE_DOTS; k++) {
          const a = siegeAngle(i) + orbit + (k * Math.PI * 2) / SIEGE_DOTS;
          g.beginPath();
          g.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, SIEGE_DOT_RADIUS, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        if (SIEGE_DOT_RADIUS * scale >= MIN_FLEET_COUNT_RADIUS) {
          const a = siegeAngle(i);
          const x = p.x + Math.cos(a) * (d + SIEGE_RING_GAP);
          const y = p.y + Math.sin(a) * (d + SIEGE_RING_GAP);
          g.textAlign = "center";
          g.textBaseline = "bottom";
          haloText(String(pool.ships), x, y, FLEET_FONT / scale, OWNER[pool.owner].hi);
        }
      }
    }
  }

  /** Short white arc sparks where battle casualties landed this tick. */
  function drawBattleHits(now: number): void {
    for (let i = 0; i < BATTLE_HIT_SLOTS; i++) {
      const age = now - hitAt[i]!;
      if (age >= BATTLE_HIT_MS) continue;
      const t = age / BATTLE_HIT_MS;
      g.globalAlpha = 1 - t;
      g.strokeStyle = TXT;
      g.lineWidth = 2 * (1 - t) + 0.5;
      const rr = 4 + 12 * t;
      for (let k = 0; k < 3; k++) {
        const a = i * 2.1 + 0.5 + k * ((Math.PI * 2) / 3);
        g.beginPath();
        g.arc(hitX[i]!, hitY[i]!, rr, a - 0.25, a + 0.25);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }

  /** Fade-out rings where fleets ended: white where one died in transit, an
   * owner-highlight ripple on the destination rim where one arrived. */
  function drawPoofs(now: number): void {
    for (let i = 0; i < POOF_SLOTS; i++) {
      const age = now - poofAt[i]!;
      if (age >= POOF_MS) continue;
      const t = age / POOF_MS;
      const kind = poofKind[i]!;
      if (kind < 0) {
        g.globalAlpha = (1 - t) * 0.85;
        g.strokeStyle = TXT;
        g.lineWidth = 2 * (1 - t);
        g.beginPath();
        g.arc(poofX[i]!, poofY[i]!, 4 + 18 * t, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.globalAlpha = 1 - t;
        g.strokeStyle = OWNER[OWNER_INDEX[kind]!].hi;
        g.lineWidth = 4 * (1 - t) + 0.5;
        g.beginPath();
        g.arc(poofX[i]!, poofY[i]!, poofR[i]! * (1 + 0.9 * t), 0, Math.PI * 2);
        g.stroke();
      }
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
      const shape = SPEC_SHAPE[p.spec];

      // Glow halo + gradient body + (naval) Saturn ring, in local coords.
      g.save();
      g.translate(p.x, p.y);
      g.fillStyle = glowGrad(p.owner, r);
      g.beginPath();
      g.arc(0, 0, r * 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = bodyGrad(p.owner, r);
      g.beginPath();
      traceShape(r, shape);
      g.fill();
      if (shape === "ring") strokeRing(p.owner, r);
      g.restore();

      const flashAge = now - flashAt[p.id]!;
      if (flashAge < FLASH_MS) {
        const ft = flashAge / FLASH_MS;
        g.globalAlpha = 1 - ft;
        g.strokeStyle = TXT;
        g.lineWidth = 5;
        g.beginPath();
        g.arc(p.x, p.y, r + ft * 34, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }

      const pulseAge = now - levelPulseAt[p.id]!;
      if (pulseAge < LEVEL_PULSE_MS) {
        const pt = pulseAge / LEVEL_PULSE_MS;
        g.globalAlpha = 1 - pt;
        g.strokeStyle = OWNER[p.owner].hi;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(p.x, p.y, r + 4 + pt * 22, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }

      if (selection.has(p.id)) {
        g.strokeStyle = TXT;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
        g.stroke();
      }

      // Level pips (QUA-128): 1–3 dots just past the rim — readable at a
      // glance on a phone, no text, and clear of every silhouette. Neutrals
      // never develop, so no pips.
      if (p.owner !== "neutral") {
        const level = planetLevel(p);
        const start = -Math.PI / 2 - ((level - 1) / 2) * PIP_ANGLE_STEP;
        g.fillStyle = TXT;
        for (let i = 0; i < level; i++) {
          const a = start + i * PIP_ANGLE_STEP;
          const d = r + PIP_ORBIT;
          g.beginPath();
          g.arc(p.x + d * Math.cos(a), p.y + d * Math.sin(a), PIP_RADIUS, 0, Math.PI * 2);
          g.fill();
        }
      }

      drawConversion(p, r);

      // Font size floors at MIN_GARRISON_FONT css px regardless of world
      // scale — garrison counts must stay readable on small phone screens.
      const fontSize = Math.max(MIN_GARRISON_FONT / scale, r * 0.7);
      g.textAlign = "center";
      g.textBaseline = "middle";
      haloText(String(Math.floor(p.garrison)), p.x, p.y, fontSize);
    }
  }

  /** Conversion feedback (QUA-130/127): the body keeps the OLD silhouette
   * while converting (its bonuses are equally stale — sim truth), under a
   * radial progress sweep plus a dashed preview of the silhouette it is
   * becoming. Spec identity itself needs no marker any more: the shape IS
   * the spec. */
  function drawConversion(p: Planet, r: number): void {
    if (p.convertTicks <= 0) return;
    const frac = 1 - p.convertTicks / CONVERT_TICKS_TOTAL;
    g.strokeStyle = TXT;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(p.x, p.y, r + 4, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
    g.stroke();

    const target = SPEC_SHAPE[p.nextSpec];
    g.save();
    g.translate(p.x, p.y);
    g.globalAlpha = 0.6;
    g.strokeStyle = OWNER[p.owner].hi;
    g.lineWidth = 2.5;
    g.setLineDash(CONVERT_DASH);
    g.beginPath();
    traceShape(r * 1.18, target === "ring" ? "circle" : target);
    g.stroke();
    if (target === "ring") {
      g.beginPath();
      g.ellipse(0, 0, r * 1.6, r * 0.52, -0.35, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash(NO_DASH);
    g.globalAlpha = 1;
    g.restore();
  }

  /** Live gesture feedback (QUA-122/131): trajectory preview while aiming a
   * drag-send — marching-ants dashed route, hostile-zone stretches overdrawn
   * solid in the zone owner's colour, a snap ring and an estimated arrival
   * count when snapped to a target (QUA-129's learnability requirement) —
   * plus the dashed rubber-band rectangle while box-selecting. Allocates only
   * during an active drag, never in the steady-state loop. */
  function drawGestures(curr: GameState, view: InputView, scale: number, now: number): void {
    const drag = view.drag;
    if (!drag) return;
    if (drag.kind === "aim") {
      const target = drag.targetId >= 0 ? curr.planets[drag.targetId] : undefined;
      const ex = target ? target.x : drag.x;
      const ey = target ? target.y : drag.y;
      let survivors = 0;

      dashScratch[0] = 4 / scale;
      dashScratch[1] = 14 / scale;
      for (const id of view.selection) {
        const p = curr.planets[id];
        if (!p) continue;
        const ships = Math.floor(p.garrison * view.sendFraction);
        const pred = predictPath(curr, PLAYER, p.x, p.y, ex, ey, ships);
        survivors += pred.survivors;

        g.strokeStyle = OWNER.player.fill;
        g.globalAlpha = 0.8;
        g.lineWidth = 3.5 / scale;
        g.setLineDash(dashScratch);
        g.lineDashOffset = reducedMotion ? 0 : -(now * 0.04) / scale;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(ex, ey);
        g.stroke();
        g.lineDashOffset = 0;
        g.globalAlpha = 1;

        // Hostile stretches: solid overdraw in each zone owner's colour.
        if (pred.segments.length > 0) {
          g.setLineDash(NO_DASH);
          g.lineWidth = 5 / scale;
          for (const seg of pred.segments) {
            g.strokeStyle = OWNER[seg.owner].fill;
            g.beginPath();
            g.moveTo(p.x + (ex - p.x) * seg.t0, p.y + (ey - p.y) * seg.t0);
            g.lineTo(p.x + (ex - p.x) * seg.t1, p.y + (ey - p.y) * seg.t1);
            g.stroke();
          }
          g.setLineDash(dashScratch);
        }
      }
      g.setLineDash(NO_DASH);
      g.fillStyle = OWNER.player.fill;
      g.beginPath();
      g.arc(ex, ey, 5 / scale, 0, Math.PI * 2);
      g.fill();

      // Snap ring + outcome estimate at the snapped target — "~" marks it an
      // estimate (garrisons change in flight; everything is frozen at now).
      // A friendly target shows the arriving reinforcements; a hostile one
      // runs the mean-roll battle predictor so the defender bonus is
      // learnable: a win shows the expected survivors, a loss shows ✕.
      if (target) {
        g.strokeStyle = TXT;
        g.lineWidth = 2.5 / scale;
        g.beginPath();
        g.arc(target.x, target.y, SIZE_RADIUS[target.size] + 12, 0, Math.PI * 2);
        g.stroke();

        g.textAlign = "center";
        g.textBaseline = "bottom";
        const ty = target.y - SIZE_RADIUS[target.size] - 16;
        const fontSize = Math.max(MIN_GARRISON_FONT / scale, 14);
        if (target.owner === PLAYER) {
          haloText(`~${survivors}`, target.x, ty, fontSize, OWNER.player.hi);
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
            haloText(`~${outcome.survivors}`, target.x, ty, fontSize, OWNER.player.hi);
          } else {
            haloText("✕", target.x, ty, fontSize, OWNER[target.owner].fill);
          }
        }
      }
    } else {
      dashScratch[0] = 4 / scale;
      dashScratch[1] = 10 / scale;
      g.strokeStyle = TXT;
      g.lineWidth = 1.5 / scale;
      g.setLineDash(dashScratch);
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
      const ang = Math.atan2(dest.y - origin.y, dest.x - origin.x);
      // Dart scaled by ship count so size still encodes payload.
      const k = Math.min(1.6, Math.max(0.8, (6 + 2 * Math.sqrt(f.ships)) / 12));
      const o = OWNER[f.owner];

      g.save();
      g.translate(x, y);
      g.rotate(ang);
      g.scale(k, k);
      // shadowBlur ignores the CTM — the glow is ~14 device-ish px at any
      // world scale, which is exactly the screen-consistent halo we want.
      g.shadowColor = o.fill;
      g.shadowBlur = 14;
      g.fillStyle = o.hi;
      g.beginPath();
      g.moveTo(15, 0);
      g.lineTo(-10, 9);
      g.lineTo(-5, 0);
      g.lineTo(-10, -9);
      g.closePath();
      g.fill();
      g.restore();

      // Count only when the marker itself is visible enough for the number to
      // mean anything on screen; drawn at a fixed css size for legibility.
      if (9 * k * scale >= MIN_FLEET_COUNT_RADIUS) {
        g.textAlign = "center";
        g.textBaseline = "bottom";
        haloText(String(f.ships), x, y - 9 * k - 5, FLEET_FONT / scale);
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

    // Contour background: cached full-resolution layer, regenerated only
    // when the seed or backing-store size changes.
    if (bgSeed !== curr.seed || bgW !== canvas.width || bgH !== canvas.height) {
      regenBackground(curr.seed, dpr, cssW, cssH);
      bgSeed = curr.seed;
      bgW = canvas.width;
      bgH = canvas.height;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bgLayer, 0, 0);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = worldTransform(cssW, cssH);
    const scale = t.scale;
    g.translate(t.offsetX, t.offsetY);
    g.scale(scale, scale);

    updateFiring(curr, alpha);
    drawZones(curr, scale);
    drawPlanets(curr, view.selection, scale, now);
    drawBattles(curr, scale, now);
    drawFleets(curr, alpha, scale);
    drawTracers(curr, alpha, scale);
    drawPoofs(now);
    drawBattleHits(now);
    drawGestures(curr, view, scale, now);

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
    g.fillStyle = DIM;
    g.font = `500 13px ${FONT}`;
    g.textAlign = "left";
    g.textBaseline = "top";
    const hudX = safeInsets.left + 10;
    const hudY = safeInsets.top + 10;
    g.fillText(`${fps} fps`, hudX, hudY);
    g.fillText(`tick ${curr.tick}`, hudX, hudY + 18);
    g.fillText(`seed ${curr.seed}`, hudX, hudY + 36);
    // Game-over presentation is the DOM end panel (QUA-124), not the canvas.

    // Film grain last, over everything, per device pixel.
    if (GRAIN_ENABLED) {
      ensureGrain();
      if (grainPattern) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = grainPattern;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  return { render };
}
