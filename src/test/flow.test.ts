// QUA-124 flow state machine tests — run under plain node, proving flow.ts
// is DOM-free. Throws on failure.

import { FlowEvent, FlowState, transition } from "../flow";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`flow test FAILED: ${msg}`);
}

const STATES: FlowState[] = ["setup", "playing", "paused", "ended"];
const EVENTS: FlowEvent[] = ["START", "PAUSE", "RESUME", "GAME_OVER", "RESTART", "REPLAY"];

// 1. Every legal transition.
const legal: [FlowState, FlowEvent, FlowState][] = [
  ["setup", "START", "playing"],
  ["playing", "PAUSE", "paused"],
  ["playing", "GAME_OVER", "ended"],
  ["paused", "RESUME", "playing"],
  ["ended", "RESTART", "setup"],
  ["ended", "REPLAY", "playing"],
];
for (const [from, ev, to] of legal) {
  assert(transition(from, ev) === to, `${from} --${ev}--> expected ${to}`);
}

// 2. Everything not in the legal table is a no-op (stale taps must not
// corrupt the flow — e.g. PAUSE landing after GAME_OVER).
const legalKey = new Set(legal.map(([f, e]) => `${f}:${e}`));
for (const from of STATES) {
  for (const ev of EVENTS) {
    if (legalKey.has(`${from}:${ev}`)) continue;
    assert(transition(from, ev) === from, `illegal ${from} --${ev}--> must be a no-op`);
  }
}

// 3. Full journeys: play→pause→resume→lose→restart, and the replay edge.
{
  let s: FlowState = "setup";
  for (const ev of ["START", "PAUSE", "RESUME", "GAME_OVER", "RESTART"] as FlowEvent[]) {
    s = transition(s, ev);
  }
  assert(s === "setup", "full journey should land back on setup");

  s = transition(transition(s, "START"), "GAME_OVER");
  s = transition(s, "REPLAY");
  assert(s === "playing", "replay should jump straight back into playing");
}

console.log("flow tests OK (6 legal transitions, all illegal no-ops, full journeys)");
