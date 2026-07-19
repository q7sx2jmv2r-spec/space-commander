// DOM chrome for the skirmish flow (QUA-124): setup form, pause button and
// overlay, end panel. Pure view layer — reads/writes the DOM and forwards
// button presses; all flow decisions live in main.ts's state machine. The
// game itself stays on the canvas underneath.

import { AiTier, FactionCount, TICK_RATE } from "./config";
import type { FlowState } from "./flow";

export interface SkirmishSettings {
  factions: FactionCount;
  /** Difficulty per AI opponent (ai1, then ai2 when factions=3). */
  tiers: AiTier[];
  /** Raw seed field text; "" = random. */
  seedText: string;
}

export interface EndInfo {
  won: boolean;
  ticks: number;
  captured: number;
  seed: number;
  tiers: readonly AiTier[];
}

export interface UiHandlers {
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onReplay(): void;
}

export interface Ui {
  showScreen(state: FlowState): void;
  readSettings(): SkirmishSettings;
  writeSettings(s: SkirmishSettings): void;
  showEnd(info: EndInfo): void;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function setActive(seg: HTMLElement, match: (b: HTMLButtonElement) => boolean): void {
  for (const b of Array.from(seg.querySelectorAll("button"))) {
    b.classList.toggle("active", match(b));
  }
}

function activeData(seg: HTMLElement, attr: string): string {
  const b = seg.querySelector<HTMLButtonElement>("button.active");
  return b?.dataset[attr] ?? "";
}

function formatTime(ticks: number): string {
  const total = Math.floor(ticks / TICK_RATE);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function attachUi(handlers: UiHandlers): Ui {
  const setupOverlay = $("setupOverlay");
  const pauseOverlay = $("pauseOverlay");
  const endOverlay = $("endOverlay");
  const pauseBtn = $("pauseBtn");
  const factionSeg = $("factionSeg");
  const ai2Row = $("ai2Row");
  const seedInput = $("seed") as HTMLInputElement;
  const aiSegs = Array.from(document.querySelectorAll<HTMLElement>(".seg[data-ai]"));

  // Segmented controls are radio groups: tap sets the active member.
  for (const seg of [factionSeg, ...aiSegs]) {
    seg.addEventListener("click", (e: MouseEvent) => {
      const b = e.target as HTMLElement;
      if (b.tagName !== "BUTTON") return;
      setActive(seg, (x) => x === b);
      if (seg === factionSeg) {
        ai2Row.classList.toggle("hidden", activeData(factionSeg, "factions") !== "3");
      }
    });
  }

  $("startBtn").addEventListener("click", handlers.onStart);
  pauseBtn.addEventListener("click", handlers.onPause);
  $("resumeBtn").addEventListener("click", handlers.onResume);
  $("restartBtn").addEventListener("click", handlers.onRestart);
  $("replayBtn").addEventListener("click", handlers.onReplay);

  function showScreen(state: FlowState): void {
    setupOverlay.classList.toggle("hidden", state !== "setup");
    pauseOverlay.classList.toggle("hidden", state !== "paused");
    endOverlay.classList.toggle("hidden", state !== "ended");
    pauseBtn.classList.toggle("hidden", state !== "playing");
  }

  function readSettings(): SkirmishSettings {
    const factions: FactionCount = activeData(factionSeg, "factions") === "3" ? 3 : 2;
    const tiers: AiTier[] = [];
    for (let i = 0; i < factions - 1; i++) {
      const seg = aiSegs.find((s) => s.dataset.ai === String(i));
      tiers.push((seg ? (activeData(seg, "tier") as AiTier) : "") || "medium");
    }
    return { factions, tiers, seedText: seedInput.value.trim() };
  }

  function writeSettings(s: SkirmishSettings): void {
    setActive(factionSeg, (b) => b.dataset.factions === String(s.factions));
    ai2Row.classList.toggle("hidden", s.factions !== 3);
    aiSegs.forEach((seg, i) => {
      const tier = s.tiers[i] ?? s.tiers[s.tiers.length - 1] ?? "medium";
      setActive(seg, (b) => b.dataset.tier === tier);
    });
    seedInput.value = s.seedText;
  }

  function showEnd(info: EndInfo): void {
    const title = $("endTitle");
    title.textContent = info.won ? "Victory" : "Defeat";
    title.className = info.won ? "victory" : "defeat";
    $("endSub").textContent = info.won ? "The sector is yours" : "Your fleet is lost";

    const stats: [string, string][] = [
      ["Time", formatTime(info.ticks)],
      ["Planets captured", String(info.captured)],
      ["Seed", String(info.seed)],
      ["Opponents", info.tiers.map((t, i) => `AI ${i + 1} ${t}`).join(", ") || "none"],
    ];
    const list = $("endStats");
    list.textContent = "";
    for (const [k, v] of stats) {
      const li = document.createElement("li");
      const key = document.createElement("span");
      key.textContent = k;
      const val = document.createElement("span");
      val.textContent = v;
      li.append(key, val);
      list.append(li);
    }
  }

  return { showScreen, readSettings, writeSettings, showEnd };
}
