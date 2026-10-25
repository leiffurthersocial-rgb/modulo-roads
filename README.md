# Modulo Roads

A calm, endless, procedurally generated drive through Switzerland. No goals, no fail states, no traffic — just the road, the weather and the light.

Built with **TypeScript + Three.js + Vite**. Designed first for **Safari on iPad with a hardware keyboard** (Magic Keyboard), and also runs in desktop Chrome, Safari, Edge and Firefox.

## Deploy (GitHub → Vercel)

The game is a static Vite build; nothing runs on a server.

1. In Vercel choose **Add New → Project** and import this GitHub repository.
2. Vercel reads `vercel.json` (framework Vite, `npm run build`, output `dist`) — just click **Deploy**.
3. Every push to the production branch redeploys automatically; other branches get preview URLs.

`vercel.json` also serves the service worker uncached (so updates arrive) and caches the hashed assets forever.

## Install on an iPad

1. Open your Vercel URL in Safari.
2. Tap **Share → Add to Home Screen**. Launching from the Home Screen gives full screen, landscape, and offline play (the service worker caches the game after the first visit).
3. Turn the iPad to landscape, connect the Magic Keyboard and drive with **W A S D** or the arrow keys.
4. The Magic Keyboard has no Escape key: pause with **`** (backtick) or **⌘ .**.
5. On a long drive, press **B** for Low Battery Mode.

If no keyboard is detected, on-screen touch controls appear automatically (Settings → Controls to force them on or off).

## Controls

| Action | Keys |
| --- | --- |
| Accelerate / brake & reverse | W / S or ↑ / ↓ |
| Steer | A / D or ← / → |
| Handbrake · Boost | Space · Shift |
| Shift up / down (manual) | E / Q |
| Cycle camera | C |
| Headlights (auto/on/off) | H |
| Reset car onto the road | R |
| Photo mode | P (arrows orbit, Q/E zoom, F filter, Enter save) |
| Low Battery Mode | B |
| Mute | M |
| Pause / menu | Esc, \` or ⌘ . |
| Settings | Tab |
| Cruise control · Auto-drive | K · L |
| Next radio station | N |
| Hide HUD · Fullscreen | U · F |
| Jump to a region | 1–8 (0 = Auto journey on the start screen) |
| All shortcuts | ? |

Every binding can be changed in **Settings → Controls**.

## Regions

1. **Mittelland** – rolling meadows, orchards, cows, Emmental farmhouses, SBB trains
2. **Alpine Pass** – snow peaks, hairpin switchbacks, tunnels, stone viaducts, waterfalls, marmots
3. **Lake District** – lakeside roads, Lavaux vineyards, sailboats and paddle steamers
4. **Ticino** – palms, cypresses, stone villages, terraced hills, warm light
5. **Engadin** – larch forests turning gold, deep blue skies, glacier valleys, Rhaetian-style trains
6. **Jura** – folded ridges, dense firs, pastures and low mist
7. **Valais** – dry rocky valley, vineyards, stone walls, cable cars
8. **Zurich Outskirts** – lake views, trams, and a dusk skyline with the Grossmünster's twin towers, the Fraumünster spire and St. Peter

**Auto journey** cross-fades between all of them as you drive. A seed (shown on the start screen and pause menu) always reproduces the same route.

## Settings

- **Graphics** – presets (Low/Medium/High/Ultra), render distance, shadows, anti-aliasing (FXAA/MSAA), resolution scale, dynamic resolution, bloom, vignette, depth of field, colour grading, film grain, water reflections, grass and tree density, FPS cap, FPS counter
- **Camera** – chase, far chase, hood, cockpit, bumper, free orbit; FOV; speed FOV; smoothing; sway; photo mode with filters
- **Time & weather** – time of day, day/night cycle and day length, clear / partly cloudy / overcast / fog / rain / snow / storm, cloud density, wind, season
- **Driving** – five cars (hatchback, estate, coupé, classic, alpine post van), automatic/manual, steering sensitivity, steering assist, lane-keeping auto-drive, cruise control, km/h or mph, headlights, wipers
- **Road** – lane markings, guardrails, curvature, hilliness, width, tunnel & bridge frequency
- **Audio** – master, engine, ambience, music, interface; procedural radio ("Lucerne Lo-Fi" and "Alpenglühn Ambient")
- **General** – Low Battery Mode, battery suggestions, HUD fading, title cards, compass, reset

Everything is saved to `localStorage`, along with your current journey (Continue) and a trip log.

## Low Battery Mode

Toggle with **B** or in Settings. It caps at 30 FPS, drops resolution to 60–75 %, turns off shadows, post-processing and water reflections, shortens the draw distance (fog hides the edge), thins out grass/trees/particles, simplifies clouds, reduces audio processing (no reverb, fewer voices) and stops environment-map refreshes. Rendering always pauses while the tab is hidden. A leaf icon in the HUD shows the estimated saving.

Where the **Battery Status API** exists (Chromium browsers) the game suggests the mode below 30 % when unplugged. Safari has no such API, so on iPad it falls back to suggesting it after sustained slow frames — or simply press B.

## Architecture

```
src/
  main.ts            boot, WebGL check, service worker
  Game.ts            orchestrator: states, frame loop, settings → systems
  core/              Engine (renderer, capped rAF loop, visibility pause), Input (rebindable, iPad-safe),
                     Settings (typed store + presets), Save (journey, trip log), rng/noise, math, events
  world/             Road (streaming spline pipeline), TerrainField (biome height functions),
                     Terrain (corridor flattening + valley carving), TerrainTiles (LOD tiles, skirts, pooling),
                     RoadChunks (asphalt, guardrails, tunnels, viaducts, rail), Props (instanced pools),
                     Models, Biomes, Season, Sky, Atmosphere, Weather, Water, Backdrop, Railway, Materials
  vehicle/           Cars (definitions + models), Vehicle (arcade physics), CameraRig
  audio/             AudioEngine (engine/tyres/wind/ambience), Radio (procedural music)
  ui/                UI (HUD, menus, photo bar, touch), SettingsPanel, Previews, styles.css
  perf/              Quality (effective settings, cost model, dynamic resolution), LowBattery, PostFX
