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

## Phase 3a — temporary synthesized vehicle audio

Files: `src/audio/{GameAudio,audioMath}.ts`, `src/ui/AudioControls.ts`, main,
styles and `test/audioMath.test.mjs`. Four crossfading RPM oscillator layers,
actual loaded lateral-slip tire noise, grounded rolling noise, speed wind and
preallocated shift/handbrake transients. Compressor and master headroom. No
copyrighted samples, music files or production-recording claim. Gesture unlock,
menu/hidden suspension, saved validated mute/volume, and graph disposal are owned.

Host corrected test location/syntax and invalid-idle-RPM handling caught by the
new regression. All114 tests, typecheck/build pass at this increment. Browser:
no context before gesture; W produced running audio and55km/h/5778RPM. Actual
post-compressor analyser peak<0.094 during this short sample. Opening Options
suspended the context. Node creation counts stayed1compressor/10gains/5filters/
4oscillators/4noise sources, including gear/handbrake feedback. A suspended
analyser retains its last samples; its nonzero cached RMS is not output sound.

The sound needs human listening/mix calibration. Tire effects measure lateral
slip, not unimplemented wheelspin/longitudinal lockup. No collisions/countdowns/
race cues without actual event systems. No audio assets or music integration yet.
API$1.30; cumulative$44.30; remaining$5.70. The reserved$5 is now being used for
lifecycle race and long-session automation checks/fixes and final optimization.

## Phase 3b — audio lifecycle and scheduling fixes

Files: GameAudio, new import-free audioState, five async/throttle regressions.
Pending resume no longer blocks later user activation. Pausing during a pending
resume still suspends; late resolutions cannot override current desired state.
Rejected or synchronous state operations do not throw or spin. Closed contexts
are ignored. Continuous targets are bounded near30Hz and skip negligible changes;
actual gear/handbrake edges remain unthrottled. No per-frame node allocation.

Tests applied first failed for missing helper. Then119 game tests, typecheck and
build pass. Real browser Escape-first -> W produced a running context,33km/h
and nonzero RMS. Graph node counts remain fixed. Mute reaches RMS=0 and survives
reload. Volume slider works with keyboard and is saved. Menu states
suspend and unpause resumes. Hidden-tab handling is implemented but still
needs a physical tab-switch check; this browser harness keeps test pages visible. Human mix/pitch smoothness and physical-phone
activation remain manual validation. No long-duration heap-leak claim.

API$0.83; cumulative$45.13; remaining$4.87. Remaining funds go to actual contact
feedback and final regression/performance review. Music, race events, smoke and
skids are still pending, rather than represented by dummy UI.

## Budget authorization update

The user added$50 to the spending limit on2026-11-13. The cumulative limit is
now$100 (not a reset). `.env` MAX_SPEND_USD=100 was saved and loadConfig verified
model claude-fable-5-2, limit100, default max output128000. Ledger history remains
intact. At authorization: estimated$45.127456, remaining$54.872544, one contact-
feedback proposal already in flight under its earlier$50 guard. Future feature
calls use$95 until final validation, preserving$5 of the expanded budget.

## Phase 3c — real chassis impact feedback

Files: ImpactFeedback, PhysicsWorld optional event queue, main, GameAudio,
ChaseCamera and three test files. Rapier0.14 contact forces on the chassis
produce a filtered thump and <0.07m decaying camera movement; reduced-motion
preference disables new shake. One owned queue is drained each physics step;
only numeric event data escape the callback. No force or handling changes.
Reset clears feedback and bfcache retains its queue. No guardrail scrape claim.

The host strengthened a render-rate test from strong-then-weak to weak-then-
strong and caught render-dependent cooldown eligibility. Eligibility is now
fixed-step based, with strongest simultaneous contact retained. A real Rapier
wall/drop/rest integration test caught a too-sensitive0.5m/s threshold: a tiny
settling drop triggered it. Raising it to1.5m/s avoids that false hit and gives
full strength for the15m/s wall test (1.07MN contact) and5m drop (0.71MN). Rest
produces no feedback. Quiet bumps are deliberately below threshold. Force rating
is an approximation and the first accepted collision step sets the burst;
spreading an impact over several steps can understate its strength.

All134 tests, typecheck and build pass. New camera tests cover bounds, decay,
reset and refresh independence. Hard-landing/wall event delivery is verified
against actual WASM; subjective shake/sound and bfcache remain manual checks.
API$0.87; cumulative$46.00; remaining$54.00 under the expanded$100 ceiling.
Next: original generated playable synth music and four-state manager, followed
by an actual race loop/HUD, bounded visual effects and final profiling.

Browser follow-up: W then W+D into the actual pass guardrail produced two
contact-feedback callbacks during the drive, with the last strength0.2144.
Audio graph counts stayed fixed; local/public consoles had no warnings/errors.
Cloudflare TOUGE URL is https://fossil-confident-improving-subjects.trycloudflare.com/
(the other existing tunnel on8787 belongs to another game and was not changed).

## Phase 4a — generated playable original synth score

