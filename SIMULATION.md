# Simulation

The plan for step 1 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: splitting the simulation from the
client. Afterwards the world's generation, its collision and the player's body run in a *server*
that has no Babylon and no browser in it, and the client only draws what the server says and sends
it what the player wants to do. Single player runs that server inside the page; `npm run server`
runs it on its own in Node. The game plays exactly as before.

**Status: done** (steps 1-8 below). What was built differs from the first plan in a few places;
those are noted where they come up.

## Principles

- **One generator, run twice.** The server and the client each build the world from the seed and
  the packs, with the same pure code. Nothing generated is ever sent: a chunk's ground, a tree's
  hulls, a house's colliders come out identical on both sides because they come from the same
  functions on the same inputs (GAMEPLAY.md, *Determinism*). Inside one process (single player)
  the server is handed what the page has already generated - the world data, the trees' hulls, the
  buildings' near models - read-only, rather than spending 15 more seconds making the same again.
- **The server decides, the client shows.** Where the player stands is the server's answer. The
  client keeps its own collision world for what only the eye needs (the camera's sweep, picking
  with the mouse, which house lights reach the player) and, later, for predicting its own moves.
- **Messages are plain data with a fixed shape.** Everything that crosses the boundary is a plain
  object of a known type: no class instances, no functions, no Babylon vectors, no free-form
  fields. The wire format is meant to become compact binary WebSocket packets, not JSON, so every
  message is written so a binary codec can be made for it (see [Encoding](#encoding)).
- **The boundary is enforced, not hoped for.** The Node entry refuses to load `@babylonjs/*` or any
  browser-only module (`scripts/server/guard.mjs`), so a stray import breaks `npm run server` at
  once, naming the file that made it, rather than years later. It found one on the first run:
  content resolving reached Babylon through the night-colour maths.
- **Don't move what needn't move.** Files stay where they are unless a file mixes the two halves;
  then the pure half is pulled out into a file of its own beside it. Other sessions are working in
  `src/world` at the same time, and a big move would collide with all of them.
- **Positions stay JavaScript numbers in the simulation** - 64-bit already. Nothing in the server's
  state is stored in a `Float32Array` or a Babylon vector, so step 2 (large-world positions) only
  has to change the client's rendering.

## Layers

```
Host        the page (single player) or Node (dedicated): owns the clock, calls server.step(dt)
Server      players, their bodies, collision around them; reads intents, writes snapshots
Channel     an in-memory pair of queues now; a WebSocket later
Client      input → intents; snapshot → meshes, camera, music, HUD; its own collision for the eye
Generator   the pure world: sampler, scatter, layouts, models' colliders - shared by both halves
```

## The split

### What exists today

`src/world` has 142 files. 19 of them import `@babylonjs/core`; six more are browser-only in other
ways (workers, IndexedDB, `fetch`, `import.meta.env`). `src/player` has four files, all Babylon;
`src/core` has one, Babylon. Everything else in `src/world` is pure already: the terrain sampler
and its pipeline, cells, rivers, roads, settlements, features, the building, prop and tree
*generators*, the scatters, materials' blending, weather's state, content loading and resolving,
and the whole collision library (`src/world/collision`).

### The 19 Babylon files in `src/world`

| File | Goes to | How it is untangled |
|---|---|---|
| `world.ts` | split | The pure half - sampler, layouts, fence/bridge/sign groups, `buildingAt`, labels (and the `PlaceLabel` type, from `ui/placeLabels.ts`), `heightAt`, `WORLD_SEED` - moves to a new `worldData.ts` (`createWorldData(seed, content)`). `createWorld(scene, data, …)` keeps the drawing and is handed that data instead of making it |
| `terrain/chunkGeometry.ts` | simulation | Its one Babylon call, `VertexData.ComputeNormals`, is replaced by our own (same sums, checked against the old with the fingerprint probe). Its ground grid and `probeGround` move to a pure `terrain/chunkGround.ts`, which a new collision-only chunk build (heights and tree placements, no materials or grass) also uses |
| `foliage/treeField.ts` | split | `colliders()` - each tree's hulls turned, tipped and scaled with Babylon's `Matrix` - moves to a pure `foliage/treeColliders.ts`: the hulls per kind and variant straight from the tree generator, placed with our own small quaternion maths in 64-bit (Babylon's matrix is 32-bit, so far from the origin the two differ by up to a quarter of a millimetre). `treeField` keeps the instances and calls it |
| `buildings/buildingRenderer.ts` | split | `placedAxes`, `placedShapes`, the in/out-of-range collision groups (now near any of several points: the players), `floorAt`, the cellar cuts and `enterableOf` move to a pure `buildings/buildingCollision.ts` (`createPlacedBuildings`). The renderer keeps meshes, LOD, light bakes and cutting the drawn ground |
| `materials/materialContext.ts` | simulation | Only `import type { FloatArray }`: becomes `ArrayLike<number>` |
| `materials/materialLibrary.ts` | client | Exports `TerrainCut`, which collision needs: that type moves to `buildings/buildingCollision.ts` |
| `lighting/dayNightMath.ts` | simulation | Content resolving uses its night tones, so it had to be pure: its tints became plain tuples, and the one function that made a Babylon `Color3` (the night sky's colour) moved into `sky/skyDome.ts`, its only user |
| `foliage/wind.ts` | client | Stays; `setWindStrength` is fed from the weather as now |
| `terrain/chunkManager.ts` | client | Stays: it streams *drawn* chunks. It keeps feeding the client's own collision |
| `terrain/terrainMesh.ts`, `terrain/ocean.ts` | client | Drawing only |
| `foliage/grassField.ts`, `foliage/treeModels.ts` | client | Drawing only (`treeModels` keeps making meshes; the hull maths it shares moves to `treeColliders.ts`) |
| `buildings/buildingMesh.ts` | client | Drawing only |
| `materials/litShading.ts` | client | Drawing only |
| `lighting/sunLighting.ts`, `lighting/playerLights.ts` | client | Drawing only |
| `sky/skyDome.ts`, `weather/precipitation.ts` | client | Drawing only |

The other browser-only files - `content/loadContent.ts` (fetch), `terrain/chunkBuildPool.ts`,
`lighting/lightBakePool.ts`, `lighting/lightCache.ts`, `materials/textureBakePool.ts`,
`materials/textureCache.ts` - stay client. The headless host loads packs from disk (as
`scripts/probe/loadContent.mjs` does) and passes the text to the same `resolveContent`.

`worldCollision.ts` is pure already except for types: it is changed to take a chunk's ground
heights and tree shapes rather than a `ChunkGeometry` and a `TreeField`, so the client feeds it
from its drawn chunks and the server from collision-only chunks.

### `src/player` and `src/core`

| File | Goes to | How |
|---|---|---|
| `player/characterController.ts` | split | The body - motor, "no ground in yet: stand on the terrain", "fell through: back on top" - moves to `src/sim/playerBody.ts`, driven by an intent. What is left is the client's view of the player: the capsule mesh, its facing, and turning keys plus the camera into an intent |
| `player/input.ts` | client | `Vector2` becomes a plain `{ x, y }` |
| `player/thirdPersonCamera.ts`, `player/spectatorCamera.ts` | client | Unchanged; the camera's sweep uses the client's collision world |
| `core/engine.ts` | client | Unchanged |

### New: `src/sim`

| File | What |
|---|---|
| `protocol.ts` | The message types, both ways |
| `channel.ts` | `createLocalChannel()`: two queues, a client end and a server end |
| `server.ts` | `createServer(world, options)`: collision, players; `connect(end)`, `step(dt)`; `debug` for hosts |
| `playerBody.ts` | One player's capsule on the server's collision world |
| `collisionStreamer.ts` | Keeps the ground, trees and buildings around every player in the server's collision world |

The headless host is not in `src/sim` but in `scripts/server/` (`main.mjs`, with `hook.mjs` and
`guard.mjs`), like the probe harness: the project has no Node types, and `src` is type-checked for
the browser. Everything under `src/sim` is plain TypeScript that runs in either.

## The message boundary

As built in step 1. Step 3 (ENTITIES.md) made the snapshot's `players` into `entities`, and added
entity spawn, values, modifiers and despawn messages, a `rules` hash in `welcome`, and debug
commands on entities (protocol 4). Step 2 (DIMENSIONS.md) added `travel`, `arrived` and `transfer`, a `dimension`
in `hello`, and moved the seed from `welcome` to `transfer`. Bodies for everyone (CHARACTERS.md)
added a `look` to `hello` and `entitySpawn` (protocol 5); `src/sim/protocol.ts` is current.

Client to server:

```ts
{ type: "hello", protocol, name }                        // joins; answered with "welcome"
{ type: "intent", seq, moveX, moveZ, run, jump }         // every frame: a world-space direction (length ≤ 1)
{ type: "teleport", x, z }                               // debug: map clicks, goto
{ type: "teleportTo", x, y, z }                          // debug: right-click on a roof
```

Server to client:

```ts
{ type: "welcome", protocol, playerId, seed, packs }     // packs: ids, so a client can tell what differs
{ type: "snapshot", tick, ackSeq, players: [{ id, x, y, z, facing, grounded }] }
```

Events (combat, loot) come with the systems that need them. `src/sim/protocol.ts` has the field
widths a binary codec would use.

- **Intents carry a world-space direction**, not keys. The camera is the client's, so the client
  turns "W with the camera looking north-east" into a heading itself; the server never knows there
  is a camera. Speed (walk 6, run 12) is the server's.
- **The channel is two queues.** `send` pushes; the other end drains what it has when it is ready.
  In single player the page sends the frame's intent, calls `server.step(dt)`, then reads the
  snapshot - all in one frame, so there is no latency and nothing is predicted. That is what keeps
  the game playing *exactly* as now.
- **Later, without touching gameplay code:** the server moves into a Worker (the channel becomes
  `postMessage`), or out of the page entirely (a WebSocket). Both need client-side prediction,
  which is why the client keeps a collision world of its own.

### Encoding

The aim is fully binary WebSocket packets. Nothing is serialised now, but the code is laid out so
that adding it means writing one codec, not touching the game:

- **Gameplay code sees only typed messages**, never bytes or strings. Server and client call
  `end.send(message)` and `end.receive()`; how a message travels is the channel's business.
- **A channel takes a codec**: `encode(message) → Uint8Array` and `decode(bytes) → message`. The
  in-memory channel passes objects straight through and uses none; a WebSocket channel is the same
  queues plus a codec.
- **Every message type is a closed, flat record**: a numeric-friendly `type` tag, then fields of
  known kinds - numbers (with a stated width: an id is a u32, a sequence number a u16, a position
  an f64), booleans, short strings, and arrays of such records. No optional bags, no `any`, no
  nested free-form objects. `protocol.ts` lists them in one union, so a missing case in a codec is
  a type error.
- **Snapshots are per-entity records**, so a later codec can send only what changed since the last
  acknowledged snapshot, and quantise (a facing in a u16, a position relative to a chunk).
- **A round-trip check** (`decode(encode(m))` equals `m` for every message type) is the test the
  binary codec must pass when it comes; it is written as a probe that runs over the in-memory
  channel's traffic.

## The player and collision on the server

Today the character's motor walks on a collision world that the *drawing* fills: a chunk's ground
and trees go in when the chunk is drawn at full detail, a settlement's houses when the player is
within 120 m of it. The server cannot rely on what is drawn, so it fills its own:

- **Ground and trees** - the collision streamer builds collision-only chunks (64 m, full detail)
  whose middles are within 128 m of a player, nearest first on a 2 ms budget per step, and drops
  them past 192 m. A collision chunk is the ground's height grid and the tree placements from the
  same `chunkGround.ts` the drawn chunk uses, so its heightfield is identical to today's. Where its
  chunk is not in yet the body stands on the sampled terrain height, as now.
- **Buildings** - the same in/out radii as today (120 m in, 180 m out), by group, from
  `buildingCollision.ts`. A house's colliders and interior come from its near model: in single
  player the ones the page made to draw it; on its own, the server makes them all at load (about
  2 s with the trees' hulls). Making them only when a group first comes near is left for when a
  bigger world makes it matter.
- **Cellars** - the ground's holes over cellars come from the same cuts, so cellars can still be
  walked down into.
- **Teleports** load the collision around the target at once, as `gotoLoaded` does for the drawn
  world.
- **The step** is the one the page calls: `server.step(deltaSeconds)`, clamped to 0.1 s inside the
  motor as now. A dedicated server steps on a 30 Hz timer. A fixed tick for single player too comes
  with prediction, later.

In single player there are then two collision worlds, the server's and the client's. Headless, with
one player running, a step costs about 1 ms on average, a step that brings in new chunks a few ms.

## `npm run server`

```
node --experimental-strip-types --import ./scripts/server/hook.mjs scripts/server/main.mjs
```

- The hook resolves extensionless imports (as the probe's does) and **throws on `@babylonjs/*`** and
  on the browser-only modules listed above. That makes the server itself the check that the split
  holds.
- It loads the packs, builds the world, and steps at 30 Hz, printing a line a second (players, tick
  time, collision chunks and shapes).
- `--bot` adds a player that walks a circle, so a headless run exercises the body and the streamer;
  `--ticks N` stops after N steps, for scripted checks; `--seed N` another world. No networking yet.
- `src/sim` is type-checked with the rest of `src` (which has the DOM's types). A separate
  check without them was planned and left out: without Node's types either, it would need
  hand-written declarations for `performance` and `console`, and the guard already catches what
  matters at run time.

## Steps

Each left the game working, checked in the dev server and with `npm run probe` and `npm run build`.

1. **Pure seams, no change in behaviour: done.** Own normals in `mathUtils.ts` (`computeNormals`,
   bit-for-bit the same as Babylon's over 285 000 components); `materialContext.ts`'s type;
   `TerrainCut` moved; `input.ts` without `Vector2`. (The fingerprint probe no longer runs - it
   imports a file that has since gone - so chunks were checked by hashing them instead.)
2. **Tree colliders out of `treeField.ts`: done** - `foliage/treeColliders.ts`. The new transform
   matches the old to under a micron near the origin over 20 000 random trees, leaning and not.
3. **Building collision out of `buildingRenderer.ts`: done** - `buildings/buildingCollision.ts`.
4. **`worldData.ts` out of `world.ts`: done**; `createWorld` takes the data, and the chunk build
   workers are still started before it is made, so loading is no slower.
5. **Collision-only chunks: done** - `terrain/chunkGround.ts`, shared by drawn and collision
   chunks. 54 drawn chunks at every level hash the same before and after; 192 collision chunks
   round settlements have the same heights and trees as the drawn ones.
6. **`src/sim` and `npm run server`: done.** Headless with `--bot`: the bot runs at 12 m/s, chunks
   come and go, no Babylon loaded.
7. **The game over the boundary: done.** `main.ts` starts a local server, sends intents and
   commands, draws from snapshots; `characterController.ts` is the player's view. Checked: standing
   where it stood before, walking, running, jumping, facing, the inn's floor and its cellar (below
   the ground), teleports, the spectator camera, the workbench and the collision sandbox. `__aiworld.character` keeps
   `teleport`/`teleportTo` (now commands); `__aiworld.server` is the local server.
8. **Wrap up: done.** GAMEPLAY.md's step 1 marked done.

## Not in this step

- The world clock, day and night, and weather stay in the client. When gameplay needs the clock
  (respawn timers, GAMEPLAY.md's world delta), the server owns it and sends the hour in snapshots.
- No entities other than players, no stats, no saves. (Entities and stats came in step 3: ENTITIES.md.)
- No fixed tick or prediction in single player; no Worker; no WebSocket; no binary codec yet.
- 64-bit positions and camera-relative rendering (step 2).
- No moving of drawing files into a `src/client` folder. Worth doing once the split has settled and
  nobody else is mid-change in `src/world`.
