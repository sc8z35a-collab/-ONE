---
name: texture-sheets
description: Generate realistic surface textures for INK//SHIFT with OpenAI's gpt-image-2.5-sunburst — square 1:1 images at the largest size (2880×2880), quality medium, each holding a 3×3 grid of nine seamless textures — and install them in the game. Use when asked to generate, regenerate, add or replace textures, texture sheets or materials, or to make the city look more realistic.
---

# Texture sheets

The game's realistic surfaces come from eighteen images ("sheets"). Each
sheet is a 3×3 grid of nine textures, so eighteen sheets give the 162 textures
the game uses. A sheet is either generated with this skill or supplied as a
finished image (see "Supplied sheets"). When the game loads, it cuts every sheet into its nine textures,
blends the irregular ones (asphalt, concrete, grass…) into seamless tiles,
and mirrors the regular patterns (bricks, tiles, planks…) as they repeat.

| File | Role |
| --- | --- |
| `dist/surfaces.js` | The 162 textures: id, prompt, real-world size (`meters`), `pattern`, `take`, optional `crop` and `repeat`. Their order is their slot in the shaders. |
| `.claude/skills/texture-sheets/scripts/generate.mjs` | Calls the API, keeps the original in `textures/source/`, ships a 1536×1536 copy to `dist/textures/`, updates `dist/textures/index.json`. |
| `dist/surface-textures.js` | Loads the listed sheets and cuts them into a texture array. |
| `dist/render-shaders.js` (`surfaceFor`) | Picks a texture for every surface from its material, colour, shape and place. |

## Generate

The key is never written into a file, a command line or the chat.

- On a computer: `export OPENAI_API_KEY=…` in your own shell first.
- In a Claude Code cloud session: save the key for `api.openai.com` as a
  network secret (ask Claude to request the credential), then run with
  `OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1` so Node's `fetch`
  goes through the session proxy, which adds the real key.

```bash
OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 node .claude/skills/texture-sheets/scripts/generate.mjs
```

- No arguments: every missing sheet. Name sheets to make only those:
  `street walls metal nature station gear`.
- `--force` replaces sheets that already exist.
- `--size 2880x2880` (default; the largest square the API accepts, falling
  back to 2048 and 1024) and `--quality medium` (default; also `low`, `high`,
  `xhigh`, `max`). `--parallel 3` runs three requests at once.

Each sheet is one image request. A failed run tells you why — for example
"You have no credits remaining" means the OpenAI account needs credit at
https://platform.openai.com/settings/organization/billing before anything can
be generated.

## Check the result

1. Look at every new `textures/source/<sheet>.webp`: nine distinct materials
   in a regular grid, viewed straight on, no text, no frames, no perspective.
   Regenerate a sheet with `--force` if it is not.
2. Run the game (`npm run dev:cloud`, or open `dist/index.html` from a local
   server). The textures appear a moment after the title screen; the
   procedural surfaces remain until each sheet has loaded.
3. `npm run check` must pass.

## Add or change textures

Edit the cell in `dist/surfaces.js` (prompt, `meters`, `pattern`, `take`),
bump `TEXTURE_VERSION`, regenerate that sheet with `--force`, and — for a new
material — return its slot from `surfaceFor` in `dist/render-shaders.js`.
Every texture must be used by some surface; the test suite checks that each
of the 162 slots is referenced by the full shader.

## Supplied sheets

A finished 3×3 image can stand in for a generated one. Put it at
`textures/source/<sheet>.webp` (with a small `<sheet>.json` noting it was
supplied, so the script never regenerates it) and at
`dist/textures/<sheet>.webp`, then list the sheet in
`dist/textures/index.json`. Cells whose image shows edges, objects or
perspective around the usable surface get a `crop: [left, top, right, bottom]`
window (fractions of the cell). Only listed sheets take GPU memory.
Building fronts and scale shingles mirror badly (every other storey would
turn upside down), so their crop spans an exact number of periods, measured
on the image, and they carry `repeat: true` to tile without mirroring.
