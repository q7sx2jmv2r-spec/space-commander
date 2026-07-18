# Space Commander

A mobile planet-capture RTS tech demo (Galcon-style). TypeScript + HTML5 Canvas 2D, no game framework, no runtime dependencies. Built for one-handed portrait play in mobile browsers.

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

## Architecture notes (for later phases)

- **Fixed-timestep simulation.** The simulation ticks at exactly 60Hz via an accumulator loop and is fully decoupled from rendering, which interpolates between the last two ticks.
- **Determinism.** The simulation must be a pure function of state + inputs. `Math.random` is banned; later phases use a seeded PRNG for map generation and AI so the same seed always reproduces the same game.
- **Serializable state.** All game state lives in a single JSON-serializable object (`GameState`) — plain data only — so games can be snapshotted, replayed, and diffed.
- **Logical world space.** The simulation runs in a fixed 1000×1600 portrait world; rendering scales it to the screen (devicePixelRatio-aware). Screen size never affects simulation results.
