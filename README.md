# FlipperDelux

A neon 3D pinball (flipper) game built with [three.js](https://threejs.org/). Custom 2D physics on the table plane, rendered in 3D with bloom, shadows, and procedural sound.

## Run

```bash
npm install
npm run dev
```

Then open the printed localhost URL.

## Controls

| Key | Action |
| --- | --- |
| `A` / `←` | Left flipper |
| `L` / `→` | Right flipper |
| `Space` (hold) | Charge and launch the ball |
| `R` | Restart after game over |

On touch devices, tap the left/right half of the screen for the flippers and use the LAUNCH button.

## Scoring

- Pop bumper: **100**
- Slingshot: **25**
- 3 balls per game; high score is kept in `localStorage`.
