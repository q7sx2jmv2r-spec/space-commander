// Touch/pointer input (QUA-122). Genre-convention gestures (Galcon/Auralux):
// tap to select/toggle, tap target to send, drag-from-planet to aim+send with
// a live trajectory, drag-on-empty for rubber-band multiselect, double-taps
// for select-all / full-strength send. Selection is UI state and lives here,
// never in GameState; gestures translate into Commands that main.ts feeds to
// the sim at tick boundaries, keeping the sim deterministic and replay-ready.
//
// One-handed by design: a single primary pointer drives everything — extra
// touches are ignored, never interpreted (no two-finger gestures).

import { Command, GameState, Planet, PLAYER } from "./sim";
import { SIZE_RADIUS, SEND_FRACTION } from "./config";
import { screenToWorld, worldTransform } from "./render";
import { hapticTick } from "./haptics";

// Gesture thresholds in css px (≈pt), converted to world units per-event via
// the live transform scale so they feel identical at every zoom/device.
const TAP_SLOP = 10; // beyond this movement a press becomes a drag
const SNAP_DIST = 20; // drag release within this of a planet edge targets it
const DOUBLE_TAP_MS = 300;
const MIN_HIT_RADIUS = 22; // 44pt hit area regardless of visual planet size

/** Live gesture feedback for the renderer (world coords). `drag` is null when
 * no gesture is in flight. A single mutable object, reused — the renderer
 * reads it every frame and must not retain it. */
export interface InputView {
  selection: ReadonlySet<number>;
  drag:
    | null
    | { kind: "aim"; x: number; y: number }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number };
}

export interface InputState {
  view: InputView;
  pendingCommands: Command[];
}

type Mode = "idle" | "pressed" | "dragPlanet" | "dragBox";

