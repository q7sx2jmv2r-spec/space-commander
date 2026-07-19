// Space Commander — composition root. Wires the deterministic sim (sim.ts,
// DOM-free), rendering (render.ts), input (input.ts), AI (ai.ts via sim) and
// the QUA-124 skirmish flow (flow.ts state machine + ui.ts DOM chrome).
// Owns the fixed-timestep loop: the sim ticks at exactly TICK_RATE via an
// accumulator — and only while the flow is "playing", which is what makes
// pause a total freeze (production, fleets and AI all stop; nothing draws
// from the rng, so resume continues bit-exactly).

import { GameState, Command, Owner, TICK_DT, PLAYER, update } from "./sim";
import { generateMap } from "./mapgen";
import { setAiLog } from "./ai";
import type { AiTier, FactionCount } from "./config";
import { createRenderer, worldTransform } from "./render";
import { attachInput } from "./input";
import { hapticImpact, hapticSuccess } from "./haptics";
import { FlowState, FlowEvent, transition } from "./flow";
import { attachUi, SkirmishSettings } from "./ui";

/** Cap on accumulated frame time so a hiccup doesn't spiral into a tick
 * burst. (Backgrounding is handled properly by auto-pause below.) */
const MAX_FRAME_TIME = 0.25;

// --- URL parameters: prefill + debug switches -------------------------------
// ?seed=      prefills the seed field (and writeSeedToUrl keeps it shareable)
// ?factions=  prefills 2/3   ?ai=easy,hard  prefills difficulties
// ?autostart=1  skips the setup screen (e2e + shared links)
// ?ailog=1    AI decision log   ?scenario=accept|win|lose  debug states

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
setAiLog(params.get("ailog") === "1");

function settingsFromUrl(): SkirmishSettings {
  const factions: FactionCount = params.get("factions") === "3" ? 3 : 2;
  const valid: AiTier[] = ["easy", "medium", "hard"];
  const tiers = (params.get("ai") ?? "")
    .split(",")
    .filter((t): t is AiTier => (valid as string[]).includes(t));
  while (tiers.length < factions - 1) tiers.push(tiers[tiers.length - 1] ?? "medium");
  return { factions, tiers: tiers.slice(0, factions - 1), seedText: params.get("seed") ?? "" };
}

function writeSeedToUrl(seed: number): void {
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  history.replaceState(null, "", url);
}

// --- Debug scenarios (bypass setup; local by design, not sim API) -----------

/** QUA-119 acceptance scenario: production ticks, a fleet crosses, the
 * neutral flips, the medium AI counterattacks. */
function acceptanceState(): GameState {
  return {
    tick: 0,
    seed: 0,
    rng: { s: 0 },
    planets: [
      { id: 0, x: 220, y: 1320, size: "medium", owner: "player", garrison: 20, heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 },
      { id: 1, x: 780, y: 280, size: "medium", owner: "ai1", garrison: 20, heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 },
      { id: 2, x: 730, y: 1140, size: "small", owner: "neutral", garrison: 8, heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 },
    ],
    fleets: [{ id: 0, owner: "player", ships: 12, originId: 0, destId: 2, progress: 0 }],
    nextFleetId: 1,
    phase: "playing",
    ai: [{ owner: "ai1", tier: "medium", nextDecisionTick: 120 }],
  };
}

/** One overwhelming fleet ~0.3s from ending the game — deterministic e2e
 * path to each end screen (QUA-124). */
function endScenario(win: boolean): GameState {
  return {
    tick: 0,
    seed: 0,
    rng: { s: 0 },
    planets: [
      { id: 0, x: 200, y: 1200, size: "medium", owner: "player", garrison: win ? 20 : 5, heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 },
      { id: 1, x: 800, y: 400, size: "medium", owner: "ai1", garrison: win ? 5 : 20, heldTicks: 0, spec: "standard", nextSpec: "standard", convertTicks: 0 },
    ],
    fleets: [
      win
        ? { id: 0, owner: "player", ships: 40, originId: 0, destId: 1, progress: 0.94 }
        : { id: 0, owner: "ai1", ships: 40, originId: 1, destId: 0, progress: 0.94 },
    ],
    nextFleetId: 1,
    phase: "playing",
    ai: [],
  };
}

// --- Game + flow state ------------------------------------------------------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = createRenderer(canvas);

let state: GameState;
let prevState: GameState;
let flowState: FlowState = "setup";
let settings: SkirmishSettings = settingsFromUrl();
let lastSeed = 0;

// Ownership diff per frame: haptics (QUA-122) + captured-planet count for the
// end screen (QUA-124). Renderer stays side-effect-free; sim stays UI-free.
let ownerBaseline: Owner[] = [];
let captures = 0;
let endHapticFired = false;

let accumulator = 0;
let lastTime = performance.now();

const input = attachInput(canvas, () => state);

