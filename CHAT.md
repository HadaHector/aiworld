# Chat

The combat log (bottom left of the HUD) becomes the **chat window**: you type in it, first to run
commands that test the game, later to talk to other players. One window, one message path, from the
single-player test bench to a 20-player server.

**Status: built** (steps 1-5; see *As built*).

## Decisions (the user's, from the planning questions)

| Topic | Decision |
|---|---|
| Opening | **Enter** opens the input line; Enter sends, Escape cancels. `/` is typed by hand to start a command |
| Idle look | The input line is hidden until opened; the log fades when quiet |
| Developer commands | Gated by a flag, checked where the effect is owned. The existing `debug*` messages (F2 panel, map teleport) are **left as they are** for now |
| Extra command | `/world`: tells the world generation parameters (seed, config, packs, dimension, zone, biome, counts) |

## What exists

- `src/game/combatHud.ts` owns the log: a `div` of at most 14 plain strings (`log(events)` from
  `describeEvent`, `say(line)` for level-ups and refusals), non-interactive, no scrollback.
- `src/ui/hud.ts` places it (`regions.log`), bottom left, up to 400 px wide.
- `session.ts` has many `window` key handlers that each skip `INPUT`/`TEXTAREA`/`SELECT` targets;
  `player/input.ts` (movement) and the one-key shortcuts do not all check; the action bar's 1-9 and
  `E`, `O`, `M`, `T`, `Tab`, `F2` are among them.
- The boundary (`sim/protocol.ts`, protocol 13) has no chat. `sim/text.ts` has `renderText` and
  `fillText` for translatable templates. Debug intents are ungated on the server.

## Principles

- **One window, many channels.** Combat, system, say today; party, whisper, guild later. A message
  is `{ channel, sender, text }` whatever its origin.
- **Commands belong to whoever owns the effect.** `/give` changes the server's items, so the server
  runs it; `/clear` and `/help`'s layout are the window's, so the client runs them. The player types
  the same thing either way.
- **Registered, not hard-coded.** The UI knows how to read a line and show a reply; commands come
  from a registry that core, packs and mods fill.
- **Server decides.** A client may hide a command it knows is off, but the server refuses it too.
- **All words are templates** (QUESTS.md, *Text*): replies are `{ text, args }`, translated and
  filled by the reader's client.
- **Built to grow, built small.** Parties, whispers and a network transport change who receives a
  message, not its shape.

## The message boundary

Protocol 13 -> 14. Closed, flat records, as the others.

```ts
// client -> server
interface ChatSend { type: "chat"; channel: string; text: string; target?: string }   // text <= 256
// target: a name, for a whisper (later); "" otherwise

// server -> client
interface ChatEvent {
  type: "chatEvent";
  channel: string;            // "say", "system", later "party", "whisper"
  from: number;               // u32 entity, 0 for the server
  fromName: string;           // shown even after the sender left view
  text: string;               // a template, or plain words typed by a player
  args: Readonly<Record<string, string | number>>;   // {} for typed words
  typed: boolean;             // true: a player's own words, never translated
}
```

- A line starting with `/` is a **command**: `{ type: "chat", channel: "command", text: "give iron-sword 2" }`.
  The client sends the whole line to the server unless the command is registered as client-owned.
- **Replies** are `chatEvent`s on `system`, to the sender only. Errors use the same path, with the
  usage line.
- **Say** goes to players in the sender's dimension within `sayRange` (default 30 m), the sender
  included. Later channels pick other recipient sets (`party`: members; `whisper`: one name;
  `global`: all). The server owns the recipient choice.
- **Sanitising**: text trimmed, control characters and newlines dropped, collapsed spaces, length cap
  (256), and a rate limit (5 messages per 3 s, then a `system` refusal). Typed text is shown as
  text (`textContent`), never HTML.
- Combat events stay as they are (`combatEvents`, `progressEvents`, `itemRefused`...). The client
  turns them into `combat` and `system` lines; the server does not duplicate them as chat.

## Commands

`src/sim/chat/commands.ts` (new): a registry.

```ts
interface CommandDef {
  id: string;                  // "give"
  aliases?: string[];          // "g"
  usage: Text;                 // "<item> [count]" - a template, translated
  summary: Text;
  dev: boolean;                // needs the devCommands flag
  owner: "server" | "client";
  args?: ArgSpec[];            // for parsing and completion: "item", "skill", "zone", "place", "int", "number", "word"
  run: (ctx: CommandContext, args: ParsedArgs) => void;
}
```

- **Packs declare** command *metadata* (`public/packs/core/commands/*.json5`: id, aliases, usage,
  summary, `dev`, argument kinds, optionally a macro that expands to other commands, like
  `{ id: "heal", run: ["resource hp +9999", "resource mana +9999"] }`). **Code registers** the
  behaviour (`registerCommand(id, run)`), so a pack alone can only compose existing commands, and a
  mod adds new code. A pack command with no code and no macro is a content error at load.
