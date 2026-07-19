// QUA-123 AI tests. Bundled by esbuild, run under plain node (proves the AI
// module is DOM-free). Throws on failure. Covers: determinism with AI active,
// per-tier guardrails on hardcoded states, and a deterministic matchup sanity
// check (hard must beat easy).

import { AiTier } from "../config";
import { aiDecide, AiState } from "../ai";
import { Fleet, GameState, Planet, update } from "../sim";
import { generateMap } from "../mapgen";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ai test FAILED: ${msg}`);
}

function mkState(planets: Planet[], fleets: Fleet[] = [], ai: AiState[] = []): GameState {
  const maxFleetId = fleets.reduce((m, f) => Math.max(m, f.id), -1);
  return {
    tick: 0,
    seed: 0,
    rng: { s: 1 },
    planets,
    fleets,
    nextFleetId: maxFleetId + 1,
    phase: "playing",
    ai,
  };
}

function planet(id: number, opts: Partial<Planet>): Planet {
  return {
    id,
    x: 0,
    y: 0,
    size: "medium",
    owner: "neutral",
    garrison: 0,
    heldTicks: 0,
    spec: "standard",
    nextSpec: "standard",
    convertTicks: 0,
    ...opts,
  };
}

function mkAi(tier: AiTier): AiState {
  return { owner: "ai1", tier, nextDecisionTick: 0 };
}

// 1. Determinism: same seed + tiers, AI active → bit-identical after 3000 ticks.
{
  const run = () => {
    const s = generateMap(777, 3, ["medium", "hard"]);
    for (let t = 0; t < 3000; t++) update(s, []);
    return JSON.stringify(s);
  };
  const a = run();
  assert(a === run(), "AI-active game diverged across identical runs");

  // Snapshot/resume mid-game must also stay identical (state.ai included).
  const orig = generateMap(777, 3, ["medium", "hard"]);
  for (let t = 0; t < 1500; t++) update(orig, []);
  const snap = JSON.parse(JSON.stringify(orig)) as GameState;
  for (let t = 0; t < 1500; t++) {
    update(orig, []);
    update(snap, []);
  }
  assert(JSON.stringify(orig) === JSON.stringify(snap), "snapshot diverged with AI state");
}

// 2. AI is actually alive: a medium AI launches fleets within its first decisions.
{
  const s = generateMap(4242, 2, ["medium"]);
  let sawAiFleet = false;
  for (let t = 0; t < 1200 && !sawAiFleet; t++) {
    update(s, []);
    sawAiFleet = s.fleets.some((f) => f.owner === "ai1");
  }
  assert(sawAiFleet, "medium AI issued no sends in 20s");
}

// 3. Easy is naive: attacks on raw garrison comparison (no travel-production math).
{
  const s = mkState([
    planet(0, { owner: "ai1", garrison: 12 }),
    planet(1, { owner: "neutral", size: "small", garrison: 5, x: 400 }),
  ]);
  const cmds = aiDecide(s, mkAi("easy"));
  assert(cmds.length === 1 && cmds[0]!.to === 1, "easy did not take the naive shot");
}

// 4. Medium refuses provably-futile attacks (target garrison + production over travel).
{
  const s = mkState([
    planet(0, { owner: "ai1", garrison: 10 }),
    planet(1, { owner: "player", garrison: 20, x: 400 }),
  ]);
  const cmds = aiDecide(s, mkAi("medium"));
  assert(cmds.length === 0, `medium sent a futile attack (${JSON.stringify(cmds)})`);
}

// 5. Medium reinforces a threatened planet from the nearest helper.
{
  const s = mkState(
    [
      planet(0, { owner: "ai1", garrison: 5 }),
      planet(1, { owner: "ai1", garrison: 20, x: 300 }),
    ],
    [{ id: 0, owner: "player", ships: 15, originId: 1, destId: 0, progress: 0.2, damage: 0 }]
  );
  const cmds = aiDecide(s, mkAi("medium"));
  assert(cmds.length === 1, `expected exactly the reinforcement (got ${cmds.length})`);
  const c = cmds[0]!;
  assert(c.type === "send" && c.to === 0 && c.from[0] === 1, "reinforcement not from helper to threatened planet");
}

// 6. Guardrail: never leave a planet unable to defend a known incoming fleet.
{
  const s = mkState(
    [
      planet(0, { owner: "ai1", garrison: 12 }),
      planet(1, { owner: "neutral", size: "small", garrison: 1, x: 300 }),
    ],
    [{ id: 0, owner: "player", ships: 10, originId: 1, destId: 0, progress: 0.1, damage: 0 }]
  );
  const cmds = aiDecide(s, mkAi("medium"));
  assert(cmds.length === 0, `medium abandoned its defense to attack (${JSON.stringify(cmds)})`);
}

// 7. Hard pools 2–3 planets to take a target no single planet could.
{
  const s = mkState([
    planet(0, { owner: "ai1", garrison: 10 }),
    planet(1, { owner: "ai1", garrison: 10, x: 150 }),
    planet(2, { owner: "ai1", garrison: 10, x: 300 }),
    planet(3, { owner: "player", garrison: 13, x: 600 }),
  ]);
  const cmds = aiDecide(s, mkAi("hard"));
  const pooled = cmds.find((c) => c.type === "send" && c.to === 3);
  assert(pooled !== undefined, `hard did not attack the big target (${JSON.stringify(cmds)})`);
  assert(
    pooled!.type === "send" && pooled!.from.length >= 2,
    `hard did not pool sources (${JSON.stringify(pooled)})`
  );
}

// 8. Hard counter-attacks a just-emptied enemy planet over a marginally
// cheaper neutral.
{
  const s = mkState([
    planet(0, { owner: "ai1", garrison: 20 }),
    planet(1, { owner: "neutral", size: "small", garrison: 1, x: 400 }),
    planet(2, { owner: "player", garrison: 2, y: 400 }),
  ]);
  const cmds = aiDecide(s, mkAi("hard"));
  assert(cmds.length > 0 && cmds[0]!.to === 2, `hard did not counter the emptied planet (${JSON.stringify(cmds)})`);
}

// 9. Matchup sanity: hard (ai1) vs easy (driving the player faction) on fixed
// seeds — hard must win within 5 sim-minutes. Fully seeded → stable outcomes.
{
  const MAX_TICKS = 5 * 60 * 60;
  let hardWins = 0;
  const seeds = [11, 22, 33];
  for (const seed of seeds) {
    const s = generateMap(seed, 2, ["hard"]);
    s.ai.push({ owner: "player", tier: "easy", nextDecisionTick: 0 });
    let t = 0;
    while (s.phase === "playing" && t < MAX_TICKS) {
      update(s, []);
      t++;
    }
    if (s.phase === "aiWon") hardWins++;
  }
  assert(hardWins === seeds.length, `hard beat easy in only ${hardWins}/${seeds.length} matches`);
}

console.log("ai tests OK (determinism+snapshot, activity, easy-naive, futile-refusal, reinforce, defense guardrail, pooling, counter-emptied, hard-beats-easy x3)");
