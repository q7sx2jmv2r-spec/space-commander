// Space Commander — glue between the deterministic sim (sim.ts, DOM-free),
// rendering (render.ts) and input (input.ts). Owns the fixed-timestep loop:
// the sim ticks at exactly TICK_RATE via an accumulator, rendering
// interpolates between the last two ticks.

import { GameState, Command, TICK_DT, createGame, update } from "./sim";
import { createRenderer } from "./render";
import { attachInput } from "./input";

/** Cap on accumulated frame time so a background tab doesn't spiral. */
const MAX_FRAME_TIME = 0.25;

// Seed comes from ?seed= so games are reproducible and shareable; the choice
// of a fresh seed uses Date.now, which is fine — it is outside the sim.
function seedFromUrl(): number {
  const raw = new URLSearchParams(location.search).get("seed");
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : Date.now() >>> 0;
}

function writeSeedToUrl(seed: number): void {
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  history.replaceState(null, "", url);
}

/** QUA-119 acceptance scenario (3 planets, 2 owners, 1 fleet in transit) as a
 * visual harness for QUA-120: load ?scenario=accept and watch production tick
 * up, the fleet cross, and the neutral planet flip (then the AI counterattack
 * flip it again). Debug-only — deliberately local to main.ts, not sim API. */
function acceptanceState(): GameState {
  return {
    tick: 0,
    seed: 0,
    rng: { s: 0 },
    planets: [
      { id: 0, x: 220, y: 1320, size: "medium", owner: "player", garrison: 20 },
      { id: 1, x: 780, y: 280, size: "medium", owner: "ai1", garrison: 20 },
      { id: 2, x: 730, y: 1140, size: "small", owner: "neutral", garrison: 8 },
    ],
    fleets: [{ id: 0, owner: "player", ships: 12, originId: 0, destId: 2, progress: 0 }],
    nextFleetId: 1,
    phase: "playing",
  };
}

const scenario = new URLSearchParams(location.search).get("scenario");

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = createRenderer(canvas);

let state: GameState;
let prevState: GameState;

function startGame(seed: number): void {
  if (scenario === "accept") {
    state = acceptanceState();
  } else {
    writeSeedToUrl(seed);
    state = createGame(seed);
  }
  prevState = JSON.parse(JSON.stringify(state)) as GameState;
}

const input = attachInput(
  canvas,
  () => state,
  () => startGame(Date.now() >>> 0)
);

startGame(seedFromUrl());

let accumulator = 0;
let lastTime = performance.now();

let fps = 0;
let frameCount = 0;
let fpsWindowStart = lastTime;

const NO_COMMANDS: Command[] = [];

function frame(now: number): void {
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;
  accumulator += frameTime;

  // Pending commands enter the sim only at a tick boundary, and only into the
  // first tick of this frame; catch-up ticks run with no commands. They stay
  // queued (not dropped) on frames where no tick runs.
  let commands: Command[] | null = null;
  while (accumulator >= TICK_DT) {
    if (commands === null) commands = input.pendingCommands.splice(0);
    prevState = JSON.parse(JSON.stringify(state)) as GameState;
    update(state, commands);
    commands = NO_COMMANDS;
    accumulator -= TICK_DT;
  }

  frameCount += 1;
  if (now - fpsWindowStart >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
    frameCount = 0;
    fpsWindowStart = now;
  }

  renderer.render(prevState, state, accumulator / TICK_DT, fps, input.selection);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
