// Touch/pointer input. Selection is UI state and lives here, never in
// GameState; taps translate into Commands that main.ts feeds to the sim at
// tick boundaries, which keeps the sim deterministic and replay-ready.

import { Command, GameState, Planet, PLAYER } from "./sim";
import { screenToWorld } from "./render";

/** Minimum tap radius in world units, so small planets stay tappable. */
const MIN_HIT_RADIUS = 45;

export interface InputState {
  selection: Set<number>;
  pendingCommands: Command[];
}

function hitTest(planets: readonly Planet[], wx: number, wy: number): Planet | null {
  let best: Planet | null = null;
  let bestDist = Infinity;
  for (const p of planets) {
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d <= Math.max(p.r, MIN_HIT_RADIUS) && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  getState: () => GameState,
  onRestart: () => void
): InputState {
  const input: InputState = { selection: new Set(), pendingCommands: [] };

  canvas.addEventListener("pointerdown", (e) => {
    const state = getState();
    if (state.phase !== "playing") {
      onRestart();
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const { x, y } = screenToWorld(
      rect.width,
      rect.height,
      e.clientX - rect.left,
      e.clientY - rect.top
    );

    const planet = hitTest(state.planets, x, y);
    if (!planet) {
      input.selection.clear();
      return;
    }

    if (planet.owner === PLAYER) {
      // Tap own planet: toggle selection membership.
      if (input.selection.has(planet.id)) {
        input.selection.delete(planet.id);
      } else {
        input.selection.add(planet.id);
      }
    } else if (input.selection.size > 0) {
      // Tap enemy/neutral with a selection: send 50% from each source.
      input.pendingCommands.push({
        type: "send",
        owner: PLAYER,
        from: [...input.selection].sort((a, b) => a - b),
        to: planet.id,
      });
      input.selection.clear();
    }
  });

  return input;
}
