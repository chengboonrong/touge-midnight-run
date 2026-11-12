# Racing feel — Phase 0 and first handling increment

Verified 2026-11-12. This completes the audit and the first incremental vehicle
fix, not the full handling phase or the audiovisual overhaul.

## Phase 0 — audit

- Added `docs/racing-feel-audit.md`; committed as `744430d`.
- Preserved a playable baseline in `479c268` so later changes are reviewable.
- Typecheck, all 69 original tests and production build passed before changes.
- Audit API cost approximately $2.06; cumulative estimate after audit $26.55,
  leaving approximately $23.45 of the $50 total. The $5 reserve was retained.
- Confirmed existing fixed-step force-based vehicle, speed-sensitive steering,
  suspension, combined grip, handbrake and keyboard/touch controls. Audio,
  engine RPM/gears and race-state systems are not implemented.
- Identified excessive lateral requests reducing brake and drive forces in a slide.
- Subjective handling, camera comfort and controlled drift recovery require
  human road testing; the audit distinguishes these from code-derived defects.

## Phase 1a — pedal authority during a slide

### Implemented and files changed

- `src/physics/RaycastVehicle.ts`: bound the lateral force request by lateral
  grip before applying the existing combined friction ellipse. This prevents
  unbounded sideways demand from making pedal forces almost disappear.
- Added per-wheel signed `slipSpeed` in m/s in the contact-plane wheel frame,
  including chassis angular velocity. It clears in the air, without tire load,
  and on reset. It is not wheelspin or longitudinal slip ratio.
- `test/RaycastVehicle.test.mjs`: five regression tests appended; all existing
  vehicle tests remain byte-for-byte unchanged.
- The host added the force clamp while reviewing Claude's telemetry draft.
  No other writer or unexplained change was involved.
- No dependency, input, rendering, suspension, steering or tuning changes.

### Test evidence

First validation was `npm run typecheck`. New tests against the old code
produced 70 passes and four expected failures: sliding brake, sliding drive,
missing slip telemetry and finite/reset telemetry. The zero-grip guard already
passed. After the fix, typecheck, all **74 tests** and production build passed.
Rapier remains pinned to and tested against **0.14.0**. The existing Vite
large-chunk warning remains; no new build errors or browser console warnings.

Real Rapier flat-slab probe: settle 300 steps, set forward velocity to 15 m/s
and lateral velocity to 6 m/s, solve one vehicle update at 1/60 s. Signed
longitudinal force is sampled before stepping the world.

| Per-wheel force, N | Before | After |
| --- | ---: | ---: |
| Front foot brake | -248.1 | -2937.3 |
| Rear foot brake | -136.8 | -1808.0 |
| Rear throttle | 195.1 | 2356.9 |

Regression tests assert useful authority relative to a straight-line reference,
combined grip bounds, zero lateral grip, handbrake drive cut, wheel-frame slip
sign/magnitude, yaw contributions, finite telemetry and airborne/reset clearing.
The original deterministic steering, ride height, reversing, grip and
interpolation tests still pass. Render-rate tests cover 30/60/120/144 Hz.

Handbrake comparison: 6 m/s pure sideways launch, then 15 fixed steps.

| State | Yaw before, rad/s | Yaw after, rad/s | Side speed before, m/s | After, m/s |
| --- | ---: | ---: | ---: | ---: |
| Normal grip | -0.1208 | -0.1206 | 3.4711 | 3.4711 |
| Handbrake held | 0.5052 | 0.3192 | 4.3134 | 4.3485 |

The handbrake still reduces rear grip and steps the tail out. These numbers
verify a bounded response, not a calibrated controlled-drift acceptance test.
Throttle remains cut while the handbrake is held; the fix improves throttle
control during a slide after releasing it.

### Browser and performance checks

Chrome, Apple M1 Max (10 CPU cores), 64 GiB RAM, macOS 27.0; normal existing
quality, 1144 x 1105 CSS pixels, screen DPR 2 (renderer caps DPR at 1.75).
A temporary page booted the real game and sampled 300 RAF intervals after
120 warm-up frames. The fixture was removed after testing.

| Stationary sample | Before | After |
| --- | ---: | ---: |
| Mean FPS | 119.6 | 112.8 |
| Median frame interval, ms | 8.3 | 8.4 |
| p95 frame interval, ms | 9.7 | 10.0 |
| p99 frame interval, ms | 10.2 | 16.8 |
| Median game callback, ms | 2.6 | 2.4 |
| p95 game callback, ms | 5.7 | 6.1 |

These are short stationary samples on a busy desktop, not a full-lap benchmark
or a guarantee of 60 FPS on weaker hardware. No expensive effects were added.
The change adds four scalar wheel-state values and no persistent per-frame
resources. No full heap soak or GPU-resource leak profile was performed.

Browser smoke check: W accelerates (32 km/h after a 1.8 s press); A, Space, S
and R remain responsive in a basic drive/brake/reset check. Fresh console has
no errors or warnings. Automated touch tests still pass; physical phone and
multitouch road driving were not re-tested during this increment.

### Budget

First handling API session: approximately $3.21. This request's audit plus
handling sessions cost approximately $5.27. Current cumulative estimated spend
is **$29.77 of $50**, leaving **$20.23**.
The runner used a temporary $45 implementation threshold to preserve at least
$5 for final testing/fixes. The existing ledger history was retained; the runner
has stopped, with no request in flight or outstanding lock. Estimates use the
configured rates and do not replace provider billing.

### Known issues and next task

The lateral model still uses slip velocity with early saturation and a stiffness
tied to physics dt. Handbrake grip still returns instantly; engine/gearbox,
center-of-mass tuning, drift assist and a development tuning panel remain.
No audio, music, countdown, race timer, smoke or cinematic effects were added
in this handling-only increment. The audit records their required order and
licensing requirements; no sound assets are claimed to exist.

Next recommended task: a configurable progressive slip-angle tire curve with
smooth handbrake grip recovery, validated against these regression tests and
controlled drift scenarios. Then continue the remaining drivetrain/handling
work before camera and engine/tire audio, in the requested order.
