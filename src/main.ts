// Space Commander — Phase 1 scaffolding (QUA-118).
//
// Architecture: the simulation is a pure, deterministic function of
// (state, fixed dt) running at 60Hz in a fixed logical world space.
// Rendering reads state and maps world space onto the screen; it never
// feeds back into the simulation. Game state is JSON-serializable.
// Determinism constraint: no Math.random anywhere in simulation code —
// later tickets introduce a seeded PRNG for map generation and AI.

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Simulation ticks per second. */
const TICK_RATE = 60;
/** Seconds of simulated time per tick. */
const TICK_DT = 1 / TICK_RATE;
/** Cap on accumulated frame time so a background tab doesn't spiral. */
const MAX_FRAME_TIME = 0.25;

/** Logical world size (portrait). Rendering scales this to fit the screen. */
const WORLD_W = 1000;
const WORLD_H = 1600;

/** Whole game state. Must stay JSON-serializable (plain data, no functions,
 * no NaN/Infinity) so later tickets can snapshot/replay it. */
interface GameState {
  tick: number;
  circle: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
  };
}

function createInitialState(): GameState {
  return {
    tick: 0,
    circle: { x: WORLD_W / 2, y: WORLD_H / 3, vx: 420, vy: 560, r: 60 },
  };
}

/** Advance the simulation by exactly one fixed tick. Deterministic. */
function update(state: GameState): void {
  state.tick += 1;

  const c = state.circle;
  c.x += c.vx * TICK_DT;
  c.y += c.vy * TICK_DT;

  if (c.x - c.r < 0) {
    c.x = c.r;
    c.vx = Math.abs(c.vx);
  } else if (c.x + c.r > WORLD_W) {
    c.x = WORLD_W - c.r;
    c.vx = -Math.abs(c.vx);
  }
  if (c.y - c.r < 0) {
    c.y = c.r;
    c.vy = Math.abs(c.vy);
  } else if (c.y + c.r > WORLD_H) {
    c.y = WORLD_H - c.r;
    c.vy = -Math.abs(c.vy);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = ((): CanvasRenderingContext2D => {
  const c = canvas.getContext("2d");
  if (!c) throw new Error("Canvas 2D context unavailable");
  return c;
})();

/** Match the canvas backing store to its CSS size × devicePixelRatio.
 * Called every frame: cheap when nothing changed, and it catches window
 * resizes, rotation, and mobile address-bar show/hide without relying on
 * resize events firing at the right time. */
function syncCanvasSize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

interface WorldTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Uniform scale-to-fit of the logical world inside the screen (CSS px). */
function worldTransform(cssW: number, cssH: number): WorldTransform {
  const scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
  return {
    scale,
    offsetX: (cssW - WORLD_W * scale) / 2,
    offsetY: (cssH - WORLD_H * scale) / 2,
  };
}

/** Render `state`, interpolated toward the previous tick by `alpha` so
 * motion stays smooth when the display refresh isn't a multiple of 60Hz. */
function render(
  g: CanvasRenderingContext2D,
  prev: GameState,
  curr: GameState,
  alpha: number,
  fps: number
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#0b0e1a";
  g.fillRect(0, 0, cssW, cssH);

  const t = worldTransform(cssW, cssH);
  g.translate(t.offsetX, t.offsetY);
  g.scale(t.scale, t.scale);

  // World bounds
  g.strokeStyle = "#2a3150";
  g.lineWidth = 4;
  g.strokeRect(0, 0, WORLD_W, WORLD_H);

  // Bouncing circle (placeholder for planets/fleets)
  const x = prev.circle.x + (curr.circle.x - prev.circle.x) * alpha;
  const y = prev.circle.y + (curr.circle.y - prev.circle.y) * alpha;
  g.fillStyle = "#5ac8fa";
  g.beginPath();
  g.arc(x, y, curr.circle.r, 0, Math.PI * 2);
  g.fill();

  // HUD in screen space
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#8b93b8";
  g.font = "14px system-ui, sans-serif";
  g.textBaseline = "top";
  g.fillText(`${fps} fps`, 10, 10);
  g.fillText(`tick ${curr.tick}`, 10, 28);
}

// ---------------------------------------------------------------------------
// Fixed-timestep loop
// ---------------------------------------------------------------------------

let state = createInitialState();
/** Snapshot of the previous tick, kept for render interpolation. */
let prevState: GameState = JSON.parse(JSON.stringify(state)) as GameState;

let accumulator = 0;
let lastTime = performance.now();

let fps = 0;
let frameCount = 0;
let fpsWindowStart = lastTime;

function frame(now: number): void {
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;
  accumulator += frameTime;

  while (accumulator >= TICK_DT) {
    prevState = JSON.parse(JSON.stringify(state)) as GameState;
    update(state);
    accumulator -= TICK_DT;
  }

  frameCount += 1;
  if (now - fpsWindowStart >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
    frameCount = 0;
    fpsWindowStart = now;
  }

  syncCanvasSize();
  render(ctx, prevState, state, accumulator / TICK_DT, fps);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
