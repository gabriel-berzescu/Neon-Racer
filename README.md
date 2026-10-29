# Neon-Racer

Race against the clock on procedurally generated roads through a neon world, driven with a gamepad. Every stage is a new
point-to-point road from a number (its seed), 9 to 13.5 km long, carved into an endless synthwave landscape. Your best run on
each stage is kept, and drives with you as a ghost the next time.

It brings together two earlier games: the look of [Neon-Flight](https://github.com/gabriel-berzescu/Neon-Flight) and the
vehicle physics, cars and engine sound of [Xeno-Racer](https://github.com/gabriel-berzescu/Xeno-Racer).

**Play:** https://gabriel-berzescu.github.io/Neon-Racer/ (Chrome or Edge; a Logitech F310 in X mode, or any XInput pad).

**Smoothest on Windows: `play.bat`** (needs [Node.js](https://nodejs.org)). Double-click it in a copy of this repository: it
builds the game if needed, serves it locally and opens it fullscreen in its own Chrome window on the fast GPU, with sound on
from the start; Alt+F4 closes it. On a laptop with two GPUs a browser tab usually runs on the slower integrated one. The web
version adapts: it starts at a lower quality on an integrated GPU and steps down further if the frame rate drops, remembering the
level for that GPU. `?q=lowest`, `low`, `medium` or `high` on the URL fixes a level.

## Controls

| Control | Does |
|---|---|
| Left stick, left/right | steer, **half** lock |
| Right stick, left/right | steer, **half** lock |
| Right trigger | throttle |
| Left trigger | brake |
| A | handbrake |
| RB / LB | shift up / down (manual gearbox only) |
| Y | camera: chase, far chase, hood |
| Back | put the car back on the road |
| Start | pause menu |

**The two sticks add up.** One stick pushed all the way turns the wheels half way; both pushed the same way turn them all the
way; pushed opposite ways they cancel out. One thumb is for the fast bends, both thumbs for the tight ones. At speed, full steering
is what the front tyres can take (Xeno-Racer's steering filter), so the wheel never turns further than grips.

Keyboard, as a fallback, mirrors the pad: A/D are the left stick and ←/→ the right stick (so one key is half lock), W/S or ↑/↓
throttle and brake, Space handbrake, Shift/Q shift up/down, C camera, R back on the road, Esc pause.

## Stages

**Drive a new stage** gives a new road every time; **Stage number…** drives a given one (type the digits, or pick them with
the D-pad), so a stage can be shared by its number; **Stages driven** lists the ones you have finished, with your best time and car.

- The road runs through plains, valleys and passes: long sweepers, medium corners, esses, chicanes after braking straights, a few
  hairpins down to 25 m, straights up to about a kilometre. Every corner eases in and out on a transition curve. Grades are up to
  8 %, crests gentle enough that the cars stay on the ground, with mild banking in the tighter corners.
- 12 m of asphalt, a 3 m concrete shoulder, 3 m of dirt run-off (slow, and slippery for slick tyres), then barriers.
- 5 to 8 checkpoints, about every 1.75 km; the last one is the finish.

A run: a countdown, a standing start (the clock starts at GO), a split at every checkpoint against your best run here (green
ahead, red behind), and the finish, where the car brakes itself to a stop and the results show every split. The best time on each
stage, with its splits and its car, and each car's best, are kept in the browser; so is the best run's ghost, a 20 Hz recording
that drives with you next time (the 24 most recently played stages keep their ghosts).

## The cars

Three of Xeno-Racer's cars, with their physics unchanged (no nitro and no damage here):

| Car | | Power | Mass | Top speed |
|---|---|---|---|---|
| **LMP-X** | a Le Mans-style prototype, 4.5 L V10 | 690 hp | 950 kg | 318 km/h |
| **Volta** | a 2026-rules single-seater, 1.6 L turbo V6, wings that open on the straights | 565 hp | 800 kg | 330 km/h |
| **Dieci** | a 2004-style single-seater, 3.0 L V10 to 19,300 rpm | 912 hp | 640 kg | 332 km/h |

They are drawn in Neon-Flight's style: dark bodies with glowing edges (LMP-X cyan, Volta magenta, Dieci amber). The ghost is a
pale hologram.

Settings (kept in the browser): graphics, sound volume, driving aids (off, standard, full help: Xeno-Racer's ABS, traction
control, stability control and counter-steer help), gearbox (automatic or manual), camera, ghost on or off.

## How it works

- **Physics:** Xeno-Racer's custom vehicle physics at 1000 Hz: tyres with load sensitivity and temperature, suspension,
  aerodynamics with downforce (and the Volta's active aero), engines, gearboxes, differentials, ABS, traction and stability control.
  It sees the world only through a `TrackRuntime` ([`src/core/contracts.ts`](src/core/contracts.ts)), which a stage provides.
- **Stages** ([`src/world/`](src/world)): a seeded plan of designed corner sequences, an elevation profile that follows the land
  within the grade and crest limits, and a carve that cuts and fills Neon-Flight's terrain to meet the road. The physics' ground and
  the rendered terrain come from the same functions (the GPU's GLSL is generated from the CPU's tables), so they agree to millimetres.
  Each stage is moved to the world's origin, so 32-bit floats keep millimetre precision.
- **Rendering:** three.js with bloom; the terrain is a geometry clipmap of Neon-Flight's procedural landscape, with a finer grid
  near the ground. **Sound:** Xeno-Racer's engine voices in an AudioWorklet, the same samples for the same inputs.

## Develop

```sh
npm install
npm run dev          # http://127.0.0.1:5270/
npm test             # physics, controls, runs and ghosts, stages, road, cars, sound
npm run build
```

`?stage=<number>` starts straight into a stage, `?car=lmp-x|volta|dieci` picks the car, `?autodrive=1` drives for you (a QA tool,
slow and careful). Dev pages: `sandbox/road.html` (a stage from any camera, `?seed=&cam=car|chase|drone|top&s=`),
`sandbox/car.html` (the cars, `?car=&view=chase|turntable|pair`), `sandbox/audio.html` (the engines, live or rendered).
`node scripts/shot.mjs <page>` takes a screenshot in headless Chrome.

## License

MIT (see [LICENSE](LICENSE)).
