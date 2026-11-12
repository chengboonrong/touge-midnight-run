# Phase 5c: time attack wired into main.ts

Free practice stays the default. OPTIONS has two 48px buttons: START TIME ATTACK and FREE PRACTICE.

## Integration fields (src/main.ts)
- `race` (RaceSession), `drift` (DriftScore), `raceHud` (RaceHud), `markers` (RaceMarkers): created once after assets, car, input and Hud.
- `pump()`: drains `race.drainEvents()` to `raceHud.handleEvent`, audio cues and storage, then on a state change sets `RACE_MUSIC[state]` and `hud.setSessionLabel`. Called after start, cancel and every fixed step.
- Cues: countdown -> countdown, go -> go, checkpoint -> improved if delta < 0 else checkpoint, finish -> personalBest if flagged else finish. The personalBest event plays nothing; it is the only place the record is saved.
- START: clear input and touch holds, reset car/camera/impacts/drift, close OPTIONS, unpause audio, `race.start(body position)`.
- FREE PRACTICE / R: reset car/camera/impacts/drift, `race.cancel`, best lap kept. R leaves held keys alone, as before.
- Fixed step: paused returns before physics, race and score (no catch-up). Controls are read only in practice/racing; countdown is neutral; finished brakes while forwardSpeed > 0.5, then neutral.
- Drift input: chassis-local velocity from body rotation and linvel (forward = local -Z), wheels with `grounded && load > 100`, max |slipSpeed| of loaded rear wheels (indices 2 and 3; assumes FL, FR, RL, RR order). Scored only in practice/racing; banked on finish; reset on new run and R.
- Records: src/race/RaceRecords.ts, key `touge.best.kurotake.v1.<length>m.<points>p`. Corrupt data loads as null; a faster stored lap is never overwritten; storage errors never stop play.
- Audio: `raceCue` schedules on a suspended or interrupted context (not closed) when not paused, visible and SFX audible, so the first beep survives the asynchronous resume. The countdown never waits for audio.
- SFX and music are still temporary placeholders (see MUSIC.md); the player-facing credit only reads ORIGINAL SYNTH SCORE / SYNTH SFX.

## Manual browser checks (host)
1. OPTIONS -> START TIME ATTACK: 3, 2, 1, GO shown and heard, including the first beep (700/1050 Hz schedules, real RMS).
2. Hold W during the countdown: speed stays 0 and the timer starts at GO.
3. Open OPTIONS mid-run: clock and input freeze; close: continues with no jump.
4. R mid-run: back to practice, PB kept. Finish a lap, reload: PB kept.
5. After the finish: car brakes to a stop and does not reverse.
6. Touch layouts 320x480, 568x320, 844x390: buttons reachable, race HUD not overlapping controls.
7. Gate markers on the real course: on the road, facing the right way, next gate highlighted.
8. Wheel order in RaycastVehicle matches the rear-wheel assumption above.

## Host verification — 2026-11-13

Typecheck, all178 tests and production build passed. Six new storage tests were
red before RaceRecords was added and then passed, including bad/blocked storage
and preserving a faster already-stored record. The key uses version, name,
rounded length and point count; bump v1 for a layout change retaining those
values (it is not a complete geometry hash).

Browser instrumentation observed700Hz cue schedules at0.031,1.034,2.031s and
1050Hz at3.034s. W held during3->2 stayed N/900RPM/0kmh with chrono0. Opening
Options during a lap froze the displayed timer at22.68s across a1.2s W hold and
suspended both audio elements/context. R returned to PRACTICE/0kmh. No console
errors. At320x480, scrolling54px exposed the48px mute button fully (y391..439).
Actual screenshots and bounds checks found no race-panel/control/map overlap
at320x480,568x320 and844x390. This simulates touch detection; no physical phone.

A temporary course-following driver used ONLY normal throttle/brake/steering
inputs and the existing race reset; it never set chassis transforms or velocity.
After nearly two practice laps it completed a valid timed physical lap:
70.165767s, splits17.200663/35.124861/50.317490s, all three checkpoints, no off-road
time, max nearest-sample cross-track2.373m. The car braked to N/0kmh after finish.
The HUD showed NEW BEST1:10.16 and the actual storage write matched the lap.
The fixture redirected only its PB to a disposable unique key; the user's real
PB was preserved. Evidence: /tmp/touge-phase5-physical-lap.json.

Short moving300-frame sample at1144x1049 CSS, nativeDPR2/rendercap1.75:
114.65FPS, frame p95 9.8ms, p99 17.6ms, callback p95 4.1ms. After first-view shader/
marker initialization, GPU counts stayed199buffers/11textures/2framebuffers/
2renderbuffers/10programs/0shaders/135VAOs through the later laps and finish.
This establishes a bounded sample, not a full heap-leak or weak-device guarantee.
Human handling/mix/loop-seam review, actual iOS, bfcache and slow-network browser
checks remain. The deferred-promise music lifecycle cases are covered by tests.
