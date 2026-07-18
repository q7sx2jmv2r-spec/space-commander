# Space Commander

A mobile planet-capture RTS tech demo (Galcon-style). TypeScript + HTML5 Canvas 2D, no game framework, no runtime dependencies. Built for one-handed portrait play in mobile browsers.

## How to play

You are blue (bottom planet); the AI is red (top). Tap your planets to select them (tap again to deselect), then tap any enemy or neutral planet to send 50% of each selected garrison. Owned planets produce ships over time proportional to their size; a fleet that arrives at a hostile planet trades ships 1:1 with the garrison and captures it if any attackers remain. Take every red planet to win. Games are seeded and reproducible — share the URL (`?seed=`) to share the exact same map and AI behavior.

## Prerequisites

- Node.js 20+ (22 recommended)

## Build

```sh
npm ci
npm run build
```

Type-checks with `tsc` and bundles `src/main.ts` into `dist/` with esbuild. `dist/` is the complete deployable site.

## Run locally

```sh
npm run serve
```

Serves the game at http://127.0.0.1:8000 and rebuilds the bundle on every reload. To test on a phone, bind to your LAN instead: change `--serve=127.0.0.1:8000` to `--serve=0.0.0.0:8000` in `package.json` and open `http://<your-machine-ip>:8000`.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the project and publishes `dist/` to the `gh-pages` branch; GitHub Pages serves that branch. The site is served from the repo's Pages URL (`https://<owner>.github.io/space-commander/`). Creating the `gh-pages` branch enables Pages automatically on first deploy; if the site 404s, check Settings → Pages is set to deploy from the `gh-pages` branch.

## Testing

```sh
npm run test:determinism
```

Bundles the simulation (`src/test/determinism.ts`) and runs it under plain node: same seed twice for 5000 ticks must produce bit-identical JSON state, different seeds must diverge, and a mid-game `JSON.parse(JSON.stringify(...))` snapshot must not change the future. Running under node also proves the sim modules are DOM-free.

## Architecture notes

- **Fixed-timestep simulation.** The simulation (`src/sim.ts`, DOM-free) ticks at exactly 60Hz via an accumulator loop in `src/main.ts` and is fully decoupled from rendering (`src/render.ts`), which interpolates between the last two ticks (fleets matched by id).
- **Determinism.** The simulation is a pure function of state + commands. `Math.random` is banned; a seeded mulberry32 PRNG (`src/rng.ts`) lives *inside* `GameState` and drives map generation (`src/mapgen.ts`) and AI decisions, so the same seed always reproduces the same game. RNG draw order is part of the contract.
- **Serializable state.** All game state lives in a single JSON-serializable object (`GameState`) — plain data only — so games can be snapshotted, replayed, and diffed. UI state (selection) lives in `src/input.ts`, never in the sim; input produces commands that enter the sim only at tick boundaries.
- **Logical world space.** The simulation runs in a fixed 1000×1600 portrait world; rendering scales it to the screen (devicePixelRatio-aware). Screen size never affects simulation results.
