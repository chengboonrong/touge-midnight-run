# Racing Feel Audit — TOUGE: Midnight Run (Phase 0)

Scope: read-only audit of the existing game. No gameplay code was changed.
Everything under "Current behaviour" and "Defects" is derived from reading the
cited source. Nothing here was observed in a browser; feel, FPS and frame time
were not measured.

## 1. Baseline

- `npm run typecheck`: exit 0.
- `npm test`: 69 passed, 0 failed (GameLoop, Input, TouchControls, MountainPass,
  Assets, RaycastVehicle incl. the Rapier `0.14.0` pin check).
- `npm run build`: not run in this session (no code changed).
- Dependencies (`package.json`): `three 0.169.0`, `@dimforge/rapier3d-compat 0.14.0`
  (exact), dev: `typescript`, `vite`, `@types/three`. No audio or post-processing library.

Files read: `src/main.ts`, `src/config.ts`, `src/core/{GameLoop,Input}.ts`,
`src/physics/{RaycastVehicle,PhysicsWorld}.ts`, `src/entities/Car.ts`,
`src/render/SceneSetup.ts`, `src/ui/{Hud,TouchControls}.ts`, `src/world/MountainPass.ts`,
`package.json`, `test/RaycastVehicle.test.mjs`.
Not read: `index.html`, `src/styles.css`, the other five test files (results seen,
contents not), `tools/blender/*`, the `.glb`/`.json` asset contents.

Asset inventory: `public/assets/touge/` holds `coupe.glb`, `mountain_pass.glb`,
`route.json`, `build_manifest.json`, `pass_manifest.json`. `art/touge/` holds two
`.blend` sources and five preview PNGs. `public/art` and `docs/` did not exist.
**There are no audio files anywhere in the listed directories.**

## 2. Current behaviour (with evidence)

**Loop** — `src/core/GameLoop.ts`. Fixed 60 Hz accumulator, frame time clamped to
0.1 s, render gets an interpolation alpha. Tests cover 30/60/120/144 Hz render
rates. `Car.ts` interpolates chassis and wheel poses. Simulation is already
independent of render rate.

**Vehicle** — `src/physics/RaycastVehicle.ts`, tuning in `src/config.ts` (`VEHICLE`).
- One dynamic Rapier body, four suspension rays, forces applied as impulses at
  the contact points. No velocity is set directly except in `reset()`. Drift is
  not faked by rotating the body.
- Drive: `throttle * engineForce * (1 - (v/topSpeed)^2)` split over the rear
  wheels. No engine, RPM, gears, clutch or rev limiter exist.
- Brakes: 12 000 N total, 68 % front. Handbrake: 6 000 N on the rear axle, drive
  cut, rear lateral grip multiplied by 0.35, all switched instantly.
- Tyres: lateral request = `-sideSpeed * slipForcePerSpeed`, where
  `slipForcePerSpeed = slipResponse * (mass/4) / dt` (8 100 N per m/s with current
  values). Longitudinal and lateral are then scaled together onto a friction
  ellipse sized by wheel load.
- Wheels have no rotational state: `spinSpeed = rollingSpeed / radius`, or 0 when
  handbraked. So there is no slip ratio and no wheelspin.
- Weight transfer is emergent only (forces act below the centre of mass, loads
  come from the springs). Grip is linear in load, centre of mass is fixed at the
  box centre.
- Steering: lock shrinks linearly from 0.55 rad to 20 % at 40 m/s; rate-limited
  at 2.5 rad/s. Input is binary (-1/0/+1).

**Input** — `src/core/Input.ts`, `src/ui/TouchControls.ts`. W/A/S/D/Space held, R
reset, touch buttons mirror them. `HeldCode` is a closed union of those five
codes. No gamepad, no analogue axis, no shift keys, no pause.

**Camera** — inline in `src/main.ts` (`updateCamera`). Exponential position follow
(stiffness 5 /s, uses frame dt), fixed 7.5 m back, 1.35 m lateral offset, look
target 5 m ahead. FOV 63° to 68° over 0–50 m/s. Heading comes from the chassis
yaw. No roll, shake, drift offset, or velocity look-ahead.

