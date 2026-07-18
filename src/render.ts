// Rendering + coordinate mapping. Reads sim state, never writes it. The
// world→screen transform lives here and input.ts uses screenToWorld so there
// is exactly one mapping in the codebase.

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

export interface WorldTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Uniform scale-to-fit of the logical world inside the screen (CSS px). */
export function worldTransform(cssW: number, cssH: number): WorldTransform {
  const scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
  return {
    scale,
    offsetX: (cssW - WORLD_W * scale) / 2,
    offsetY: (cssH - WORLD_H * scale) / 2,
  };
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
    }
  }

  function drawPlanets(curr: GameState, selection: ReadonlySet<number>): void {
    for (const p of curr.planets) {
      const r = SIZE_RADIUS[p.size];
      g.fillStyle = OWNER_FILL[p.owner];
      g.strokeStyle = OWNER_STROKE[p.owner];
      g.lineWidth = 3;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      if (selection.has(p.id)) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 4;
        g.beginPath();
        g.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
        g.stroke();
      }

      const fontSize = Math.max(22, r * 0.7);
      g.fillStyle = "#ffffff";
      g.font = `bold ${fontSize}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(Math.floor(p.garrison)), p.x, p.y);
    }
  }

  function drawFleets(prev: GameState, curr: GameState, alpha: number): void {
    const prevById = new Map<number, Fleet>();
    for (const f of prev.fleets) prevById.set(f.id, f);

    for (const f of curr.fleets) {
      // Interpolate progress between ticks, then derive the position from the
      // (static) origin/dest planet centers — exact, no positional drift.
      const pf = prevById.get(f.id);
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

      g.font = "bold 20px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.fillText(String(f.ships), x, y - r - 4);
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

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, cssW, cssH);

    const t = worldTransform(cssW, cssH);
    g.translate(t.offsetX, t.offsetY);
    g.scale(t.scale, t.scale);

    g.strokeStyle = "#2a3150";
    g.lineWidth = 4;
    g.strokeRect(0, 0, WORLD_W, WORLD_H);

    drawPlanets(curr, selection);
    drawFleets(prev, curr, alpha);

    // HUD in screen space
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#8b93b8";
    g.font = "14px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "top";
    g.fillText(`${fps} fps`, 10, 10);
    g.fillText(`tick ${curr.tick}`, 10, 28);
    g.fillText(`seed ${curr.seed}`, 10, 46);

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
