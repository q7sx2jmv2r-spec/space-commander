// Rendering + coordinate mapping (QUA-120). Reads sim state, never writes it.
// The world→screen transform lives here and input.ts uses screenToWorld so
// there is exactly one mapping in the codebase.

import { GameState, Fleet, Owner, WORLD_W, WORLD_H } from "./sim";
import { SIZE_RADIUS } from "./config";

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
    selection: ReadonlySet<number>
  ): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  const g = ctx;

  refreshSafeInsets();

  // Reused across frames (no per-frame allocation in the draw loop).
  const prevFleetById = new Map<number, Fleet>();

  // Capture-flash bookkeeping. Purely renderer-local — the sim has no
  // "recently captured" state; we detect owner changes by remembering what we
  // drew last frame. Indexed by planet id (== array index, stable per game).
  let flashOwners: Owner[] = [];
  let flashAt: number[] = [];
  let lastSeenTick = -1;

  function updateCaptureFlashes(curr: GameState, now: number): void {
    const n = curr.planets.length;
    // A tick going backwards means a new game started: re-baseline silently
    // so the initial ownership doesn't flash.
    if (flashOwners.length !== n || curr.tick < lastSeenTick) {
      flashOwners = new Array<Owner>(n);
      flashAt = new Array<number>(n).fill(-1e9);
      for (let i = 0; i < n; i++) flashOwners[i] = curr.planets[i]!.owner;
    } else {
      for (let i = 0; i < n; i++) {
        const owner = curr.planets[i]!.owner;
        if (owner !== flashOwners[i]) {
          flashOwners[i] = owner;
          flashAt[i] = now;
        }
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
  function haloText(text: string, x: number, y: number, fontSize: number): void {
    g.font = `bold ${fontSize}px system-ui, sans-serif`;
    g.lineJoin = "round";
    g.strokeStyle = BG;
    g.lineWidth = Math.max(3, fontSize / 5);
    g.strokeText(text, x, y);
    g.fillStyle = "#ffffff";
    g.fillText(text, x, y);
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

      if (selection.has(p.id)) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 4;
        g.beginPath();
        g.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
        g.stroke();
      }

      // Font size floors at MIN_GARRISON_FONT css px regardless of world
      // scale — garrison counts must stay readable on small phone screens.
      const fontSize = Math.max(MIN_GARRISON_FONT / scale, r * 0.7);
      g.textAlign = "center";
      g.textBaseline = "middle";
      haloText(String(Math.floor(p.garrison)), p.x, p.y, fontSize);
    }
  }

  function drawFleets(
    prev: GameState,
    curr: GameState,
    alpha: number,
    scale: number
  ): void {
    prevFleetById.clear();
    for (const f of prev.fleets) prevFleetById.set(f.id, f);

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
    selection: ReadonlySet<number>
  ): void {
    syncCanvasSize();
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const now = performance.now();

    updateCaptureFlashes(curr, now);

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

    drawPlanets(curr, selection, scale, now);
    drawFleets(prev, curr, alpha, scale);

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

    if (curr.phase !== "playing") {
      g.fillStyle = "rgba(11, 14, 26, 0.7)";
      g.fillRect(0, 0, cssW, cssH);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = curr.phase === "playerWon" ? "#4da6ff" : "#ff5d5d";
      g.font = "bold 48px system-ui, sans-serif";
      g.fillText(curr.phase === "playerWon" ? "Victory" : "Defeat", cssW / 2, cssH / 2 - 20);
      g.fillStyle = "#ffffff";
      g.font = "18px system-ui, sans-serif";
      g.fillText("Tap to play again", cssW / 2, cssH / 2 + 30);
    }
  }

  return { render };
}