**Rendering** — `src/render/SceneSetup.ts`. Single forward pass, ACES tone
mapping, one 2048² shadow map over a 380 m frustum, pixel ratio capped at 1.75,
exponential fog. No post-processing, particles, skid marks, quality presets or
FPS readout.

**HUD** — `src/ui/Hud.ts`. Speed (km/h), a status word, a canvas minimap and a
control legend, updated at most every 80 ms. No tachometer, gear, timer, splits.

**Race systems / audio / music** — none. There is no race state, countdown,
checkpoint, lap, timer, persistence, `AudioContext`, or music code.
`route.json` supplies a closed polyline, width and length (used by the minimap only).

**Collisions** — `PhysicsWorld.step()` calls `world.step()` with no event queue,
so the game currently has no impact or scrape signal.

## 3. Defects (derivable from the code)

D1. **Longitudinal force collapses while sliding.** In `RaycastVehicle.update`
the lateral request is unbounded before the ellipse scaling. At 5 m/s of side
slip the request is about 40 kN against roughly 3–3.5 kN of lateral grip, so
`usage` is about 12 and brake and drive forces are divided by the same factor.
Throttle and foot brake therefore do very little during a slide. This blocks
throttle-held drifts and braking while sideways. Derived arithmetically; not yet
confirmed by a test (see slice 1, step 1).

D2. **Lateral force is keyed to slip velocity, not slip angle.** With 8 100 N
per m/s and about 3.1 kN of front grip per wheel at static load, a front tyre
saturates near 0.38 m/s of side slip regardless of speed. At 40 m/s that is
about 0.5° of slip angle. The curve is linear then flat, with no peak or
fall-off. The stiffness also scales with `1/dt`, so tuning is tied to `PHYSICS_HZ`.

D3. **No slip telemetry.** `WheelState` exposes forces and load but not side
slip or slip speed. Tyre smoke, skid marks, screech and drift scoring need it.

D4. **No straight-line wheelspin model.** Drive per rear wheel
is 3 250 N; static longitudinal grip is about 4 400 N (1.5 × 2 943 N). Combined
with D1, this limits throttle control during a slide. It does not prove that
power oversteer cannot occur in a turn, where lateral force also uses the grip budget.

D5. **Camera lag grows with speed without limit.** A first-order follower
trails a moving target by `v / stiffness`: about 10 m extra at 50 m/s on top of
the 7.5 m distance. Derived, not measured.

D6. **Dead config.** `CHASE_CAMERA.height` and `.lookHeight` are unused;
`main.ts` hard-codes 2.65, 0.6, 1.35 and 5.

D7. **Reset always returns to the spawn**, not to the nearest route point.

## 4. Tuning hypotheses (subjective, need a human drive to confirm)

- H1. Front 1.05 / rear 1.2 lateral grip with a 50/50 static load suggests
  steady-state understeer.
- H2. `angularDamping 0.5` on all axes may make rotation feel numb and slow
  drift transitions.
- H3. Instant handbrake grip switching may make drift entry and exit abrupt.
- H4. Binary steering with a 2.5 rad/s rate and equal return rate may feel
  either laggy or twitchy; no countersteer aid exists.
- H5. A 5° FOV range and no near-field cues may give a weak sense of speed.
- H6. Force taper with no gears gives featureless acceleration.

None of these is a measured finding.

## 5. Testing and measurement limits

- Node tests run the real vehicle code against real Rapier on a flat slab.
  They cannot judge feel, the actual pass geometry, camera comfort or audio.
- No browser, FPS, frame-time or memory measurement exists in the repo. A
  target desktop machine for the 60 FPS goal has not been defined by the owner.
- Web Audio cannot be exercised under `node --test`; audio logic must be split
  into pure functions (testable) and a thin `AudioContext` layer (manual check).
- Existing tests constrain changes: engine speed ceiling, rear-only drive,
  bit-exact determinism, `tireForce <= maxGrip * load`, zero force in the air,
  reset state. Any slice must keep them or change them deliberately and say so.

## 6. Proposed first slice: tyre saturation and slip telemetry

Chosen because D1–D3 sit underneath drifting, smoke, skid marks and tyre audio.
This is a judgement; the engine/gearbox slice is the alternative first step.

