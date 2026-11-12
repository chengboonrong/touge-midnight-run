# Start menu contract

- `src/ui/StartMenu.ts` is shown at boot over the live scene. It is never auto-focused, so the first W reaches the game.
- While the title is open `body[data-menu]` is set: `.hud`, `.race-hud`, `.manga` and `.touch` are hidden and touch controls are disabled. The attribute is removed when playing.
- TIME ATTACK resets the car and starts the countdown. FREE PRACTICE, or the first held W/A/S/D, enters practice from the settled pose; the held key is kept.
- While the title is open the car receives neutral input, the race stays in practice, and drift score and near misses are not accumulated. R resets the car but stays on the title.
- Options stays reachable above the title. Its TITLE SCREEN button cancels the run and its cues, resets the car, snaps the camera and shows the current PB.
- Music: title `menu`, countdown `prepare`, practice/racing `race`, finish `results`.
- Camera: `ChaseCamera.setPresentation('menu' | 'intro' | 'drive' | 'finish')`, tuned by `CAMERA_PRESENTATION` in `src/config.ts`. Reduced motion uses `drive` instead of `intro` and `finish`. Options pause passes dt 0.

Verified: typecheck and all213 Node tests pass. Actual Chrome menu checks: heldW enters Practice immediately (34km/h after1.8s), title return works, Time Attack remains N/900RPM/0km/h through3->2 despite W. Bounds at320x480,375x667,414x736,768x1024 and568x320 keep both48px actions and Options on screen without horizontal overflow. Console has no warnings/errors. Camera timing/bounds/pause are checked at60/120/144Hz in native Three tests. Physical touch devices, human comfort and listening remain manual.

Simulated touch detection was also checked in Chrome: six controls disabled on title,
all enabled after Practice; heldGAS1.5s reached28km/h and released cleanly. Opening
Options disabled all six; returning title then opening/closing Options kept them
disabled. This checks pointer/UI wiring, not a physical mobile browser.
