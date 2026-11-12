# Handling Phase 1b — slip-angle tire curve and handbrake grip recovery

Scope: `src/config.ts`, `src/physics/RaycastVehicle.ts`,
`test/RaycastVehicle.test.mjs`. No audio, camera, race, UI, input, loop,
dependency or runner changes. Rapier stays pinned to 0.14.0. Not committed by
the agent.

## What changed

**Lateral tire force.** Each grounded wheel computes a signed slip angle from
its contact-plane velocity (chassis linear plus angular velocity, same
pre-force snapshot as before): `atan2(sideSpeed, max(|rollingSpeed|,
slipAngleMinSpeed))`. Lateral force = peak lateral grip x curve(|angle| / peak
angle), opposing the slip:

- up to the peak angle: `2x / (1 + x^2)` (0 at 0, 1 at the peak, flat top);
- beyond it: `sliding + (1 - sliding) * 2x / (1 + x^2)`, falling smoothly
  towards the sliding fraction. Continuous, continuous slope, always in [0, 1].

The curve contains no `dt`. The old velocity-cancelling force
(`slipResponse * mass/4 / dt` per m/s) is kept only as an upper bound. It is
what brings the force to zero at rest and keeps the tire dissipative; it is
also the effective response at low speed and tiny slip. With the default
tuning and static load the curve is the smaller of the two (so it governs)
above roughly 5.4 m/s (front) and 7.3 m/s (rear) for small angles, and at any
speed for large slip. That crossover is emergent from existing values, so no
separate crossover parameter was added. The Phase 1a pedal-authority fix and
the friction ellipse are unchanged: lateral never exceeds its own grip limit.

**Handbrake.** While held: rear lock, drive cut and
`handbrakeRearGripScale` apply at once, as before. On release the lock and
drive cut end at once; only the rear lateral grip multiplier eases back,
`1 - (1 - scale) * exp(-dt / handbrakeGripRecoveryTime)` per step, which
depends on elapsed time only. Throttle is not suppressed. `reset()` clears it.

**New tuning (`VehicleTuning`), defaults are hypotheses until driven:**

| Field | Unit | Default |
| --- | --- | ---: |
| `tirePeakSlipAngleFront` | rad | 0.14 |
| `tirePeakSlipAngleRear` | rad | 0.12 |
| `tireSlidingGrip` | fraction of peak, 0..1 | 0.8 |
| `slipAngleMinSpeed` | m/s | 1 |
| `handbrakeGripRecoveryTime` | s (time constant) | 0.15 |

Grip coefficients, steering, suspension and drivetrain values are unchanged.