Changes, `src/physics/RaycastVehicle.ts` only (plus tests):
1. Add a failing test first that reproduces D1 (forward 15 m/s plus 6 m/s side
   slip, full brake) and record the current numbers. If it does not fail, D1 is
   wrong and the slice is re-planned.
2. Clamp the lateral request to its own grip limit before the ellipse scaling.
3. Add read-only `slipSpeed` (contact side speed, m/s) to `WheelState`.

Out of scope for slice 1: slip-angle curve (D2), engine, gears, steering
changes, any retuning of `VEHICLE` values, camera, audio.

Acceptance tests:
- A1. All 69 existing tests pass unmodified, including determinism and grip bound.
- A2. In the D1 scenario every grounded wheel's `|longitudinalForce|` is at
  least 0.5 × `min(requested brake, gripLongitudinal × load)`.
- A3. `slipSpeed` is finite, 0 in the air, 0 after `reset()`, and its sign
  follows the slide direction.
- A4. Handbrake-slide test numbers (yaw rate, slide speed) are recorded before
  and after; the existing assertions still hold.
- A5. `typecheck`, `test`, `build` all exit 0; Rapier pin test passes.
- Manual (human, browser): W/A/S/D/Space/R and touch still work; throttle now
  affects a slide after the handbrake is released (drive stays cut while it is held).
  Report as untested until someone drives it.

## 7. Remaining backlog (in required order)

Handling (after slice 1)
- Slip-angle tyre curve with peak and fall-off, independent of `dt` (D2).
- Engine torque curve, RPM, gear ratios, final drive, auto shifting; manual
  shifting later (needs new `Input` codes and tests).
- Steering smoothing, countersteer and drift assist (configurable strength).
- Progressive handbrake grip, centre-of-mass offset, load sensitivity.
- Dev tuning panel bound to `VEHICLE` (dev builds only).

Camera and speed: extract camera module from `main.ts`, bound the lag (D5),
wider FOV range, drift roll and lateral offset, shake on impact (needs Rapier
contact events), speed lines, slip-driven smoke, skid marks, quality presets.
Motion blur only after profiling.

Audio: Web Audio manager resumed on first user gesture; engine layers driven by
RPM; slip-driven tyre noise; wind, road, impact, scrape; race cues; separate
SFX volume, mute, saved preferences.

Music: state-driven manager (menu, preparation, race, results), crossfades,
separate volume. No tracks until licensed files exist.

Race and HUD: race state machine, 3-2-1-GO, checkpoints from `route.json`,
timer, splits, personal best (local storage), tachometer, gear, drift
angle/score, ghost recording interface, respawn on route (D7).

Manga feedback: event-driven streaks, stylised smoke, impact frames, near-miss.

Optimisation: FPS and frame-time readout, low-quality preset, leak checks.

## 8. Audio and music licensing placeholders

- The repo contains no sound or music files. None may be claimed to exist.
- Until licensed or original recordings are supplied, all sounds will be
  synthesised at runtime with Web Audio oscillators and noise, and labelled in
  code and in a `docs/audio-assets.md` table as `TEMP-SYNTH`.
- Each real asset must be recorded there with: file, source, author, licence,
  attribution text, and date verified playable.
- Music requirement to hand to a composer or licensed library: original
  Eurobeat-inspired electronic tracks, 145–165 BPM, loopable, four states (menu,
  preparation, race, results), no borrowed melodies or samples from existing
  songs. OGG plus an MP3 or AAC fallback; loop points documented.
- No Initial D music, recordings, logos or names are to be used.

## Host verification and first-slice decision

The host independently ran typecheck, all 69 tests and the production build on
2026-11-12; all passed. Vite retains its pre-existing large-chunk warning.
A real Rapier flat-slab probe at 15 m/s forward speed measured front lateral
grip usage at 28% for 0.1 m/s sideways, 70% for 0.25 m/s and effectively 100%
from 0.5 m/s upwards (1.91 degrees of slip). This confirms early saturation,
not a subjective driving assessment. The target host is an Apple M1 Max,
10 CPU cores, 64 GiB RAM, macOS 27.0. Browser FPS is still unmeasured.

Implement D1 and signed contact-side-slip telemetry as the first small commit;
validate before attempting a slip-angle curve or drivetrain. Keep the existing
fixed-step loop, suspension, input, asset rendering and grip ellipse.