```

### How the road is made

The route is a sequence of samples 2 m apart produced by a streaming pipeline, each stage lagging behind the previous by the look-ahead it needs:

1. **XZ** – curvature from layered noise, pulled towards a slowly wandering base direction so the road never loops back on itself; a small look-ahead planner probes a fan of headings and prefers gentle grades and dry land (so roads follow valley floors and lake shores); hairpin switchback sequences on mountain slopes.
2. **Elevation** – the natural ground is smoothed, then fitted with the *minimax grade-limited profile* (average of the upper and lower Lipschitz envelopes, biased towards cutting), then softened for gentle crests and dips.
3. **Structures** – sustained deep cuts become tunnels, sustained high fills (and lake crossings) become bridges; long straight-ish sections in rail regions get a parallel railway.
4. **Final** – banking from smoothed curvature, insertion into a spatial hash.

Terrain is then flattened into a corridor around the road and hills are carved back into valley walls, so terrain, props and physics all agree on a single `heightAt()`.

### Performance notes

- Terrain tiles: 4 LODs with skirts, pooled geometry buffers, time-sliced building with a per-frame budget (2 ms in Low Battery Mode), dirty-rebuild only where new road appears.
- Props: one global `InstancedMesh` pool per model part with swap-remove slots — draw calls stay constant no matter how many chunks are loaded.
- Geometry is stored relative to chunk/tile origins so float32 precision holds hundreds of kilometres into a journey.
- Sky, water, rain and snow animate entirely on the GPU; the sky renders last so only visible sky pixels pay for the cloud shader.
- Physics runs at a fixed 120 Hz with no per-step allocations.
- Lights never get added/removed at runtime (headlights fade intensity) to avoid shader recompiles.
- Dynamic resolution holds the target frame rate on iPad; the FPS counter (Settings → Graphics) shows frame time, draw calls and triangles for profiling.

Terrain is generated on the main thread in small time slices rather than in a worker — generation depends on the live road data, and the slices are small enough that a worker added more complexity than it saved.

## Credits

All geometry, textures, music and sound are generated procedurally at runtime. No external assets, no copyrighted music.
