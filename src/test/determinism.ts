// Determinism test. Bundled by esbuild and run under plain node (see the
// test:determinism script), which doubles as proof that the sim modules are
// DOM-free. Throws on failure so node exits nonzero without needing
// process/@types/node.

import { GameState, Command, PLAYER, createGame, update } from "../sim";

const TICKS = 5000;

// Scripted player commands exercise the command path. Targets are clamped to
// the generated planet count so any seed works.
function commandsFor(tick: number, state: GameState): Command[] {
  const n = state.planets.length;
  if (tick === 240) return [{ type: "send", owner: PLAYER, from: [0], to: 2 % n }];
  if (tick === 900) return [{ type: "send", owner: PLAYER, from: [0], to: 3 % n }];
  return [];
}

function run(seed: number): string {
  const state = createGame(seed);
  for (let t = 1; t <= TICKS; t++) {
    update(state, commandsFor(t, state));
  }
  return JSON.stringify(state);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`determinism test FAILED: ${msg}`);
}

// 1. Same seed twice → bit-identical state.
const a = run(12345);
const b = run(12345);
assert(a === b, "same seed produced different states after 5000 ticks");

// 2. Different seeds → different games (sanity that the seed matters).
const c = run(54321);
assert(a !== c, "different seeds produced identical states");

// 3. Snapshot/resume: a JSON round-trip mid-game must not change the future.
// This proves the state is truly plain serializable data.
{
  const original = createGame(777);
  for (let t = 1; t <= 2500; t++) update(original, commandsFor(t, original));
  const snapshot = JSON.parse(JSON.stringify(original)) as GameState;
  for (let t = 2501; t <= TICKS; t++) {
    update(original, commandsFor(t, original));
    update(snapshot, commandsFor(t, snapshot));
  }
  assert(
    JSON.stringify(original) === JSON.stringify(snapshot),
    "JSON snapshot diverged from the original after resume"
  );
}

const finalState = JSON.parse(a) as GameState;
console.log(
  `determinism OK (${TICKS} ticks, ${finalState.planets.length} planets, ` +
    `${finalState.fleets.length} fleets in flight, phase=${finalState.phase})`
);
