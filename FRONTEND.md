# Front end

The plan for step 10 of [GAMEPLAY.md](GAMEPLAY.md)'s build order, done before step 9 so the
beginner experience can be tried from a real start. Most of the HUD already exists: the layout and
its look, the unit frames, the action bar and spell book, the XP bar, the inventory, the
progression panel and the rule book. This step adds what comes before and around the game. That is
a main menu, worlds, characters with a creation screen, saving and loading them, a pause menu, and
logging out. The quest log comes after step 9, which has the quests to put in it.

**Status: in progress.** Approved; steps 1 to 3 done (see [As built](#as-built)).

## Decisions

| Question | Decision |
|---|---|
| Characters and worlds | **A character belongs to one world**, like a Minecraft world or a WoW realm. Classes, disciplines and item types are generated from the world's seed, so a character only makes sense in its own world. On a dedicated server, the server keeps the characters |
| Save slots | **As many as the player wants.** Lists of worlds, and of characters in each world, with when they were made and last played. Renaming and deleting happen in the lists |
| Behind the menu | **A fixed showcase world**: always the same small world, loaded fast, with the camera drifting slowly over a chosen view. Continuing a game then loads that game in full, behind the loading screen |
| Looks | **Pickers on top of the seed.** Race, sex, the height and build sliders, and choosers for skin, hair colour, eye colour, hair style, beard and face, taken from the race's palettes and ranges. Each chooser overrides what the seed would pick, and *Randomise* rolls a new seed. Hair stays painted. A few painted hair styles are added to the races, but no hair geometry |

## Principles

- **One path for single player and a server.** Single player starts a server in the page for the
  chosen world and connects to it, as now. Joining a server goes through the same handshake over
  another transport. The character list, creating a character and entering the world are messages
  in both cases, never a shortcut that only single player has.
- **The client learns the world from the server.** Today the page assumes one seed (`WORLD_SEED`,
  1338) and resolves the rules from it before connecting. After this step, Welcome says the seed and
  config, and the client resolves its rules from them. Nothing in the client assumes a seed.
- **The server writes saves.** It is the authority on what a character has, so it writes characters
  and the world delta through a *save store*. In single player the store is the browser's
  IndexedDB; on a dedicated server it is files on disk. The client never writes a character itself.
- **Saving is continuous**, as in Minecraft. There is no *Save* button. The server saves every
  half minute, when a player logs out or travels, and when the page is hidden. Quitting loses at most
  the last few seconds.
- **A save is a small record of ids and numbers.** Progress is already one (PROGRESSION.md's
  `SavedProgress`); belongings become one. Loading skips anything the packs no longer have and
  reports it. It never stops a load.
- **The front end is pack data where a game would differ.** The showcase world and its camera, the
  title, the music and the UI sounds come from the packs. A different game can swap them without code.
- **Every part leaves the game working**, and `?play` skips the menu straight into a game, for
  testing and for the other systems' sessions (see [Dev shortcut](#dev-shortcut)).

## The screens

```
                    ┌───────────── Main menu ─────────────┐
                    │ Continue  (last character played)    │
   showcase world   │ New character                        │
   drifting behind  │ Worlds                               │──► Options (sound, graphics, keys)
   main theme       │ Options                              │
                    │ Quit      (only where it can close)  │
                    └──────────────────────────────────────┘
       Worlds ──► create a world / pick one / join a server
       a world ──► its characters ──► create one / enter one ──► loading ──► game
       game ──► Esc ──► pause menu: Resume · Options · Log out · Exit to menu
```

### Main menu

- **Over the showcase world.** A tiny world builds behind the menu while the menu is already shown
  over a dark backdrop. The world fades in when its first frame is drawn. The camera drifts along a
  slow path the pack gives: it orbits a point, rises and falls gently, and loops without a cut.
  Time of day and weather are fixed for the shot. There is no player and there are no creatures.
- **The main theme** (MUSIC.md, *Composed pieces*) plays from the first click or key press, since
  browsers start audio only then. It loops with a gap, keeps playing through the loading screen,
  and fades out when the game appears, so the zone music starts in its usual silence.
- **The title** is the game's name from the pack, in the HUD's bronze and gold look (`ui/theme.ts`).
- **Continue** enters the character played last, in its world, at once. It is hidden when there is
  none, and greyed with a reason when that world or character has gone.
- **New character** opens character creation in the world played last, or the world list when
  there is no world yet.
- **Worlds** opens the world list.
- **Options** opens the same sound and graphics panel the game's `O` opens (`hud.options`), with a
  read-only list of the keys. Settings stay in `localStorage` per browser, not in saves.
- **Quit** is shown only where the page can close itself (a desktop app window, later). In a
  browser tab there is nothing to quit to, so it is left out.
- **The version and the packs** are in a corner, as small print.

### Worlds

A list of the single-player worlds, newest played first. Each row shows the name, seed, size,
characters and when it was last played. A row's buttons are *Play* (to its characters), *Rename* and
*Delete*. Deleting asks for confirmation and names what goes with the world.

**Create a world:**

| Field | |
|---|---|
| Name | Free text, up to 32 characters; *New world* and a number if left empty |
| Seed | Random to start with, and editable. A number is used as is; any other text is hashed to one (`hashString`), and the number is shown |
| Size | One per config in `public/configs` plus the full game, with its size and roughly how long it takes to load (CONFIG.md's table): *Full* 29 zones, *Small* 4 zones, *Tiny* 1 zone |

The world records the packs and their hashes it was made with. Opening it later with different
packs shows a warning that lists what changed, with *Play anyway*, as a server's handshake will.

**Join a server:** an address and *Join*. It goes through the [handshake](#handshake) with a
network transport. There is no network transport yet (GAMEPLAY.md, *Networking*), so today the
connect step fails with "Joining servers is not there yet". That failure is shown the way a refused
or unreachable server will be shown. The address is remembered for next time.

### A world's characters

What the server sends after Welcome: one row per character with its name, people and class, level
(the config's `level` discipline), the zone it was in, and when it was last played. Choosing a row
shows the character on the stage, turning slowly. The buttons are *Enter world*, *Create
character*, *Delete* (with confirmation) and *Back*. A world with no characters goes straight to
creation.

### Character creation

The character stands in the showcase world on a small stage spot that the pack names, with the
camera close. Left is what it is; right is how it looks.

| Choice | From |
|---|---|
| People, class | The world's origins (PROGRESSION.md, *Origins*), one row per slot the game config lists, generated classes included. A combination that `never` forbids is greyed with the reason. Each origin shows its name and a short text (a new optional `description` field), its stats, and the abilities it starts with, from the same helpers as the rule book |
| Race | Set by the people (its `look.race`); a people with no race leaves it free to choose |
| Sex | Male or female |
| Height, build | The race's sliders, 0 to 1 within its limits |
| Skin, hair colour, eyes | Swatches from the race's palettes |
| Hair style | The race's painted styles (new: a `hairStyles` list in `races/`, below) |
| Beard | On or off, where the race and sex allow one |
| Face | Three small sliders: eye spacing, brow tilt, mouth width (the seed's `-1..1` shifts) |
| Randomise | A new seed, with every chooser following it. Each chooser can then be changed again |
| Name | 2-16 letters, with an apostrophe or hyphen inside allowed, capitalised, unique in the world. The server checks it and says why it refuses |

- **A live preview.** The body is rebuilt in the background when a choice changes, as gear changes
  are today, and the old one stays until the new one is in. It plays idle with small fidgets
  (weight shifts, a look around), and the class's swing or cast once when the class is picked.
  Dragging turns it, and the wheel zooms between the whole body and the face.
- **What the class wears.** The preview wears the outfit the new character starts in (the class's
  start items, else the race and class `look.outfit`), so a warrior looks like a warrior.
- **Create** sends the choices to the server. The server checks them, makes the character, saves
  it and answers with the new list. The client then enters the world with it at once.

### Looks: what is new in the character system

- **`Appearance` overrides.** `chooseAppearance(race, seed, sex, sliders)` gains an `overrides`
  argument (skin, hair and eye colour indices, beard, hair style, the three face shifts). The look
  sent in Hello and in spawns (ENTITIES.md, *Looks*: `EntityAppearance`) gains those fields as
  small numbers, so every client draws the same face. A field left out still comes from the seed,
  so every look saved before stays the same.
- **Hair styles.** `races/<race>.json5`'s `look` gains `hairStyles`: named shapes of the painted
  hairline (short, long, shaved sides, receding, tied back), drawn by `paint.ts` as the hairline is
  now. The core races get four or five each. The workbench's Model view gets the same choosers.

### Loading

The loading screen is the one used for dimension travel (`ui/loadingScreen.ts`). It gains a
heading, *Entering <world> as <character>*, above its phase line. Errors stop on it as now, with
*Back to menu* added under them.

### In the game: the pause menu and logging out

- **Esc** already closes things in order: the aimed teleport, the cast, the target. After those it
  closes the open windows, and when nothing is left to close it opens the **pause menu**. The menu
  has *Resume*, *Options*, *Log out* and *Exit to menu*.
- **In single player the world pauses** while the menu is open. The page stops stepping its server,
  so the world clock stops too. On a server it does not pause, and the menu says so.
- **Log out** saves and returns to the world's character list. **Exit to menu** saves and returns to
  the main menu. Both send `logout` and wait for the server to confirm the save (a second at most),
  then tear the game down. In single player the page's server is stopped and dropped. The showcase
  world is built again behind the menu.
- **A small "Saved" mark** fades in and out in a corner after each save, so saving can be seen
  without getting in the way.
- **Closing the tab** while playing saves what the last autosave had, plus a best-effort save when
  the page is hidden (`visibilitychange`). IndexedDB writes cannot be waited for on unload, so at
  most the last half minute can be lost, and usually nothing is.

## Saves

### What is saved

GAMEPLAY.md's *Saved state*, as far as the systems exist today. Quests, reputation, the explored map
and travel points add their parts when their steps come.

```ts
// src/save/records.ts
interface WorldRecord {
  version: 1;
  id: string;                 // made when it is created; names its folder or key
  name: string;
  seed: number;               // u32
  config: string;             // "default", "small", "tiny"
  packs: { id: string; hash: number }[];   // what it was made with, for the warning
  created: number; played: number;          // ms since 1970
  time: number;               // the world clock (GAMEPLAY.md, *World delta*), in seconds
  delta: [string, number][];  // the world delta's entries: key -> world time it comes back
  nextItemId: number;         // the item store's next id (ITEMS.md)
  characters: CharacterSummary[];          // for the lists, without loading each record
}

interface CharacterSummary { id: string; name: string; origins: Record<string, string>; level: number; zone: string; played: number }

interface CharacterRecord {
  version: 1;
  id: string; name: string;
  created: number; played: number; playedSeconds: number;
  look: SavedLook;            // seed, race, sex, sliders and the overrides above
  progress: SavedProgress;    // PROGRESSION.md, as exportProgress gives it
  belongings: SavedBelongings;// bag, bank, equipment, wallet (new: exportBelongings/importBelongings)
  resources: Record<string, number>;       // health, mana... by id, so a fight is not undone by logging out
  dead: boolean;              // logged out dead: comes back at home, alive
  travel: { dimension: string; x: number; z: number; facing: number; home: { dimension: string; x: number; z: number } };
  interface: { actionBar?: unknown };      // the client's own layout, kept by the server, never read by it
}
```

- **Belongings** are saved the way progress is. `exportBelongings(entity)` writes item instances as
  `{ type: id, count, rolls, durability, ... }` by id, and `importBelongings` reads them back. A type
  the packs no longer have is dropped and reported. The world's `nextItemId` keeps instance ids
  unique across restarts.
- **The action bar's layout** moves from `localStorage` (keyed by origins today) into the character
  record's `interface`. The client sends it with `saveInterface` when it changes, and the server
  stores it as an opaque value of up to 16 KB that it never reads. This is the WoW way, and the bar
  follows the character to another browser or a server.
- **Auras and cooldowns** are not saved yet: a character comes back clean. Durations that outlive a
  logout (a long buff) can be added later as a part of the record.
- **Versions.** Each record has `version`. A newer one than the code knows is refused with a clear
  message. Older ones are migrated forward by small functions in `src/save/migrate.ts`, one per
  version step.

### The save store

```ts
// src/save/store.ts
interface SaveStore {
  listWorlds(): Promise<WorldRecord[]>;   // without the delta, for the list
  readWorld(id: string): Promise<WorldRecord | null>;
  writeWorld(world: WorldRecord): Promise<void>;
  deleteWorld(id: string): Promise<void>; // and its characters
  readCharacter(world: string, id: string): Promise<CharacterRecord | null>;
  writeCharacter(world: string, character: CharacterRecord): Promise<void>;
  deleteCharacter(world: string, id: string): Promise<void>;
}
```

| Where | Store |
|---|---|
| Browser | `save/indexedDbStore.ts`: database `aiworld`, stores `worlds` and `characters` (keyed `[world, id]`), each write a transaction |
| Node | `scripts/server/fileStore.mjs`: `saves/<world>/world.json` and `saves/<world>/characters/<id>.json`, each written to a temporary file and renamed over the old one, so a crash never leaves half a file. `saves/` is git-ignored |
| Tests, `?play` | `save/memoryStore.ts`: a Map, gone with the page |

The store is in `src/save` and imports nothing from Babylon or the DOM except the IndexedDB one, so
the server and probes run it in Node, as SIMULATION.md asks of `src/sim`.

### When the server saves

- **Every 30 s** (`save.interval` in a new `rules/frontend.json5`, below), a character is saved only
  if something about it changed, and the world only if its delta or clock moved. Writes are
  async and never block a step. A save still running when the next is due is skipped, not queued.
- **On logout, travel, death and level-up**, the character at once.
- **When the page is hidden**, single player saves everything at once.
- **A dedicated server** saves on `SIGINT`/`SIGTERM` before it exits.

## Handshake

The messages for single player and a server alike. `PROTOCOL_VERSION` goes up by one.

```ts
// client -> server
{ type: "hello", protocol, client }                     // no character yet; `client` names the build
{ type: "characterCreate", name, origins, look }        // origins: slot -> id; look: SavedLook
{ type: "characterDelete", id }
{ type: "enterWorld", character, dimension }            // dimension: debug, "" for where it logged out
{ type: "logout", toMenu }                              // save, take the body out, answer loggedOut
{ type: "saveInterface", value }                        // the client's layout, as JSON text

// server -> client
{ type: "welcome", protocol, seed, config, packs, rules, items, creatures, progression, worldName, pausable }
{ type: "characters", list: CharacterSummary[] }        // after Welcome, and after a create or delete
{ type: "refused", what, reason }                       // a bad name, a full world, a version mismatch...
{ type: "transfer", ... }                               // as now: joining is travelling (DIMENSIONS.md)
{ type: "loggedOut" }                                    // the save is written; the client may leave
{ type: "saved" }                                        // for the "Saved" mark
```

1. **Connect.** `connect(target)` returns a channel or a reason. Today it has `local:<world>`, which
   starts a server in the page for that world, and anything else fails with "Joining servers is not
   there yet". A WebSocket transport goes here later.
2. **Hello → Welcome.** Welcome carries the seed and config. The client loads that config's packs,
   resolves its rules from the seed, and compares hashes. A mismatch shows what differs, with
   *Back*. Some mismatches only warn: the content still loads but may look wrong, as the warnings in
   `main.ts` do today.
3. **Characters.** The server sends the list. Creating, deleting and choosing a character are
   messages, as above.
4. **enterWorld → Transfer.** The server loads the record and makes the entity from its origins.
   It applies the look, progress, belongings and resources, then sends Transfer to where the
   character logged out. From there everything goes as DIMENSIONS.md's join does.
5. **logout → loggedOut.** The server saves and takes the player out of its dimension. Its
   connection stays, back at step 3.

Hello's debug fields today (`dimension`, `look`, `origins`, `name`) move: the dimension to
`enterWorld`, and the rest to a debug `quickCharacter` that `?play` and `npm run server`'s bots
send instead of creating and choosing (see [Dev shortcut](#dev-shortcut)).

## Where a new character starts

**In one place: `src/sim/spawn.ts`'s `startingPlace(world, character)`**, which returns
`{ dimension, x, z, facing }`. Today it returns the start dimension's `spawn`. New characters and
`home` both come from it, and `respawn` reads the character's `home` instead of the dimension's spawn.
Step 9 replaces the body of `startingPlace` with the generated starting village chosen for the
character's people. Nothing else changes.

## Pack data

`rules/frontend.json5`, replaced whole by a later pack as the other rules files are:

```json5
{
  title: "aiworld",
  showcase: {
    config: "tiny", seed: 1338, dimension: "mainland",
    hour: 17.5, weather: "clear",
    // The camera's path: round `around` at `radius`, a full turn in `period` seconds, rising and
    // falling by `bob` metres; looking at `look` metres above the ground at the centre.
    camera: { around: [120, -40], radius: 90, height: 28, bob: 6, period: 240, look: 4 },
    // Where creation and the character list stand the character, and the camera's distance there.
    stage: { at: [96, -52], facing: 200, distance: 3.2 },
  },
  music: { menu: "mainTheme", gap: [8, 15] },  // seconds of silence between loops
  save: { interval: 30 },
  names: { min: 2, max: 16 },
}
```

The showcase's spot and path are chosen by looking at the tiny world. The values above are
placeholders.

## Sounds and cues

Through FEEDBACK.md's event table: new client event keys in `rules/feedback.json5`, with cues and
generated sounds in the core pack, in the `ui` mix group. No feedback code changes.

| Event | When | Sound |
|---|---|---|
| `uiHover` | The pointer onto a menu button | A soft tick |
| `uiClick` | A button pressed | The windows' open flip, lighter |
| `uiBack` | Back, Cancel, Esc in a menu | A falling two-note |
| `uiError` | A refusal: a name taken, a version mismatch | The existing `error` |
| `uiSwatch` | A look chooser changed | A small cloth or brush sound |
| `characterCreated` | Create accepted | A short rising chord |
| `enterWorld` | Enter world pressed | A swell that hands over to the loading screen |
| `logout`, `saved` | Logged out; a save written (quiet, only after a manual logout) | A door-like close; none for autosaves |

The menu's feedback needs no world. It runs from the packs the menu loaded, with no scene, so no
particles, only sound.

## Code

| File | What |
|---|---|
| `src/main.ts` | What lasts the page: the engine, the loading screen, music, feedback, the front end. It starts the menu, or a game when `?play` |
| `src/game/session.ts` (new) | Everything that `main.ts` does today for one world: the connection, the rules from Welcome, the mirrors, the HUD's windows and bars, the keys, `__aiworld`. `startSession(connection)` gives a session; `dispose()` tears all of it down, as `leave()` does for a dimension |
| `src/frontend/` (new) | `mainMenu.ts`, `worldList.ts`, `characterList.ts`, `characterCreate.ts`, `pauseMenu.ts`, `showcase.ts` (the menu's world view and camera), `stage.ts` (the preview body), `frontend.ts` (which screen is up, and Continue) |
| `src/save/` (new) | `records.ts`, `store.ts`, `memoryStore.ts`, `indexedDbStore.ts`, `migrate.ts`, `connect.ts` (`local:` and the stub) |
| `src/sim/server.ts` | The handshake above; loading and saving characters and the world through a `SaveStore` given to `createServer`; the autosave; the clock and delta from the record |
| `src/sim/spawn.ts` (new) | `startingPlace` |
| `src/sim/items/save.ts` (new) | `exportBelongings`, `importBelongings` |
| `src/character/paint.ts`, `raceDef.ts` | Appearance overrides, hair styles |
| `scripts/server/` | `--world <name>`: a world in `saves/<name>`, made on first run with `--seed` and `--config`. `fileStore.mjs` |

## Dev shortcut

**`?play`** skips the menu and goes straight into a game, as the bare URL did before the menu:

- a throwaway world with no saves, with seed 1338 unless `?seed=` says otherwise;
- `?config=`, `?dimension=`, `?people=`, `?class=`, `?race=`, `?outfit=`, `?sex=` and `?look=`
  work as before, through Hello's quick fields;
- `?play=<world>` enters that saved world with its last character, or `?play=<world>/<character>`
  with a named one. This is for testing saves.

The other sessions' habits change in one way: the bare URL now shows the menu, so their test URLs
gain `play`. A note goes in the shared notes when the menu lands. `npm run server` keeps working
without saves unless `--world` is given.

## Steps

Each step leaves the game working: the dev server, `npm run probe`, `npm run server` and
`npm run build`.

1. **The session: done.** Move `main.ts`'s per-world code into `game/session.ts` with `dispose()`.
   Welcome carries the seed and config, and the rules are resolved after it. `WORLD_SEED` becomes the
   dev default only. `?play` is added, but the bare URL still plays, as now. Check for leaks: start
   and dispose a session several times under `small`, with the heap steady.
2. **Saves, headless: done.** Records, the store (memory, IndexedDB, files), migrations, belongings export
   and import, the handshake messages, `startingPlace`, the autosave, and the world clock and delta
   in the record. `npm run server -- --world test` makes, saves and loads a world. The probe
   round-trips a character with progress, belongings and resources through each store, restarts a
   server and finds the delta and clock kept, and refuses bad names.
3. **The main menu: done.** `rules/frontend.json5`, the showcase world and its camera path, the main
   theme, Options, Continue, and the world list with create, rename and delete. The bare URL shows
   the menu. A character can only be entered through the list, with a default look. The notes go to
   the other sessions.
4. **Character creation.** The character list, the stage and preview, origins, the look choosers,
   appearance overrides and hair styles (with the workbench's choosers), and names.
5. **In the game.** The pause menu, logging out and exiting, the "Saved" mark, the action bar's
   layout in the record, the loading screen's heading and *Back to menu*, and pausing single player.
6. **Sounds and Join.** The UI cues and their sounds, and *Join a server* through the handshake to
   its stub failure, with the mismatch screen.
7. **Wrap up.** Run the whole loop by hand: launch, make a world and a character, play, level up and
   loot, log out, reload the page, Continue, and find everything kept. Check menu ↔ game five times
   for leaks. Update GAMEPLAY.md's step 10 to done, CHARACTERS.md's *Next steps* 4, PROGRESSION.md's
   *Not in this step*, DIMENSIONS.md's *Later*, and `public/packs/README.md`.

## As built

- **Step 1.** `src/game/session.ts` is what `main.ts` did for one world; `main.ts` keeps the engine,
  the loading screen, the HUD's regions, the zone label, the position panel and the music. Every
  window and canvas listener a session adds goes through one `AbortController`. Its `dispose()` closes
  the player's channel and steps the server once, so the server lets the player go and drops the
  dimension, as a logout will. Then it tears down the view and every window and bar. The feedback
  gained `dispose()`, `whenAudio` returns a cancel, and the HUD's `onActionsWidth`/`onMenuVertical`
  return an unsubscribe. In the console, `await __aiworldPage.restart()` ends the game and starts it
  again, and `__aiworldPage.end()` only ends it.
- **Checked for leaks** under `tiny`: four restarts kept the heap at about 2.08 GB, the DOM the
  same, and the server with one player and one dimension. The windows and keys still opened once each.
  The servers of the 2nd to 4th sessions were collected. The first session's server was still
  reachable for a reason not found, but it holds no dimension, and its server does not grow with
  more restarts.
- **Measuring leaks from the console:** a `const` declared at the top of a console evaluation stays
  in the console's scope and keeps what it holds alive. Wrap test code in a block or an async function.
  Babylon disposes a disposed scene's shaders at the end of the next frame, so with nothing drawing,
  the old scene's shell stays until something renders.
- **Not yet:** Welcome already carried the seed. The session now warns when it differs from the one
  its rules were resolved from. Resolving the rules *from* Welcome comes when the page uses the
  handshake (step 3).
- **Step 2.** `src/save/` has the records, the `SaveStore` interface, the memory and IndexedDB stores
  and `migrate.ts`. `scripts/server/fileStore.mjs` is the Node store (in `scripts/` because `src` has
  no Node types). `src/sim/items/save.ts` exports and imports belongings, and `src/sim/spawn.ts` has
  `startingPlace`. `createServer` takes `saves: { store, world, interval, onProblem }`. The world's clock,
  delta and next item id carry on from the record. `server.save()` writes everything now.
  `npm run server -- --world <name>` keeps a world in `saves/<name>`, and its bot plays a saved "Bot".
  Where the build differs from the plan above:
  - **Hello keeps its quick fields** (`name`, `dimension`, `look`, `origins`) and gains `select`.
    With `select` the client gets Welcome and Characters and chooses. Without it, a quick unsaved
    character plays at once, as before. That is the dev shortcut's and the bots' path, so no
    separate `quickCharacter` message was needed and no bot changed.
  - **Entered** (`playerId`, `character`, `interface`) comes before the Transfer, since a Welcome
    that selects has no player yet (`playerId` 0). Welcome gains `world` (its name) and `saves`.
    `PROTOCOL_VERSION` is 10.
  - **The world record keeps the rules' hashes** (`rules`, `items`, `creatures`, `progression`) and
    the pack ids, rather than a hash per pack: the hashes are what the server already sends in
    Welcome. A character summary has `place` (the dimension's name) instead of a zone, since the
    server knows no zone names.
  - **The interface** is JSON text the server keeps and never parses (16 KB at most).
  - **Writes are queued per record**, so one character's writes never overtake each other. Each
    write takes a copy made when it was asked for. An autosave is skipped while any write is still
    running. Entering a character waits for its last write.
  - **A character left dead** comes back at home, with the resources a new one has. Respawning
    goes to its home when the home is in the dimension it died in.
  - **Leaving** (logout, a closed connection) also takes the player's items out of the item store.
    Before, they stayed there, unused.
  - `--fight` and `--hunt` bots read their id from Welcome, so they do not work with `--world` yet.
- **Checked:** `scripts/probe/saves.mjs`, 51 checks:
  - names;
  - a newer save refused;
  - the memory and file stores round-tripped;
  - a real `tiny` server: making characters (bad names and origins refused), entering, playing a
    character twice and deleting one in play both refused, autosave, logout, and a restart that
    finds the level, bag, worn gear, money, health, position, layout, clock and delta kept;
  - closing the tab saves;
  - a character left dead comes back alive at home.

  The IndexedDB store was round-tripped in the page. The entities, abilities, items, progression,
  creatures and feedback probes pass. The feedback probe's "chips fall" check failed once in three
  runs. It uses unseeded randomness, and this step does not touch it.

- **Step 3.**
  - **What runs where.** `src/game/connection.ts` resolves a world's rules (moved out of the
    session), starts its server in the page and connects to it. The front end owns the connection
    from choosing a world until it goes back to the list. A session plays one character over it and
    sends `logout` when disposed; a quick game's connection goes with its game.
    `src/frontend/frontendRules.ts` reads `rules/frontend.json5`, `src/frontend/showcase.ts` is the
    menu's world, and `src/frontend/frontend.ts` holds the screens and starts and ends games.
    `main.ts` fetches every pack once (`packSetFrom` narrows them per config without fetching again)
    and starts the front end. With `?play` it starts a quick game instead.
  - **The showcase** is the tiny world at seed 1338, the camera circling the village at (837, 390)
    at 17:30. The start spawn of that world is low and wet, and a village at dusk looks better.
    `createDimensionView` gained `body: false` (no player body, no capsule drawn), and the HUD gained
    `playing` (off, only the windows region shows, so Options works over the menu).
  - **The menu's music.** The menu asks for the `mainTheme` style four times a second. The theme
    keeps playing through the loading screen, and gives way to the zone's music on the usual 4 s
    settle once the game draws.
  - **The screens:**
    - main: Continue, New character, Worlds, Options;
    - worlds: play, rename, delete, create with name, seed and size;
    - a world's characters: enter, delete, create;
    - a stand-in character creation: origins and a name, the look a random seed and the people's
      race, until step 4.

    Escape goes back. A world whose rules' hashes changed since it was made says so on its
    character list.
  - **Coming back to the menu** is `__aiworldPage.leave()` (to the world's characters) or
    `leave(true)` (to the main menu) until the pause menu in step 5.
  - **Checked in the page:**
    - make a tiny world and a character, enter, level up and move;
    - leave to the menu, reload the page, Continue: back at level 3 where it was left;
    - leave to the character list: "Level 3 Human Warrior · The Mainland";
    - `?play&people=dwarf&class=mage` and `__aiworldPage.restart()` still play quick games;
    - `?play=<world>` goes straight in (10 s for the tiny world) without building the menu's world.
  - **A bug found on the way.** The menu read the connection's messages until the session it was
    starting had resolved, so it took Entered and Transfer from it. The menu now stops reading when
    a game starts, not when it has started.
  - Not yet: `names` in `rules/frontend.json5` is read but the server still uses its own 2-16 limits.

## Later

- **The quest log**, after step 9 makes quests (GAMEPLAY.md's build order).
- **A real transport** for *Join a server*, and logins for a server's players. Today a server trusts
  the name a connection gives, which is fine for co-op among friends until then.
- **Exporting and importing a world** as a file, for backups and moving saves between browsers.
- **Hair and beard geometry** (CHARACTERS.md, *Next steps* 7), more face parts.
- **Saving auras and cooldowns** across a logout.
- **A desktop app window**, where *Quit* closes the game.
- **Key rebinding** in Options.
