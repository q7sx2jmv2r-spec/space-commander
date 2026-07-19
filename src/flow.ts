// Screen-flow state machine (QUA-124). Explicit states and a transition
// table — not booleans — because the campaign tickets stack more flow on top
// of this. Pure and DOM-free so it runs in the node test suite; main.ts owns
// the side effects (showing panels, halting the sim loop).

export type FlowState = "setup" | "playing" | "paused" | "ended";

export type FlowEvent =
  | "START" // setup → playing (also ended → playing via REPLAY)
  | "PAUSE" // playing → paused (pause button or tab hidden)
  | "RESUME" // paused → playing
  | "GAME_OVER" // playing → ended (sim phase left "playing")
  | "RESTART" // ended → setup (settings pre-filled)
  | "REPLAY"; // ended → playing (same seed + settings)

const TRANSITIONS: Record<FlowState, Partial<Record<FlowEvent, FlowState>>> = {
  setup: { START: "playing" },
  playing: { PAUSE: "paused", GAME_OVER: "ended" },
  paused: { RESUME: "playing" },
  ended: { RESTART: "setup", REPLAY: "playing" },
};

/** Apply an event. Illegal events are no-ops (return the same state) — e.g.
 * a queued pause tap landing after the game already ended must not corrupt
 * the flow. */
export function transition(state: FlowState, event: FlowEvent): FlowState {
  return TRANSITIONS[state][event] ?? state;
}