**Telemetry.** `WheelState.slipAngle` (rad, within +-PI/2): same sign as
`slipSpeed` (positive = sliding to the wheel's right), also in reverse; fades
to 0 at standstill via `slipAngleMinSpeed`; 0 airborne, unloaded and after
reset. `slipSpeed` is unchanged. Neither is wheelspin or a slip ratio; wheels
still have no rotational state.

## Test evidence (measured, Node + real Rapier 0.14.0, flat slab)

Order run: typecheck, then full `npm test`, with the new tests written first.

- Before implementation: 74 passed, 9 new tests failed, all on behaviour
  assertions (grip use 1.000 at every angle; 0.01 rad force 1620 N vs 2895 N
  for 1/60 vs 1/120 s; grip 1.000 immediately after release; `slipAngle`
  undefined). No import or missing-module failures.
- After: typecheck exit 0, **83 of 83 tests pass**, production build exit 0
  (existing Vite large-chunk warning only). The 74 earlier tests are unmodified.

Measured by the new tests (test tuning: peaks 0.14 / 0.08 rad, sliding 0.7,
recovery 0.4 s, set explicitly so they do not depend on the defaults):

| Slip angle / peak | 0.25 | 0.5 | 0.75 | 1 | 2 | 4 | 1.2 rad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Front grip use | 0.471 | 0.800 | 0.960 | 1.000 | 0.940 | 0.841 | 0.769 |
| Rear grip use | 0.471 | 0.800 | 0.960 | 1.000 | 0.940 | 0.841 | 0.740 |

- Same angle at 12 / 24 / 40 m/s: front 0.8000 each, rear 0.9912 each.
- Same state at 1/60, 1/120, 1/240 s: identical lateral force (1e-6 relative).
- Force always opposes slip and stays under the one-step bound across a grid
  of speeds 0-30 m/s; a 0.3 m/s sideways nudge at rest settles with no creep.
- Rear grip vs a fresh car: held 0.280 (with the lock sharing the ellipse);
  released 0.377 at once, 0.494 after 5 steps, 0.666 after 15, 0.882 after 40,
  0.996 after 120. Same result for 0.5 s taken as 15, 30 or 60 steps. Front
  grip unaffected, no rear lock after release, drive force at least 99 % of a
  fresh car's on the release step.
- Reset clears recovery and slip telemetry; airborne `slipAngle` is 0.

Changed numbers in existing diagnostics (default tuning):

| | Phase 1a | Phase 1b |
| --- | ---: | ---: |
| Sliding front brake, N per wheel | -2937.3 | -3041.6 |
| Sliding rear brake, N per wheel | -1808.0 | -1940.7 |
| Sliding rear throttle, N per wheel | 2356.9 | 2498.8 |
| 6 m/s side slide, 15 steps: side speed, no handbrake, m/s | 3.4711 | 3.8651 |
| Same, handbrake held: yaw, rad/s | 0.3192 | 0.2337 |

Initial candidate scripted slide (0.35 s recovery, before host calibration): 18.94 m/s entry, 0.75 s full left lock plus
handbrake, then release with proportional countersteer and 30 % throttle.

| | Old code | Phase 1b |
| --- | ---: | ---: |
| Sideslip at release, rad | 0.410 | 0.396 |
| Peak sideslip, rad | 0.671 | 1.182 |
| After 4 s: sideslip / yaw | 0.000 / 0.000 | 0.000 / 0.000 |
| After 4 s: speed, m/s | 12.84 | 7.36 |
| Minimum up.y | 0.9961 | 0.9969 |

## Limitations and open points

- **The initial 0.35 s candidate made slides much deeper.** This was corrected below before committing. In the scripted entry the car now
  reaches about 68 degrees of sideslip before it is caught (38 before) and
  loses more speed. It recovers and stays upright, but the test's "does not
  spin" bound is 1.2 rad, so the margin is 0.018 rad. This is the expected
  direction for sliding grip below 1 plus gradual rear recovery, but whether
  it is too loose is a tuning decision. Nothing was retuned blind. Levers:
  `tireSlidingGrip` up, `handbrakeGripRecoveryTime` down, rear peak angle.
- The existing handbrake test's "tail steps out" yaw is now 0.2337 against a
  0.2 threshold: passing, with little margin.
- **Not driven.** No browser, track, FPS or feel check was made in this
  increment. All defaults are hypotheses. Keyboard and touch code is untouched
  and its automated tests pass; nothing was checked manually.
- Flat slab only: no slopes, kerbs or the real pass geometry.
- Below the crossover speed, small-slip response is still the old
  velocity-cancelling bound and therefore still tied to `dt` there. This is
  deliberate for standstill stability at the fixed 60 Hz step.
- The curve is a simple rational shape, not a fitted tire model; no load
  sensitivity; no longitudinal slip or wheelspin.
- The scripted driver is a proportional controller, not a human; it shows a
  slide can be entered and caught, not that it feels right.

## Host calibration and current result

The host swept recovery time constants 0.05/0.10/0.15/0.20/0.25/0.35 s at
sliding-grip fractions 0.8 and 0.9 using the same real-Rapier scenario. It kept
sliding grip at 0.8 and selected 0.15 s recovery. Peak sideslip is now 0.875 rad
(50.2 degrees), exit speed 10.35 m/s and minimum up.y 0.9968. The old candidate
values in the preceding table are historical, not the committed tuning.

The scripted regression was strengthened to peak sideslip < 1 rad and exit
speed > half of entry speed. Both requirements failed on the initial candidate;
they pass after calibration. All 83 tests, typecheck and build pass. No original
pre-Phase1b test was weakened. This improves the measured response but does not
replace human driving on the actual pass.

The next handling increment is engine RPM, torque delivery and automatic gears,
followed by the camera, audio and measured quality/performance improvements.


## Host performance and budget check

Chrome on the existing M1 Max/64 GiB desktop, 1144x1105 CSS pixels: a 300-frame
stationary sample after 120 warm-up frames measured 117.7 FPS, median
8.4 ms, p95 9.9 ms and p99
16.6 ms. The corresponding pre-change sample was 119.2 FPS.
This is a short stationary measurement, not a full-lap performance guarantee.
WebGL buffer/texture/framebuffer/renderbuffer/program/vertex-array counts were
identical at the start and end of the sample; this is not a full heap soak.

This increment cost approximately $8.12 in API usage,
including the detailed multi-turn test review. Cumulative estimated usage is
$37.89; $12.11 remains within the original $50.
Subsequent requests use compact patch proposals and local validation to reduce
repeated API context. The $5 final-testing reserve remains available.