- The **parser** handles quoted arguments (`"iron sword"`), item/skill/zone names by id or display
  name (case-insensitive, unique prefixes), and reports `bad argument` with the usage line.
- **Permissions**: `dev: true` commands run only when the server's `devCommands` is on. The flag
  lives in the world config (`public/configs/<name>.json5`, `server: { devCommands: true }`); the
  default is on for the in-process single-player server, off for `npm run server` unless `--dev` or
  the config says so. The Welcome carries the flag, so `/help` can list only what works and the
  client can complete it; a refused command answers `Developer commands are off on this server.`
- **Client-owned** developer commands (`/time`, `/weather`: the world view renders both today) are
  still gated by the Welcome's flag; the server does not see them, so this gate is honest only for
  single player. When the server owns time and weather (a networked step), they move to the server
  with no change for the player.

### Core commands (first set)

| Command | Owner | Dev | Does |
|---|---|---|---|
| `/help [command]` | client | no | Lists commands with usage; with a name, its usage and summary |
| `/clear` | client | no | Empties the shown channels |
| `/say <text>` | server | no | Same as plain text |
| `/world` | client + server | no | Seed, config, packs, dimension, world size, zone, biome, weather, settlement, creature level band at the player |
| `/give <item> [count]` | server | yes | Item to the bag (uses `debugItem` logic) |
| `/level <n> [discipline]` | server | yes | Sets a discipline's level (default: the character's) |
| `/xp <amount> [discipline]` | server | yes | Adds XP |
| `/heal` | server | yes | Fills every resource, clears debuffs |
| `/kill [target]` | server | yes | Kills the target, or the player if none |
| `/revive` | server | yes | Brings the target or the player back |
| `/tp <x> <z>` / `/tp <zone>` / `/tp <place>` | server | yes | To coordinates, a zone's centre, a named settlement or travel point |
| `/spawn <creature or template> [count]` | server | yes | Beside the player |
| `/learn <skill\|all>` | server | yes | Teaches a skill; `all` is `debugLearnAll` |
| `/time <hour>` | client | yes | Time of day |
| `/weather <id>` | client | yes | Weather in the zone |
| `/reveal` | client | yes | Reserved: MAP.md has no fog, so it does nothing today; it stays registered for when fog of war exists |

Debug logic that already exists (`debugItem`, `debugXp`, `debugLevel`, `debugKill`, `debugSpawn`,
`debugLearnAll`, `teleport`) moves into server-side command handlers; the old messages stay until
the debug panel is moved onto commands (a later step, out of this plan).

## The window

`src/ui/chatWindow.ts` (new), replacing the log in `combatHud.ts`; the combat HUD keeps the frames
and bars and calls `chat.combat(events)` / `chat.system(text)`.

- **Lines** are `{ channel, text, time, colour }`; up to 500 kept, scrollable with the wheel and
  PageUp/PageDown; it stays at the bottom unless scrolled up (a "new messages" nudge shows).
- **Channels** (colours in `ui/theme.ts`, bronze-and-gold): combat (grey-gold), system (amber),
  say (white), later party (blue), whisper (violet). Tabs along the top: **All**, **Combat**,
  **Chat**; each remembers its own filter set; a right-click on a tab edits which channels it shows.
  Filters and size are saved with the character's interface layout (`saveInterface`).
- **Look**: the existing quiet panel, 6-14 visible lines, resizable by dragging its top edge, fading
  to 25 % opacity after 8 s without news and back on a new line or on hover; the input line is the
  same bronze frame, with the channel's prefix (`Say:`, `/` for commands).
- **Input**: Enter opens, Enter sends, Escape cancels (and a second Escape does nothing else: the
  chat consumes it). Up/Down walk the last 50 lines (kept per character). Tab completes the command
  name and, for the arguments the command declares, item, skill, zone, creature and place names
  (a second Tab cycles; the candidates show above the line).
- **Focus**: while the input is open the window takes the keyboard. One shared flag,
  `typing` (a `uiFocus` helper that also covers every existing `INPUT`), is checked by
  `player/input.ts`, the action bar, the panel keys, Tab targeting, `E`, `M`, `T`, `O`, `F2` and
  Escape handling. Movement keys held when it opens are released.
- **Text** goes through `renderText` with the client's language table; typed words are shown raw.
- **Sounds**: a soft tick when a line arrives in say or whisper, none for combat; nothing new is
  needed in FEEDBACK.md's cues beyond `chat-message` and `chat-whisper`, which are optional.

## Where combat and system lines come from

- `describeEvent` (combat) and the level-up, learn and refusal lines (`session.ts` ~680-820) call
  `chat.combat` / `chat.system`; strings turn into template + args so they translate.
- Refusals such as "That cannot be done." keep their text and go to `system`, in a colour that
  stands out, and also stay on the floating text where they do today.

## Probe

`scripts/probe/chat.mjs`, headless against the real server (`createServer`, as `quests.mjs` does):

