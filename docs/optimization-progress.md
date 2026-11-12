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
