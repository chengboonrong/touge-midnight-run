# Optimization progress — 2026-11-13

The user authorized using the remaining cumulative $50 Claude API budget.
The ledger history is preserved, with $5 held for final testing/fixes during
implementation. Each increment is reviewed, checked locally and committed.
Default runner ceiling remains 128,000 tokens; smaller bounded proposals use
an explicit per-request ceiling to avoid reserving $5.12 for every small task.
Nineteen offline runner tests pass, including historical spend preservation,
output-cap validation, spending guards, locks and uncertain-request handling.

## Phase 1b — progressive grip and handbrake recovery

Commit `cfed045`. Files: config, vehicle, vehicle tests and
`docs/handling-phase1b.md`. All 83 tests, typecheck and build pass.
A local measured tuning sweep reduced recovery time to 0.15 s; the scripted
slide peaks at 50.2 degrees and exits at 10.35 m/s, with stronger regression
bounds. Stationary sample117.7 FPS; WebGL resource counts stable over300frames.
API cost $8.12; cumulative $37.89, remaining $12.11 at completion.
Human feel and physical phone gestures remain uncalibrated.

## Phase 1c — engine, automatic gears and RPM HUD

Files: `src/config.ts`, `src/physics/RaycastVehicle.ts`, `src/ui/Hud.ts`,
`src/main.ts`, `src/styles.css`, `test/Powertrain.test.mjs`.

- Torque curve, 180 kW power limit, five ratios, final drive and automatic
  up/down thresholds determine actual rear-axle drive force. Existing drive
  ceilings and forward/reverse top-speed taper remain enforced.
- Gear shifts interrupt torque for0.18s and produce a real ratio-based rev
  drop. Hysteresis prevents hunting. Neutral, reverse, free revving, limiter
  and reset have explicit telemetry. Handbrake declutches while held.
- Existing speedometer gains an actual gear, numeric RPM and accessible RPM
  meter/redline bar, using the existing palette and layout.
- New tests were applied before implementation and failed because the model
  was absent. After implementation all **92 tests**, typecheck and production
  build pass, including real-Rapier drivetrain integration and all83 earlier
  tire/controls regressions. The host added explicit WASM-world test cleanup.
- Browser: second gear,4679RPM and68km/h after4.2s W; R resets to N/900RPM/0.
  Console clear. A short stationary profile was115.7FPS, with unchanged GPU
  object counts. These samples are not full-lap or weak-device guarantees.
- This is an arcade road-speed/clutch approximation, not longitudinal
  wheelspin, clutch inertia or a fitted production engine. Manual shifting,
  engine braking and subjective tuning remain future work.

Compact API proposal cost $1.72; cumulative estimate
$39.61, remaining $10.39. The runner is idle.

Next: bounded chase-camera lag, restrained speed/corner response and a measured
low-quality preset; then synthesized engine/tire audio with gesture unlock,
volume/mute preferences and pause handling. No music assets or finished audio
are claimed at this stage. Full road feel and physical-device validation remain.

## Phase 2 — chase camera, loading and graphics budget

Success criteria: keep fixed-step controls working, bounded camera at high speed,
consistent 60/120/144 Hz response, genuinely smaller track transfer, functional
Low preset and a paused menu without stuck fingers or keys.

Files: config, main, ChaseCamera, loadPassAsset, SceneSetup, Input, Options,
TouchControls, styles, camera/compressed/input/touch/asset tests, Blender pass
exporter, lossless compressed pass and Vite config. Vite blocks local cost
ledger/key paths while continuing to serve public game assets.

Camera now has bounded acceleration/braking lag, 63–72 degree speed FOV,
subtle corner offset and at most two degrees of actual sideslip roll. Tests
caught render-rate bias in chained filters; velocity changes are now integrated
and effect translations applied after the base-offset filter. No collision
shake, smoke or skid marks are claimed.

Track is byte-identical after gzip decompression: 14,133,072 ->4,874,419 bytes
(65.5% smaller). Browser initially exposed a double-decompression fallback;
a regression now covers Fetch's HTTP Content-Encoding behavior. Browser then
loaded only .glb.gz with no raw download. The Blender exporter emits both.

High retains DPR<=1.75 and 2048 shadows; Low uses DPR<=1 without moon shadows.
Runtime switches resize the buffer and dispose the old shadow target. Native
Options pauses fixed physics and clears both input sources/pointer tracking.
New control-focus tests were red before implementation. Host added two touch
menu lifecycle regressions. All109 tests, typecheck and build pass (final count
is also recorded in later phases). Existing Vite large-bundle warning remains.

Same-machine short stationary300-frame samples at1144x1105 CSS, nativeDPR2:
High117.3FPS, frame p95 9.3ms, callback p95 6.6ms; Low119.2FPS, frame p95 9.1ms,
callback p95 3.1ms. Live GPU counts start=end: High185buffers/7textures/2framebuffers;
Low140/6/1. Not a full-lap, heap-leak or weak-phone guarantee. Runtime Low canvas
1144x1105 vs High2002x1933, and W works after closing Options. Physical touch
and subjective camera comfort remain manual checks.

API costs: broad camera proposal hit its output limit ($1.83; no code applied),
focused camera $0.75, quality/options $0.82. Cumulative$43.00, remaining$7.00.
Next: temporary synthesized engine/tire audio, then reserved validation/fixes.
