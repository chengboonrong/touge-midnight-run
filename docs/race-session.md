# Timed-lap core

Success: an optional timed lap can share the existing fixed-step game without
changing vehicle forces. Countdown and race time use simulation dt; pauses
perform no updates. Three ordered quarter-distance gates precede the start/
finish gate. The start station is projected from VEHICLE.spawn, not point0 of
the closed route. Gate crossings are directional and interpolated within a step.

`new RaceSession(points, width, spawn, savedBest?)` validates geometry and saved
best data. `start(actualPosition)` starts3/2/1/GO; `update(dt, body.translation())`
advances after physics; `cancel(actualPosition)` returns to practice and retains
best. `drainEvents()` returns pending events exactly once; drain after start,
cancel and every fixed update. Read state/elapsed/countdown/checkpoint/splits/
best/valid/offCourse for presentation. The host owns input gating and storage.

Events: countdown{value}, go, checkpoint{index,time,delta}, invalid{reason},
finish{time,valid,personalBest,previousBest}, personalBest{time,previousBest},
cancel. A finish and personalBest event can occur together: presentation should
choose the PB celebration once. RACE_MUSIC maps states to prepare/race/results.
Best data: `{time:seconds,splits:[three cumulative checkpoint seconds]}`.
Validate with readBestLap when loading; scope storage to a versioned course ID.

Records are invalidated by a position step above100m/s*dt+2m, or0.5s cumulative
off-course time beyond road half-width+1m or3m vertically. An invalid run can
continue but cannot replace the PB. Gate reach is half-width+1m and4m vertically.
This is local validation, not network anti-cheat. Projection scans the520
segments each racing step; it caches route data and creates no projection
objects per frame. Events and splits allocate only at discrete transitions.

The13 regression tests include a sampled full lap of the real1092m polyline at
16m/s and30/60/120Hz, expected L/v and quarter splits, wrong-way crossings,
repeated gates, shortcuts, teleport, off-course time, reset, PB and bad storage.
These test sampled positions and race rules; they do not simulate an entire
physical driving lap or establish subjective handling quality.

UI/audio/input/storage integration is the next increment. Free practice remains
the default until that wiring is added. No race UI is claimed by this module.
