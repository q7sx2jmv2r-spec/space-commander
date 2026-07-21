// World-anchored HUD chrome (QUA-131): the 25/50/100% send-fraction chip, the
// spec button that appears beside a single-selected planet, and the QUA-130
// specialisation type picker. DOM rather than canvas — it reuses the .seg
// button ergonomics and 44pt targets from index.html and stays out of the
// canvas gesture machine (tap semantics remain pure: the picker only ever
// opens via its button, never from a planet tap). main.ts calls update() once
// per frame; styles are only written when their values change.

import { GameState, Planet, PLAYER, Spec } from "./sim";
import { SPECS, SIZE_RADIUS } from "./config";
import { worldTransform } from "./render";
import type { InputView } from "./input";

export interface HudHandlers {
  /** Cycle the send fraction to its next step. */
  onFractionCycle(): void;
  /** Issue a convert command for the planet (validated by the sim). */
  onConvert(planetId: number, to: Spec): void;
}

export interface Hud {
  update(state: GameState, view: InputView, playing: boolean): void;
}

/** Picker entries: miniature silhouettes of the QUA-127 shape language
 * (circle / hexagon / ring / rounded square) so the picker itself teaches
 * how specs read on the map. Static trusted SVG, `currentColor` so the
 * existing text-colour and :disabled styles apply. */
const SPEC_OPTIONS: ReadonlyArray<{ to: Spec; glyph: string; label: string }> = [
  {
    to: "standard",
    glyph: '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>',
    label: "Std",
  },
  {
    to: "defence",
    glyph: '<svg width="22" height="22" viewBox="0 0 24 24"><polygon points="12,3 19.8,7.5 19.8,16.5 12,21 4.2,16.5 4.2,7.5" fill="currentColor"/></svg>',
    label: "Def",
  },
  {
    to: "naval",
    glyph: '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5.5" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="3.4" transform="rotate(-20 12 12)" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    label: "Nav",
  },
  {
    to: "economy",
    glyph: '<svg width="22" height="22" viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="15" height="15" rx="5" fill="currentColor"/></svg>',
    label: "Eco",
  },
];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

export function attachHud(canvas: HTMLCanvasElement, handlers: HudHandlers): Hud {
  const fracChip = $("fracChip") as HTMLButtonElement;
  const specBtn = $("specBtn") as HTMLButtonElement;
  const picker = $("specPicker");
  const pickerCost = $("specPickerCost");

  // Build the four picker buttons once.
  const pickerButtons: HTMLButtonElement[] = SPEC_OPTIONS.map((opt) => {
    const b = document.createElement("button");
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.innerHTML = opt.glyph; // static silhouette markup from SPEC_OPTIONS
    const label = document.createElement("span");
    label.textContent = opt.label;
    b.append(glyph, label);
    b.addEventListener("click", () => {
      if (pickerFor >= 0) handlers.onConvert(pickerFor, opt.to);
      pickerFor = -1;
    });
    return b;
  });
  const row = $("specPickerRow");
  for (const b of pickerButtons) row.append(b);

  let pickerFor = -1; // planet id the picker is open for; -1 = closed
  let shownPlanetId = -1; // planet the spec button is currently beside

  fracChip.addEventListener("click", handlers.onFractionCycle);
  specBtn.addEventListener("click", () => {
    pickerFor = pickerFor >= 0 ? -1 : shownPlanetId;
  });
  // Any interaction with the game itself dismisses the picker.
  canvas.addEventListener("pointerdown", () => {
    pickerFor = -1;
  });

  // Cached last-written values so per-frame updates touch the DOM rarely.
  let lastFracText = "";
  let lastFracVisible: boolean | null = null;
  let lastBtnVisible: boolean | null = null;
  let lastPickerVisible: boolean | null = null;
  let lastBtnX = -1e9;
  let lastBtnY = -1e9;
  let lastPickerX = -1e9;
  let lastPickerY = -1e9;
  let lastAffordable: boolean | null = null;

  function setVisible(el: HTMLElement, visible: boolean, last: boolean | null): boolean {
    if (last !== visible) el.classList.toggle("hidden", !visible);
    return visible;
  }

  /** World → viewport css px, matching the canvas transform. */
  function toScreen(wx: number, wy: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const t = worldTransform(rect.width, rect.height);
    return { x: rect.left + t.offsetX + wx * t.scale, y: rect.top + t.offsetY + wy * t.scale };
  }

  function singleSelectedPlanet(state: GameState, view: InputView): Planet | null {
    if (view.selection.size !== 1) return null;
    for (const id of view.selection) {
      const p = state.planets[id];
      if (p && p.owner === PLAYER) return p;
    }
    return null;
  }

  function update(state: GameState, view: InputView, playing: boolean): void {
    // --- Send-fraction chip: visible whenever a send could be aimed. ---
    const fracVisible = playing && view.selection.size > 0;
    lastFracVisible = setVisible(fracChip, fracVisible, lastFracVisible);
    if (fracVisible) {
      const text = `${Math.round(view.sendFraction * 100)}%`;
      if (text !== lastFracText) {
        fracChip.textContent = text;
        lastFracText = text;
      }
    }

    // --- Spec button beside exactly one selected owned planet. ---
    const p = playing ? singleSelectedPlanet(state, view) : null;
    shownPlanetId = p ? p.id : -1;
    if (!p || view.drag !== null) {
      // Hidden while dragging so it never sits under the aim gesture.
      lastBtnVisible = setVisible(specBtn, false, lastBtnVisible);
      if (!p) pickerFor = -1;
    } else {
      lastBtnVisible = setVisible(specBtn, true, lastBtnVisible);
      const r = SIZE_RADIUS[p.size];
      const s = toScreen(p.x + r, p.y - r);
      const x = Math.min(Math.max(s.x - 4, 8), window.innerWidth - 52);
      const y = Math.min(Math.max(s.y - 40, 8), window.innerHeight - 52);
      if (Math.abs(x - lastBtnX) > 0.5 || Math.abs(y - lastBtnY) > 0.5) {
        specBtn.style.left = `${x}px`;
        specBtn.style.top = `${y}px`;
        lastBtnX = x;
        lastBtnY = y;
      }
    }
    if (pickerFor >= 0 && (!p || p.id !== pickerFor)) pickerFor = -1;

    // --- Type picker near the planet. ---
    const pickerVisible = pickerFor >= 0 && p !== null;
    lastPickerVisible = setVisible(picker, pickerVisible, lastPickerVisible);
    if (pickerVisible && p) {
      const r = SIZE_RADIUS[p.size];
      const s = toScreen(p.x, p.y + r);
      const w = picker.offsetWidth || 240;
      const x = Math.min(Math.max(s.x - w / 2, 8), window.innerWidth - w - 8);
      const y = Math.min(Math.max(s.y + 10, 8), window.innerHeight - (picker.offsetHeight || 96) - 8);
      if (Math.abs(x - lastPickerX) > 0.5 || Math.abs(y - lastPickerY) > 0.5) {
        picker.style.left = `${x}px`;
        picker.style.top = `${y}px`;
        lastPickerX = x;
        lastPickerY = y;
      }
      const affordable = p.garrison >= SPECS.costShips && p.convertTicks === 0;
      if (affordable !== lastAffordable) {
        for (const b of pickerButtons) b.disabled = !affordable;
        pickerCost.textContent = affordable
          ? `${SPECS.costShips} ships · ${SPECS.convertTime}s`
          : p.convertTicks > 0
            ? "converting…"
            : `needs ${SPECS.costShips} ships`;
        lastAffordable = affordable;
      }
    }
  }

  return { update };
}
