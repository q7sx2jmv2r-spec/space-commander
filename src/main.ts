// Space Commander — glue between the deterministic sim (sim.ts, DOM-free),
// rendering (render.ts) and input (input.ts). Owns the fixed-timestep loop:
// the sim ticks at exactly TICK_RATE via an accumulator, rendering
// interpolates between the last two ticks.

import { GameState, Command, Owner, TICK_DT, PLAYER, update } from "./sim";
import { generateMap } from "./mapgen";
import { setAiLog } from "./ai";
import type { AiTier, FactionCount } from "./config";
import { createRenderer, worldTransform } from "./render";
import { attachInput } from "./input";
import { hapticImpact, hapticSuccess } from "./haptics";

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
    // Medium AI, first decision at 2s — preserves the original scenario beat
    // where the AI counterattacks the planet the player just captured.
    ai: [{ owner: "ai1", tier: "medium", nextDecisionTick: 120 }],
  };
}

const scenario = new URLSearchParams(location.search).get("scenario");

// ?factions=3 renders a rotated 3-faction map; default is a 2-faction mirror.
function factionsFromUrl(): FactionCount {
  return new URLSearchParams(location.search).get("factions") === "3" ? 3 : 2;
}

// ?ai=easy|medium|hard (comma list for multiple AI factions, e.g.
// ?factions=3&ai=easy,hard) picks difficulty; ?ailog=1 prints each AI
// decision with its reasoning. QUA-124 replaces the param with a setup UI.
function aiTiersFromUrl(): AiTier[] {
  const raw = new URLSearchParams(location.search).get("ai");
  if (!raw) return [];
  const valid: AiTier[] = ["easy", "medium", "hard"];
  return raw
    .split(",")
    .filter((t): t is AiTier => (valid as string[]).includes(t));
}

setAiLog(new URLSearchParams(location.search).get("ailog") === "1");

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = createRenderer(canvas);

let state: GameState;
let prevState: GameState;

function startGame(seed: number): void {
  if (scenario === "accept") {
    state = acceptanceState();
  } else {
    writeSeedToUrl(seed);
    state = generateMap(seed, factionsFromUrl(), aiTiersFromUrl());
  }
  prevState = JSON.parse(JSON.stringify(state)) as GameState;
  hapticOwners = []; // re-baseline; a new game's ownership must not buzz
}

// Haptic events (QUA-122): medium impact when the player gains or loses a
// planet, success pattern on victory. Detected by diffing ownership across
// frames — the sim stays haptics-free, and the renderer stays side-effect-free.
// Declared before the first startGame call, which resets it.
let hapticOwners: Owner[] = [];
let hapticPhaseDone = false;

const input = attachInput(
  canvas,
  () => state,
  () => startGame(Date.now() >>> 0)
);

startGame(seedFromUrl());

// Debug/e2e hook: read-only view of live state plus the world→screen mapping,
// so automated tests can find planets on screen. Not a public API.
Object.defineProperty(window, "__game", {
  value: {
    get state() {
      return state;
    },
    get view() {
      return input.view;
    },
    toScreen(wx: number, wy: number): { x: number; y: number } {
      const rect = canvas.getBoundingClientRect();
      const t = worldTransform(rect.width, rect.height);
      return { x: rect.left + t.offsetX + wx * t.scale, y: rect.top + t.offsetY + wy * t.scale };
    },
  },
});

function fireStateHaptics(): void {
  if (hapticOwners.length !== state.planets.length) {
    hapticOwners = state.planets.map((p) => p.owner);
    hapticPhaseDone = state.phase !== "playing";
    return;
  }
  let impact = false;
  for (let i = 0; i < state.planets.length; i++) {
    const owner = state.planets[i]!.owner;
    const was = hapticOwners[i]!;
    if (owner !== was) {
      if (owner === PLAYER || was === PLAYER) impact = true;
      hapticOwners[i] = owner;
    }
  }
  if (state.phase !== "playing" && !hapticPhaseDone) {
    hapticPhaseDone = true;
    if (state.phase === "playerWon") hapticSuccess();
    else hapticImpact();
  } else if (impact) {
    hapticImpact();
  }
}

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

  fireStateHaptics();
  renderer.render(prevState, state, accumulator / TICK_DT, fps, input.view);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