- parser: quoting, aliases, prefixes, bad numbers, unknown names, too-long text, control characters;
- permissions: a server with `devCommands` off refuses every `dev` command with the right reply and
  changes nothing; on, `/give`, `/level`, `/xp`, `/heal`, `/kill`, `/tp`, `/spawn`, `/learn` do
  what they say (checked on items, progress, resources, position, entities);
- say reaches players in range and not those out of it; sanitising and rate limit;
- `/help` lists only what the sender may use; replies go to the sender only;
- `npm run server` starts with dev commands off, `--dev` turns them on.

## Steps

Each leaves the game working; check in the running game (`?play`) and with the probe.

1. **Boundary and registry.** `chat` and `chatEvent` messages (protocol 14), the registry, parser,
   sanitising, `/say`, `/help`, the `devCommands` flag in the world config and Welcome, and the
   server's refusal. Probe.
2. **Window.** `chatWindow.ts` with the old log content in `combat`/`system` channels, tabs,
   filters, scroll, fade; input line with history; focus flag and the key handlers; say and replies
   shown. Combat lines unchanged to the eye.
3. **Dev commands on the server:** `/give /level /xp /heal /kill /revive /tp /spawn /learn`; argument
   completion for item, skill, zone, place.
4. **Client commands and `/world`:** `/clear /time /weather /reveal /world`.
5. **Pack metadata and text:** commands in `public/packs/core/commands`, usage and summaries as
   templates; macros; content-error checks.
6. **Docs:** GAMEPLAY.md (Multiplayer, Interface), SIMULATION.md (boundary), FRONTEND.md
   (interface layout), FEEDBACK.md (cues), this file's *As built*.

## Not in this step

Parties, whispers, guilds and mail (the channels and the message exist; the recipients are the
server's later work); a network transport; moving the F2 debug panel onto commands and gating the
old `debug*` intents; voice chat; emotes (`/dance`) and chat bubbles over heads (NPC barks already
have one to copy); mod-defined channels; a profanity filter.

## Open points

- `/reveal` does nothing until the map has fog; keep it as a stub or leave it out?
- Should the old `debug*` messages follow the `devCommands` flag as soon as step 3 is done? (The
  user chose to leave them, so the plan does.)

## As built

Protocol 14. Everything in the plan is in, with these differences:

- **Files.** `src/sim/chat/chat.ts` (cleaning, words, argument kinds, registry, completion, rate limit),
  `serverCommands.ts` (core commands, the name books), `commandPacks.ts` (reads `commands/`);
  `src/ui/chatWindow.ts` (the window); `src/game/chatCommands.ts` (client-owned commands and the
  router); `scripts/probe/chat.mjs` (the probe).
- **Who owns what.** Server: /say /world /give /level /xp /heal /kill /revive /tp /spawn /learn.
  Client: /help /clear /time /weather /reveal. /world is the server's, so it can be asked of a
  dedicated server's world as is. The server sends its list (`commandList`) once the player is in,
  with only the commands the player may use; the client reads "developer commands are on" from
  there (a Welcome of a selecting client reaches the front end, not the game), and also checks
  `devCommands` in `welcome` for hosts that want it.
- **The flag.** `ServerOptions.devCommands`: `connectLocal` sets it (single player); `npm run server`
  needs `--dev`. A world config entry for it is still to come. The old `debug*` intents are untouched.
- **Rate limit.** Only talking (say, `/say`) is limited, 5 lines per 3 s of server time; commands are
  not, so a macro or a test script can run several in a row.
- **Packs.** `commands/<id>.json5`: for a code command, how it reads (`usage`, `summary`, `aliases`,
  `dev`); with `run` (command lines, `$1`.. filled from `args`), a command made from others
  (`restore` ships as the example). A file for a command with neither is an error when the server
  starts. Usage and summary go through the text table like any template.
- **Window.** Tabs All / Combat / Chat (Combat holds combat and system, Chat holds say, system, party,
  whisper); wheel and PageUp/PageDown scroll; the top edge is a resize grip; the window fades to 40 %
  after 8 s. Tab, size and the last 50 lines typed are kept in the browser's `localStorage`, not in the
  character's saved interface. Per-tab filter editing is not built.
- **Keys.** The input stops its `keydown` before it reaches the window's game handlers, and the movement
  input forgets held keys when a text field takes focus. Enter outside a field opens it (not in the
  menu, a loading screen or the spectator camera); Escape closes only the chat.
- **Completion.** Tab completes command names and, by each argument's kind, items, skills, creatures,
  disciplines, zones, places and weathers; Tab again cycles; ambiguous results are listed above the
  line. Names with spaces are quoted. `/tp` takes coordinates, a place or a zone's middle.
- **Not done.** `/reveal` is a stub (no fog). The `chat-message` cue is the existing `uiClick` for now.
  `/spawn` makes creature kinds only, not any template.