Files: MusicManager, musicState, GameAudio, AudioControls, two test files,
`tools/audio/build_music.py`, docs/MUSIC.md and fourMP3s+manifest. Existing
practice uses the race score; four states are available for the upcoming race
loop. Two owned streaming elements/sources/gains feed the existing compressor.
Music has independent saved volume; MUTE ALL preserves older SFX preferences.
No external samples or downloads. Original algorithmic notes/arrangements and
synthesis were created with Claude API assistance and dedicated CC0. Temporary
synth instrumentation; no production-recording or professional-composer claim.

Host ran the actual Python generator and ffmpeg. All four MP3s decode at44.1k
mono160kbps: menu24.615s/494KB, prepare12.308s/248KB, race49.231s/986KB,
results12.308s/248KB. Actual peak levels -3.09..-3.22dBFS; RMS -15.22..-18.10dBFS.
Host corrected the unsupported144kbps draft to160 before encoding. Source PCM
wraps tails; compressed-media loop seams still need human listening.

Music rules/preferences/planner tests were red before implementation;141 game
tests, typecheck and build passed. Host added an asset presence/signature/
duration/license/distinctness regression (142 total). Browser decoded and played
all four tracks. Race->results old element paused after fade; live MUTE ALL
reached RMS=0, including a transition. Node counts remain2media sources,
12gains,1compressor,5filters,4oscillators,4noise sources. No new AudioContext.
Host fixed immediate mute across both slots and partial-construction cleanup.

API$1.54; cumulative$47.54, remaining$52.46. A focused follow-up is validating
slow incoming loads and stale play promises before race integration. Track
listening, mix judgment, actual iOS activation and loop-seam comfort remain
manual checks. The existing Vite large-bundle warning remains.

## Phase 4b — music transition lifecycle fixes

MusicManager and its pure planner plus six focused deferred-play regressions.
Five were red before the fix. A pending incoming stream now leaves the previous
track audible until play settles; stale play successes/refusals cannot override
newer state, pause or mute. An idle loading slot is reused for a third request
without replacing the audible slot. Returning to an earlier still-playing track
is safe. Constructor cleanup and both-slot mute/unmute have regression coverage.
All148 tests, typecheck and build pass. Real slow-network buffering, rapid
transition listening and physical iOS remain manual checks; no extra graph nodes
or contexts were introduced. An interrupted outgoing crossfade tail can still
be cut by a rapid third request (bounded two-slot tradeoff).
API$0.90; cumulative$48.44, remaining$51.56. Next: fixed-step timed-lap logic,
then its countdown/cues/checkpoints/PB HUD. No new race UI is claimed yet.

Loading follow-up (no API cost): Cloudflare may decode origin gzip and remove
Content-Encoding for clients without compression negotiation. A failing proxy-
decoded regression exposed the remaining header assumption. Loader now checks
actual gzip magic before decoding. This handles plain gzip, browser-decoded and
proxy-decoded bodies without duplicate raw downloads; five loader tests pass.
It buffers the compressed response before parsing (about4.9MB extra transient
storage on the gzip path), trading a small loading-only allocation for robust
proxy behavior. Browser compression negotiation still transfers4,874,419bytes.

## Phase 5a — deterministic one-lap race core

Files: RaceSession, race-session regression tests and integration contract doc.
Actual spawn projection anchors three ordered quarter gates and the finish.
Simulation-time countdown, directional interpolated split/finish times, valid
best-lap data and invalid-record handling preserve free practice. Tests were
applied first and failed for the missing module. All162 tests, typecheck and
build pass. Sampled real-route laps agree with L/v across30/60/120Hz; this is
not a full physics-car/autopilot lap. Test route loading uses its verified exact
path, rather than recursively scanning unrelated files. UI/audio/storage and
physical driving validation remain next.

The initial larger proposal hit its30k output ceiling ($1.26; no implementation
was applied). Its complete tests were reviewed, and a smaller module-only pass
completed ($0.53). Cumulative$50.23, remaining$49.77 under the expanded$100 cap.
The later presentation increment also addresses clearing stale queued events
when a run is cancelled or restarted before the host drains them.

## Phase 5b — drift score, race HUD and cue modules

Files: DriftScore, RaceHud, RaceSession stale-event fix, raceCue, GameAudio,
styles and four new regression files. Score integrates actual chassis velocity,
loaded wheel count and real rear slip, with minimum speed/forward motion and a
13–60degree window. Airborne/reverse/spins/rest cannot score. A0.4s grace links
switchbacks; stop banks once and reset clears. UI formatting and capped cues
are deterministic. One owned extra oscillator/gain handles event cues, cleared
on pause/hidden, with no per-cue nodes/timers. Countdown is also aria-live.

Tests were applied first and failed for missing modules/stale queued events.
All172 tests, typecheck and build pass. Host converted the proposed TS tests
into the repository's real .mjs/transpile loader and retained all assertions.
RaceHud, markers and drift are not wired into the live main loop yet; their
actual behavior/layout/audio are the next integration check, not claimed here.
RaceMarkers is a small host-written visual-only gate/board class with shared
geometry, explicit disposal and no shadows; typechecked pending visual review.
API$1.25; cumulative$51.48, remaining$48.52. Main wiring and saved records are
being added next; no driving forces or existing controls were changed.
