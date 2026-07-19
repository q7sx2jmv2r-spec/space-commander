// Haptic feedback (QUA-122). Single funnel for every vibration in the game so
// the Capacitor haptics plugin can swap in at Phase 3 by replacing `buzz`.
// Uses the web Vibration API: silently a no-op where unsupported (iOS Safari
// never fires it — expected, per ticket; don't work around it).

let enabled = true;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

function buzz(pattern: number | number[]): void {
  if (!enabled) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(pattern);
}

/** Light tick: planet selected / rubber-band selection count changed. */
export function hapticTick(): void {
  buzz(10);
}

/** Medium impact: a planet was captured or lost. */
export function hapticImpact(): void {
  buzz(35);
}

/** Success pattern: the player won. */
export function hapticSuccess(): void {
  buzz([40, 60, 40, 60, 80]);
}