export function attachInput(
  canvas: HTMLCanvasElement,
  getState: () => GameState,
  onRestart: () => void
): InputState {
  const selection = new Set<number>();
  const input: InputState = {
    view: { selection, drag: null },
    pendingCommands: [],
  };

  let mode: Mode = "idle";
  let pointerId = -1;
  let startCssX = 0;
  let startCssY = 0;
  let startWorld = { x: 0, y: 0 };
  let curWorld = { x: 0, y: 0 };
  let startPlanetId = -1; // owned planet under the initial press, else -1
  let preGesture: number[] = []; // selection snapshot for clean aborts

  // Double-tap tracking: what the last completed tap hit, and when.
  let lastTapAt = -Infinity;
  let lastTapPlanetId = -2; // -1 = empty space, -2 = none yet
  let lastSendSources: number[] = []; // sources of the last tap-send, for the 100% top-up

  /** World-units-per-css-px is 1/scale of the shared transform. */
  function cssToWorld(canvasEl: HTMLCanvasElement, cssUnits: number): number {
    const rect = canvasEl.getBoundingClientRect();
    return cssUnits / worldTransform(rect.width, rect.height).scale;
  }

  function eventWorld(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
  }

  /** Nearest planet whose padded hit zone contains (wx, wy). Padding enforces
   * the 44pt minimum so small planets stay thumb-tappable. */
  function hitTest(planets: readonly Planet[], wx: number, wy: number, extraCss = 0): Planet | null {
    const pad = cssToWorld(canvas, MIN_HIT_RADIUS);
    const extra = extraCss > 0 ? cssToWorld(canvas, extraCss) : 0;
    let best: Planet | null = null;
    let bestDist = Infinity;
    for (const p of planets) {
      const d = Math.hypot(p.x - wx, p.y - wy);
      const hitR = Math.max(SIZE_RADIUS[p.size], pad) + extra;
      if (d <= hitR && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }

  function send(sources: readonly number[], targetId: number, fraction: number): void {
    const from = [...sources].filter((id) => id !== targetId).sort((a, b) => a - b);
    if (from.length === 0) return;
    input.pendingCommands.push({ type: "send", owner: PLAYER, from, to: targetId, fraction });
  }

  function resetGesture(): void {
    mode = "idle";
    pointerId = -1;
    input.view.drag = null;
  }

  /** touchcancel / pointercancel (incoming call, notification): abort with no
   * command and restore the selection the gesture started from. */
  function abortGesture(): void {
    if (mode === "dragBox" || mode === "dragPlanet") {
      selection.clear();
      for (const id of preGesture) selection.add(id);
    }
    resetGesture();
  }

  function updateBoxSelection(state: GameState): void {
    const x0 = Math.min(startWorld.x, curWorld.x);
    const x1 = Math.max(startWorld.x, curWorld.x);
    const y0 = Math.min(startWorld.y, curWorld.y);
    const y1 = Math.max(startWorld.y, curWorld.y);
    const before = selection.size;
    selection.clear();
    for (const p of state.planets) {
      if (p.owner === PLAYER && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
        selection.add(p.id);
      }
    }
    if (selection.size !== before) hapticTick();
    input.view.drag = { kind: "box", x0, y0, x1, y1 };
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (mode !== "idle") return; // second finger: ignore, never reinterpret
    const state = getState();
    if (state.phase !== "playing") {
      onRestart();
      return;
    }

    mode = "pressed";
    pointerId = e.pointerId;
    startCssX = e.clientX;
    startCssY = e.clientY;
    startWorld = eventWorld(e);
    curWorld = startWorld;
    preGesture = [...selection];

    const p = hitTest(state.planets, startWorld.x, startWorld.y);
    startPlanetId = p && p.owner === PLAYER ? p.id : -1;

    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || mode === "idle") return;
    const state = getState();
    if (state.phase !== "playing") {
      abortGesture();
      return;
    }
    curWorld = eventWorld(e);

    if (mode === "pressed") {
      const moved = Math.hypot(e.clientX - startCssX, e.clientY - startCssY);
      if (moved <= TAP_SLOP) return; // still a tap candidate
      if (startPlanetId >= 0) {
        // Drag from an owned planet: select it and start aiming.
        mode = "dragPlanet";
        if (!selection.has(startPlanetId)) {
          selection.add(startPlanetId);
          hapticTick();
        }
      } else {
        mode = "dragBox";
      }
    }

    if (mode === "dragPlanet") {
      input.view.drag = { kind: "aim", x: curWorld.x, y: curWorld.y };
    } else if (mode === "dragBox") {
      updateBoxSelection(state);
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pointerId || mode === "idle") return;
    const state = getState();
    if (state.phase !== "playing") {
      abortGesture();
      return;
    }
    curWorld = eventWorld(e);
    const now = performance.now();

    if (mode === "pressed") {
      // --- Tap ---
      const p = hitTest(state.planets, curWorld.x, curWorld.y);
      const isDoubleTap =
        now - lastTapAt <= DOUBLE_TAP_MS && lastTapPlanetId === (p ? p.id : -1);

      if (p && p.owner === PLAYER) {
        // Toggle membership; accumulates across taps.
        if (selection.has(p.id)) {
          selection.delete(p.id);
        } else {
          selection.add(p.id);
          hapticTick();
        }
        lastSendSources = [];
      } else if (p) {
        // Tap a target. First tap sends 50% immediately (a speed game gets no
        // artificial confirm delay); a second tap inside the double-tap window
        // sends the rest, so the pair totals 100% per the spec's double-tap.
        if (isDoubleTap && lastSendSources.length > 0) {
          send(lastSendSources, p.id, 1.0);
        } else if (selection.size > 0) {
          lastSendSources = [...selection];
          send(lastSendSources, p.id, SEND_FRACTION);
          selection.clear();
        }
      } else {
        // Empty space: tap deselects; double-tap selects every owned planet.
        if (isDoubleTap) {
          for (const pl of state.planets) {
            if (pl.owner === PLAYER) selection.add(pl.id);
          }
          if (selection.size > 0) hapticTick();
        } else {
          selection.clear();
        }
        lastSendSources = [];
      }
      lastTapAt = now;
      lastTapPlanetId = p ? p.id : -1;
    } else if (mode === "dragPlanet") {
      // --- Aimed send: release on/near a target (snap ~20pt to planet edge).
      const target = hitTest(state.planets, curWorld.x, curWorld.y, SNAP_DIST);
      if (target) {
        lastSendSources = [...selection];
        send(lastSendSources, target.id, SEND_FRACTION);
        selection.clear();
        lastTapAt = now;
        lastTapPlanetId = target.id;
      }
      // No target: keep the selection — the drag still selected the planet.
    }
    // dragBox: selection was updated live; nothing to finalize.

    resetGesture();
  });

  canvas.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== pointerId) return;
    abortGesture();
  });

  return input;
}
