# How the work is run

How development sessions, worktrees, checks, browsers and merges are organised (agreed with the owner,
2026-11-25). The main session (the one the owner talks to) coordinates; side sessions do the work.

## Sessions

- **A small standing team.** A handful of thematic sessions, each like an employee with a field of their
  own (the lanes below), **never more than 7 sessions in all**. New work goes to the team member whose
  field it is; a new session only for a field nobody covers, and only within the 7.
- **At most 3 of them working at a time.** More work waits in a queue until one finishes and is merged.
- **One lane each.** A lane is an area with its own files (world shaping, features, dungeons, gameplay
  and rules, UI and front end, art and assets). Two running sessions never own the same files; a brief
  names the files it owns and the ones it must not touch.
- **Reuse sessions aggressively.** Re-reading the code costs a lot, so work goes to the session that
  already knows the area, even when its context is long (it compacts by itself): one standing session
  per lane, sent the next task with a message. A new session only for a lane nobody has worked in, or
  when the old one is clearly lost.
- **The team's fields** (one standing session each, on Opus, started fresh when the field first gets
  work; it keeps its worktree and brings master into its branch before each new task): features and
  compounds; feature placement and cells; dungeons, caves and the mine; terrain, water and coast;
  gameplay, combat and the HUD; rules and balance; tools (workbench, probes, debug map).
- **The sessions from before this workflow are retired** (they are stuck on Sonnet): each finishes the
  task it has, then gets no more; its field goes to a new session.
- **Models.** Design and code: Opus. Mechanical or read-only work: Sonnet.
- **No ending a turn to wait.** A session that waits for a long probe or a generation run waits inside a
  background command that wakes it when it ends. It reports once, with the result.

## Worktrees and branches

- Every code session works in its own git worktree and branch (`.claude/worktrees/<name>`), cut from
  master, and commits only its own files there. It never pushes.
- When the main session merges a branch, it removes the worktree and deletes the branch. Before
  `git worktree remove`, the `node_modules` junction inside it is unlinked with `rmdir` (a plain
  `worktree remove` follows the junction and deletes the real `node_modules`).

## Checks

- **Probes run by category**, and the categories are the team's fields: `npm run probes -- <field> [...]`
  (`npm run probes -- --list` shows them: features, placement, dungeons, terrain-water, gameplay, rules, art).
- **A session runs:** the typecheck (`npx tsc --noEmit -p .`) and its own field's probes
  (`npm run probes -- dungeons`; a single one with `npm run probe -- scripts/probe/<x>.mjs`), headless.
- **The main session runs:** after merging a batch, the probes of the merged branches' fields on master
  (`npm run probes -- rules gameplay`), or `npm run probes -- all` (about 3.5 minutes) when a batch touches many.
- **One heavy probe run at a time.** `npm run probes` takes a lock (`aiworld-probe-quick.lock` in the
  system temp folder, shared by every worktree); a second run waits for the first. Long single probes (the full dungeons run, bots) are not run while another heavy
  run is going.
- Full mode (`--full`, `PROBE_FULL=1`) on request only.

## Browsers and dev servers

- **Headless by default.** Sessions look at things with `npm run shot` and probes, not the browser.
- **Port 5173 is the owner's** dev server, served from the main checkout (it hot-reloads, so merges
  show there).
- **Port 5174 is for in-game checks by sessions, one at a time.** A session that needs the game asks the
  main session for 5174, uses it briefly, closes what it opened and stops the server, then tells the main
  session it is free. The main session hands it to the next one.
- No session starts any other dev server.

## Merging and pushing

- Only the main session merges, in batches: merge, typecheck, the merged fields' probes on master.
- **When that is green, master is pushed** straight away. When it is not, the branch's session fixes it
  first.

## Docs and progress

- Sessions update the docs of what they build (FEATURES.md, DUNGEONS.md, ...). They do not edit
  `SLICE.md` or the progress page.
- The main session keeps `SLICE.md` (plan, progress log) and the progress page up to date after each
  merge or each thing the owner has seen.

## The GPU

- ComfyUI work (concept images, icons) only in windows the owner opens. A run is prepared first
  (prompts, lists) without the GPU, so a window is one command and a review.
- Tip: allowing `python icongen.py` and `python concept.py` in the permission settings keeps a run from
  stopping halfway on a permission prompt (the owner's call).
