# Probes

A throwaway script that imports real project source directly (no browser, no build step) to
check pure logic - noise formulas, spacing invariants, split math, whatever doesn't need a
rendered frame. Used throughout this project's history to measure before changing a constant and
to verify an invariant (tiling, density, distribution) instead of asserting it.

## Usage

Write a script anywhere convenient - `scripts/probe/scratch.mjs` is a fine default, and is
gitignored so it never needs cleaning up - importing project source the normal, extensionless way:

```js
import { createTreeScatter } from "../../src/world/foliage/treeScatter.ts";
```

Then run it:

```bash
npm run probe -- scripts/probe/scratch.mjs
```

`hook.mjs`/`tsResolve.mjs` are what make the extensionless import above resolve to the real `.ts`
file - Node's own resolver has no notion of it. Everything else here (bake pools, Babylon,
anything DOM/WebGL) is out of reach, same as any Node script; probes are for logic that runs the
same with or without a renderer.