function startGame(seed: number): void {
  lastSeed = seed;
  if (scenario === "accept") {
    state = acceptanceState();
  } else if (scenario === "win" || scenario === "lose") {
    state = endScenario(scenario === "win");
  } else {
    writeSeedToUrl(seed);
    state = generateMap(seed, settings.factions, settings.tiers);
  }
  prevState = JSON.parse(JSON.stringify(state)) as GameState;
  // No state may leak between games (QUA-124):
  input.reset();
  ownerBaseline = [];
  captures = 0;
  endHapticFired = false;
  accumulator = 0;
  lastTime = performance.now();
}

const ui = attachUi({
  onStart: () => {
    settings = ui.readSettings();
    dispatch("START");
  },
  onPause: () => dispatch("PAUSE"),
  onResume: () => dispatch("RESUME"),
  onRestart: () => dispatch("RESTART"),
  onReplay: () => dispatch("REPLAY"),
});

/** Advance the flow state machine and run the entry side effects. Illegal
 * events are no-ops by construction (flow.ts). */
function dispatch(event: FlowEvent): void {
  const next = transition(flowState, event);
  if (next === flowState) return;
  flowState = next;

  if (event === "START") {
    const parsed = Number.parseInt(settings.seedText, 10);
    startGame(Number.isFinite(parsed) ? parsed >>> 0 : Date.now() >>> 0);
  } else if (event === "REPLAY") {
    startGame(lastSeed);
  } else if (event === "RESUME") {
    lastTime = performance.now(); // paused time must not enter the accumulator
  } else if (event === "GAME_OVER") {
    ui.showEnd({
      won: state.phase === "playerWon",
      ticks: state.tick,
      captured: captures,
      seed: lastSeed,
      tiers: settings.tiers,
    });
  } else if (event === "RESTART") {
    ui.writeSettings(settings); // same settings pre-filled, per spec
  }
  ui.showScreen(flowState);
}

// Auto-pause when the tab/app goes to background so a phone game survives
// interruptions; resuming is a deliberate tap on the pause overlay.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") dispatch("PAUSE");
});

function fireStateHaptics(): void {
  if (ownerBaseline.length !== state.planets.length) {
    ownerBaseline = state.planets.map((p) => p.owner);
    endHapticFired = state.phase !== "playing";
    return;
  }
  let impact = false;
  for (let i = 0; i < state.planets.length; i++) {
    const owner = state.planets[i]!.owner;
    const was = ownerBaseline[i]!;
    if (owner !== was) {
      if (owner === PLAYER) {
        captures += 1;
        impact = true;
      } else if (was === PLAYER) {
        impact = true;
      }
      ownerBaseline[i] = owner;
    }
  }
  if (state.phase !== "playing" && !endHapticFired) {
    endHapticFired = true;
    if (state.phase === "playerWon") hapticSuccess();
    else hapticImpact();
  } else if (impact) {
    hapticImpact();
  }
}

// --- Boot -------------------------------------------------------------------

// A game always exists so the renderer and the __game hook are total: the
// setup screen shows over a freshly generated (frozen) map. Scenarios and
// ?autostart=1 skip straight into play.
if (scenario !== null || params.get("autostart") === "1") {
  flowState = "playing";
}
{
  const parsed = Number.parseInt(settings.seedText, 10);
  startGame(Number.isFinite(parsed) ? parsed >>> 0 : Date.now() >>> 0);
}
ui.writeSettings(settings);
ui.showScreen(flowState);

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
    get flow() {
      return flowState;
    },
    toScreen(wx: number, wy: number): { x: number; y: number } {
      const rect = canvas.getBoundingClientRect();
      const t = worldTransform(rect.width, rect.height);
      return { x: rect.left + t.offsetX + wx * t.scale, y: rect.top + t.offsetY + wy * t.scale };
    },
  },
});

// --- Frame loop -------------------------------------------------------------

let fps = 0;
let frameCount = 0;
let fpsWindowStart = lastTime;

const NO_COMMANDS: Command[] = [];

function frame(now: number): void {
  if (flowState === "playing") {
    const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
    lastTime = now;
    accumulator += frameTime;

    // Pending commands enter the sim only at a tick boundary, and only into
    // the first tick of this frame; catch-up ticks run with no commands.
    let commands: Command[] | null = null;
    while (accumulator >= TICK_DT) {
      if (commands === null) commands = input.pendingCommands.splice(0);
      prevState = JSON.parse(JSON.stringify(state)) as GameState;
      update(state, commands);
      commands = NO_COMMANDS;
      accumulator -= TICK_DT;
    }

    fireStateHaptics();
    if (state.phase !== "playing") dispatch("GAME_OVER");
  } else {
    // Halted (setup/paused/ended): keep the clock current so no dead time
    // floods the accumulator when play (re)starts.
    lastTime = now;
  }

  frameCount += 1;
  if (now - fpsWindowStart >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
    frameCount = 0;
    fpsWindowStart = now;
  }

  renderer.render(prevState, state, accumulator / TICK_DT, fps, input.view);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
