# Music

The plan for procedural music. Every piece is composed from the seed. There are no pre-made phrases
stitched together: melodies, harmony, arrangement and performance are generated, and only the
*sounds* (samples and synth voices) are authored. The music is built and tuned on its own page
first and is tied to the game later.

## Principles

- **Composed, not assembled.** Styles are rulesets: which modes, how chords move, how melodies
  behave, which instruments play which roles. No hand-written bars.
- **Tracker semantics, modern mixing.** Playback follows the XM model: instruments made of several
  samples spread across the keyboard, volume and panning envelopes, forward and ping-pong loops,
  finetune, auto-vibrato, a volume column and effect commands. On top of that come things XM never
  had: reverb and delay sends, a filter per channel, and no channel limit. We play the music
  ourselves in WebAudio. There is no .xm file in or out.
- **Repetition makes it music.** A song is built from a short motif that comes back and is
  developed. Random notes over chords are not a melody.
- **Places have themes.** A place's seed fixes its motif and mode, so a village is recognisable
  when you come back. The arrangement may differ on each visit.
- **Data in packs.** Instruments and styles are pack content (json5) like everything else. Samples
  sit next to them.
- **No voices singing words.** The most vocal sound is a choir pad: looped "ooo" and "aaa"
  samples, with a crossfade between them for a slow vowel swell.
- **Effects are part of the style.** Much of what made tracker music sound alive was how the effect
  column was used: grace notes, slides, arpeggio chords, echoes. Each style says how it uses them.

## Layers

```
Director   world state → style and mood; when music plays; transitions        (later: game only)
Composer   seed + style + mood → song: order list, patterns, instrument refs   (pure, no audio)
Player     song → sound: rows, ticks, effects, envelopes, sends in WebAudio
```

- The **Composer** is pure and deterministic, using `src/world/rng.ts` (`mulberry32`, `deriveSeed`).
  It runs anywhere: in the music page, in the game, and in `npm run probe`, which prints patterns as
  text.
- The **Player** knows nothing about music theory. It plays patterns exactly as written.
- The **Director** is the only part that knows about the world. It comes last.
- Songs are composed **one pattern ahead** of playback, so a change of mood or style takes effect at
  the next pattern boundary without restarting the song.

## Song model

This is the Composer's output and the Player's input, close to a tracker module:

- **Song:** tempo (BPM), ticks per row, rows per beat, swing, an order list of pattern ids, the
  instruments used, and mix settings (reverb and delay character).
- **Pattern:** rows × channels. Each cell holds an optional note (or note-off), an instrument, a
  volume-column value and up to two effects.
- **Channel:** carries a *role* (lead, counter, bass, pad, drone, percussion), a pan position and
  its sends, so the page can show what each channel is for.
- **Effects** follow the XM set by meaning, not by byte format: arpeggio, portamento up and down,
  tone portamento, vibrato, tremolo, volume slide, panning slide, note delay, note cut, retrigger,
  fine slides, plus ours: filter cutoff slide and send level.

## Instruments

Instruments are pack content in `packs/<pack>/instruments/*.json5`, with samples in
`packs/<pack>/samples/`.

```json5
{
  // A fiddle: bowed, with a slow vibrato that comes in after the attack.
  samples: [
    { file: "fiddle_G3.wav", root: "G3", keys: ["C3", "B3"], loop: [1200, 5400], loopMode: "pingpong" },
    { file: "fiddle_D4.wav", root: "D4", keys: ["C4", "G4"], loop: [980, 4700], loopMode: "pingpong" },
  ],
  volumeEnvelope: { points: [[0, 0], [3, 64], [20, 48], [40, 0]], sustain: 2 },
  autoVibrato: { depth: 3, rate: 6, sweep: 12 },
  filter: { type: "lowpass", cutoff: 4000 },
  sends: { reverb: 0.3 },
  roles: ["lead", "counter"],   // what the arranger may give it
  range: ["G3", "E6"],          // where it sounds natural; the arranger stays inside
}
```

- **Synth voices** are instruments too, with a `synth` block in place of `samples`: Karplus-Strong
  pluck, FM bell or organ, noise percussion, and simple oscillator pads. They let everything be
  built before any samples exist, and later they fill gaps between sampled instruments.
- The pack index (`scripts/packIndex.mjs`) lists only `.json5` files today. It will need to list
  sample files as well, and editing a sample reloads the page like any other pack file.

### Sample format

This is what to collect:

- WAV, 44.1 kHz, 16-bit, mono.
- **Pitched instruments:** one recording every 4–6 semitones across the range they will play.
  Shifting further than that sounds artificial. Two velocities is a bonus, not required.
- **Sustained instruments** (strings, choir, organ, whistles, pads): clean loop points, or enough
  steady sustain to find them.
- **Percussion:** one-shots, with a few takes per hit so repeated hits are not identical.
- The **root note in the file name**, e.g. `flute_A4.wav`.
- **Licence:** CC0 or similar, recorded next to the samples. Starting points: VSCO 2 Community
  Edition (CC0), Sonatina Symphonic Orchestra, Philharmonia samples, FreePats.

## Styles

A style is the authored ruleset, in `packs/<pack>/musicStyles/*.json5`:

| Part | What it decides |
|---|---|
| Pitch | Which modes it uses and how likely each is; a drone or not |
| Harmony | Weighted chord moves per mode (a modal vamp vs. I–IV–V–I), how fast chords change, cadences |
| Time | Meter, tempo range, swing, ticks per row |
| Form | Section grammar (e.g. `intro A A' B A' outro`), phrase lengths, song length |
| Melody | Steps vs. leaps, range, ornament density, call and response, which motif variations it uses |
| Rhythm | Rhythm templates per role |
| Effect idioms | How the style uses effects (examples below) |
| Orchestration | Which instruments may fill each role; how many play at each energy level |
| Mix | Reverb size, delay, overall brightness |

Effect idioms, by example:

- **Folk:** grace notes from note delay plus a quick slide, drones, fiddle vibrato.
- **Chiptune:** chords from arpeggio, pitch bends at the end of notes.
- **Ambient:** slow tone portamento, long volume swells, retriggered bell echoes.
- **Sacred:** choir and organ pads, slow chord changes, plenty of reverb.

## Composer pipeline

For each song, seeded:

1. **Parameters:** mode, root, tempo and meter drawn from the style's ranges, nudged by mood.
2. **Form:** the sections and their lengths.
3. **Harmony:** a progression for each section, with B contrasting with A and phrases ending in
   cadences.
4. **Motif:** a 1–2 bar cell of rhythm and contour. This is the song's identity.
5. **Melody:** phrases built from the motif (repeated, transposed, inverted, rhythm changed,
   answered) and fitted to the chords, inside the lead instrument's range.
6. **Arrangement:** bass, pad or drone, counter-melody and percussion, each from its role's rules,
   with the number of layers set by energy.
7. **Performance:** velocity shaping, accents, timing nudges on the tick grid, and the style's
   effect idioms.
8. **Patterns:** written out in the song model, one pattern ahead.

The seed is split so that parts can change independently. The place seed fixes the motif and mode.
A visit seed varies the arrangement and performance.

## Music page

`music.html` is a separate page next to `workbench.html` and `collision.html`, with no 3D. The
workbench is a Babylon stage built around one asset at a time, and the music page needs a different
layout. It loads the same packs.

- **Controls:** style, seed (place and visit separately), mood and energy sliders, tempo override,
  play, stop, loop pattern, and step through rows.
- **Pattern view:** a tracker grid of rows × channels, with the playing row highlighted. Each cell
  shows note, instrument, volume and effects. Channels are labelled by role.
- **Piano roll:** the same song shown as notes over time, coloured by channel. Phrases and motif
  repeats are easier to see here than in the grid.
- **Song overview:** form sections, chord per bar and where the motif occurs.
- **Instrument panel:** every instrument in the packs. Each one has a keyboard to audition it across
  its range, which sample answers each key, a drawing of its envelopes, its loop points, and a
  waveform of the sample.
- **Mixer:** mute or solo each channel, and see send levels.
- **Determinism check:** the same seed and settings always give the same song. The page can show a
  hash of the generated patterns.

## Director (later)

This is how the world will drive the music once the music stands on its own.

- **Zone family and variant** choose the style, plus palette tweaks per variant.
- **Features** (churchyard, inn, road) can override the style or add a layer, e.g. a choir pad in
  the churchyard.
- **Time of day and weather** change energy and density, and can darken the mode.
- **Transitions** happen at pattern boundaries: channels drop out or come in, the music crossfades,
  or a short fill bridges the change.

## Where it stands

First pass (milestones 1 and 2 in rough form): `music.html` composes, plays and shows a song in
the forest style using synth stand-ins.

- Code is in `src/music/`: `theory.ts`, `song.ts` (the model), `instruments.ts` (synths rendered to
  sample zones), `player.ts`, `styles.ts`, `composer.ts` and `format.ts`. The page is in
  `src/musicPage/`.
- `npm run probe -- scripts/tools/music.mjs [place] [visit] [patterns]` prints a song as tracker
  text, without audio.
- **Styles:**
  - **Forest:** medieval ambient.
  - **Glade:** mysterious, magical nature. Mostly Lydian, slow and built over a drone. A choir pad
    breathes (it swells and fades back every bar), harp arpeggios sweep up, and a flute comes and
    goes with bird-like trills. Bells sparkle high up, echoing away through retriggers. There is
    hardly any percussion.
  - **Desert:** Arabic, after Aladdin, Dune and Diablo II's second act.
    - Hijaz and double harmonic over a drone, with bII–I cadences.
    - An oud ostinato.
    - A ney that slides into its notes and wavers.
    - Darbuka on maqsum, baladi and saidi, with riq and deep drums.
    - Now and then, a distant voice wails into a long note.
  - **Snow:** slow, symphonic ambient.
    - A horn sings over a wide string pad and a contrabass.
    - Harp arpeggios fall slowly and a glockenspiel glints like snowflakes.
    - A distant choir rises in, and timpani roll into the big sections.
    - Pieces run 3–4 minutes, and the form travels instead of just repeating A and B.
  - **Swamp:** dark and spooky, often a slow 3/4 waltz.
    - A bass clarinet creeps in Phrygian and harmonic minor.
    - A slightly out-of-tune music box plays a broken waltz.
    - A humming choir sits between low strings that tremble.
    - A heartbeat drum, and log and wood-block knocks off the beat.
    - Water drips in the high register.
    - A ghost (a theremin-like voice) slides up out of the murk. At the climax it doubles the
      melody an octave above.
    - The climax rises only a semitone.
    - Sliding notes:
      - About a third of the lead phrases glide from note to note where they join, like a
        musical saw.
      - Long notes often sag half a semitone flat as they fade.
      - In the last outro the music box runs down, each note later and sinking.
    - About a third of the phrases go to a violin, an octave above the clarinet.
  - **Wind** (`wind` in a style; snow and swamp use it): a synth voice of noise through a resonant
    band, on its own channel, only now and then: about a fifth of the time, in 2–3 passages of a few bars
    per piece. Each passage rises out of silence, slides to a new pitch every bar (the howl) and
    gusts, then dies away and is let go. It stays in its key through a climax. The archive has no wind
    recordings, so it is synth only; the Wind card can borrow from the atmosphere files.
  - **Tavern:** an upbeat session.
    - Jigs in 6/8, sometimes slip jigs in 9/8. Beats are in threes, so this style uses six rows
      per beat.
    - A fiddle lead; about a third of the themes go to a whistle instead.
    - An accordion pumping the chords (a new musette synth), and a guitar vamping.
    - The bass strikes every beat, root and fifth in turn (`bassBeats`).
    - Bodhrán triplet drives and tambourine.
    - The form goes round like a session set: A A B B, ornamented the second time, and the last
      round jumps up a key.
    - Breaths: rests inside the tune, the lead laying out a phrase now and then, and one drum
      break (Br), where only the drums, bass and accordion play.
    - The crowd claps on the beats in about half the full sections, a little ragged (`claps`;
      synth claps, or library hand claps). Shouts were tried and dropped: the archive's voice
      shouts were too rough, and the synth ones no better.
  - **Holy:** churches and temples, choirs and strings, no organ or bells.
    - Church modes at 44–58 bpm, in a big, wet space (`reverb` multiplies every send).
    - The choir sings in parts as a chorale (a `chorale` pad texture): the melody, which for some
      themes is a horn inside the choir, plus three voices singing with it note for note, each
      on a chord tone below the voice above.
    - Bare fifths of held voices open it and breathe in it, with suspensions everywhere.
    - A soft harp, another voice rising in, and the theme returning in a new key with the choir
      doubling it. No drums.
    - The lead sits around `leadCenter` (its tonic within a tritone of F4), so it is a soprano.
  - **Epic:** cinematic outdoors, like a film score.
    - Low spiccato strings (a new short-bowed instrument) drive an ostinato: eighths on a pedal,
      or a gallop. Above them, a wide, swelling string pad.
    - A heroic horn leads; the violins take some themes.
    - Big taiko drums (a new synth) and timpani roll into the climaxes.
    - A choir rises in, then doubles the theme when it returns in a new key.
    - A glint of glockenspiel and a little wind.
    - Film harmony: i VI III VII and its kin, at 72–92 bpm.
  - **Jungle:** humid and teeming, in 12/8 (six rows a beat).
    - A marimba (new synth) plays interlocking two-against-three figures; a low marimba strikes
      every beat.
    - Log drum and wood block on the 12/8 bell pattern, shakers on the eighths.
    - A breathy bamboo flute leads (the marimba takes some themes), with far-off flute calls.
    - Birds chirp high up (new synth), and a soft choir hangs underneath like mist.
  - **Nordic:** mountains, an older and darker cousin of epic.
    - A fiddle (sometimes a lur-like horn) over a deep men's choir chanting on bare-fifth drones.
    - A big frame drum beats a ritual, and a kantele-like harp rings.
    - Kulning calls slide down from far off, with wind.
    - Now and then a polska in 3/4.
  - **Savanna:** call and response (`answer`). A lead voice (a man's, or a kalimba for some
    themes) sings each theme, and the group choir answers it in the second phrase (A', B').
    Under them, a balafon on the 3-3-2 tresillo, a bass marimba on every beat, djembe-style drums
    and shekere, with birds and a warm wind.
  - **Mediterranean:** scrubland by the sea, warm and sunny.
    - A mandolin sings; an accordion or a clarinet takes some themes.
    - A nylon guitar strums a waltz (or a light rumba on the 3-3-2), the accordion holds the
      chords softly, and the bass plays on the beats.
    - Castanets (new synth) click with a tambourine.
    - Minor keys walk the Andalusian way down (i VII VI V), with a touch of Hijaz.
  - **Highlands:** a lonely Celtic air on an open moor, often in a slow 3/4.
    - A whistle (a fiddle for some themes) with cuts, slides and trills, resting now and then.
    - Pipes (a new bagpipe-like drone) on bare fifths above low strings, over a drone bass, with a
      Celtic harp.
    - A bodhran only when it fills out, and wind across the heather.
  - **Several alternate leads:** `leadAlternate` can be a list, chosen with one draw per theme.
    The tavern now hands themes to the whistle (30%) or a guitar an octave down (25%).
  - **Sections beyond the A and B themes**, for any style that lists them in its forms:
    - **C:** a third theme on a motif of its own, starting away from the home chord.
    - **D:** a development, carrying the motif down a chain of chords.
    - **Br:** a breath, where only the harmony plays.
    - **"+" (e.g. `Ar+`):** turns a section into a climax. It moves into a new key, the pad gets
      fuller, the lead louder, and the choir doubles the melody an octave below.
  - **The pad as three parts** (`pad` in a style; all four styles use it):
    - **Voices that move on their own:**
      - A voice may hold its note into the next chord and step down a beat or two late (a
        suspension).
      - Fresh entries come in one by one, and chord changes are sometimes staggered.
      - A voice moving by a third may walk through the note in between.
      - Each voice swells and fades on its own cycle.
    - **Textures by section:** sustain, open (bare fifths and octaves), wide (spread an octave
      either way), tremolo (bowed, a new XM-style `7` effect), or pizzicato (plucked, voices taking
      the beats in turn).
    - **Chord colour:** add9, sus2 and sus4, each only where the interval is right in the mode.
    - **An instrument per voice:** low strings, strings and high strings, each with its own synth
      and picker. The defaults for low (`lstrs01`) and high (`ostrs09`) are guesses, not yet picked
      by ear.
  - **Colour parts:** the sparkle (quick high runs) and the wail (a long voice rising in) are now
    separate parts, each on its own channel, so a style can have both.
  - Optional style knobs, all off unless a style sets them: lead rests, trills, pad breath, pluck
    register, sparkles or wails, a mix per part, cadence chords, slides, vibrato and
    percussion per section. (Tremolo picking, re-striking a pluck every two ticks, was tried
    and dropped: with these samples it stutters instead of shimmering.) A knob that is off draws nothing from the seed, so
    existing styles keep their songs.
- **Sample library.** `src/music/xi.ts` reads FastTracker 2 `.xi` instruments: keymapped
  samples, volume envelope with a sustain point, fadeout, auto-vibrato, and ping-pong loops (baked
  forward). Candidates from kiarchive.com sit in `public/samples/kiarchive/<role>/`, which is
  gitignored because their licence is a grey zone. `index.json` lists them by role and
  `SOURCES.txt` records where each one came from. On the music page, each instrument card has a
  picker to swap the synth for a library sound; the choice is kept per browser. The sounds picked
  by ear are the defaults, per style, in `src/music/sounds.ts`. `SHARED_SOUNDS` applies to every
  style, and `STYLE_SOUNDS` holds each style's own picks on top ("" keeps the synth, as for the
  jungle's birds and the nordic wind). A browser's own picks go on top of those.

  On a machine without the library, each instrument falls back to its synth.
- **Picks are kept per style.** The page stores `{ style: { instrument: file } }` in the
  `aiworld.music.soundsByStyle` localStorage entry. A style starts from the shared defaults.
  Picks made before this split became every style's starting point. Switching style rebuilds
  every instrument from that style's picks.
- **Drum kits.** A drum card also lets each stroke (dum and tek, shake and hit, boom) come from
  its own file, picked from any drum folder. That stroke's key then plays the file's sample as a
  one-shot, at the pitch it has on C-4. Instruments without a folder of their own also pick from a
  near one: ney from flute, oud from guitar, darbuka from frame drum. Choir sounds can
  be auditioned, but the forest style does not use a choir yet.
- Simplifications for now:
  - Styles and instruments live in code, not packs.
  - Envelopes are ADSR rather than point lists.
  - Loops are forward-only, with crossfades baked into the sample.
  - There is no delay send.
  - The patterns are the song in play order; there is no separate order list.

## Composed pieces

A style can carry a fixed `score` instead of rules. The composer then returns that song as written,
and it plays through the same player, with the same instruments, picks and playback.

**The main theme** (`src/music/themes/mainTheme.ts`) is written note for note: melodies, counter
melodies and horn calls are spelt out in a small notation (`"D5:6 A4:2 D5:4 E5:4 | ..."`, lengths
in sixteenths, checked bar by bar). The harp, string chords, bass, drums and choir follow its
chords by rules chosen section by section. It runs about 1:43 in D major at 96 bpm, aiming for
the classic OSRS kind of theme:

- **Intro:** strings swell in on a bare fifth under a rising harp, and a horn calls the head of
  the theme over D D C A.
- **A:** the theme on the flute over harp and soft strings.
- **A2:** the theme on the horn an octave down, a violin counter-melody above, soft drums.
- **B:** a contrasting violin theme in B minor with choir, the drums building, ending on B.
- **A3+:** the theme a whole step up in E, violin with the horn doubling below, choir, full drums,
  wide strings.
- **Outro:** a fanfare cadence onto a long E chord with a timpani roll.

There is no main menu yet; the theme is ready to play there once one exists.

## Playback

These are things the player does for every song, so they change how the same notes sound.

- **Louder is brighter.** Each note passes a gentle lowpass set by its volume: soft notes are
  darker, loud ones open up. A pitched note's cutoff stays well above its own pitch; drums go by
  loudness alone.
- **No identical repeats.** Each strike of a one-shot (drums, plucks) gets a few cents of detune,
  a little level and a start up to 4 ms into the sample. Looped sounds get only a slight detune.
- **Breathing tempo** (`rubato` per style, 0 to 1):
  - Each section broadens into its last bar.
  - The piece slows into its final chord.
  - A climax presses on slightly.
  - Dances keep near-strict time (0.1); the holy and snow styles breathe the most (1).
- **A room per style** (`room`): the reverb is a gap, early reflections off near walls (different
  for each ear), then a tail that darkens as it rings down. `seconds` is its length, `damping` how
  soft the walls are. For example, the tavern is a small soft room (1.2 s), the holy style a stone
  hall (5.5 s), and the swamp damp and dark (3.8 s, heavy damping).
- **An echo** (`echo` per style): a stereo ping-pong delay a dotted eighth long, each repeat a bit
  darker. It is sent mostly from the lead and the colour parts, with a little from pads and drums.

## In the game

`src/music/gameMusic.ts` plays music in the game, driven from `src/main.ts` every frame.

- **Where:** the zone's biome picks the style (`BIOME_STYLES` in `src/music/places.ts`).
  - Outdoors, a zone keeps its own theme (its place seed), varied on each visit.
  - Inside an inn, chapel or crypt (`BUILDING_STYLES`), the building's style plays instead:
    tavern, holy or swamp. Each piece inside is a new tune, not a variation. The world's
    `buildingAt(x, y, z)` says which building the player stands in.
- **When:**
  - Pieces play one at a time, with 25–60 s of silence between them outdoors and 4–10 s inside.
  - Through a door, the playing piece fades out in 1.5 s and the new place's music follows
    shortly after.
  - Crossing into a zone with another style lets the piece go after 4 s, so it does not flap
    at borders.
  - Audio starts with the first click or key press.
- **Sounds:** each style's picked samples (`src/music/sounds.ts`) are copied into the repository
  under `public/music/samples` (57 files, 26.7 MB, sources in its `SOURCES.txt`). They are fetched
  the first time a style needs them. Synths render lazily too: an instrument's zones are made the
  first time they are used.
- **Lairs (P7):** inside a dungeon (`dungeon.where`, from `dungeonPresence`) its own music
  (`DUNGEON_STYLES`): a cave plays `swamp`, a crypt the new `crypt` style (the swamp's dark at 42-56 bpm,
  choir pads, the lead often silent, few drums). In the boss's room the `lair` style plays (`BOSS_STYLE`):
  the swamp's modes at a march (88-108 bpm, violin and horn, taiko and timpani, drum rolls). Both
  borrow the swamp's sample picks. `npm run probe -- scripts/probe/ambience.mjs` composes them.
- **Ambience** is not music: see *Ambience* below.
- **Volume:** a small control in the bottom-right corner. The slider is eased, and clicking ♪
  mutes. It is remembered in `aiworld.music.volume`, and shows what plays or "silence".

## Ambience

The sound the place makes (SLICE.md P7): `src/audio/ambience.ts`. It plays on its own `ambient` bus
(`GameAudio.ambient`, beside the music and effects, under the same limiter and the underwater muffle)
at the player's own **Ambience** volume (options window, beside Music and Effects; kept in
`aiworld.ambience.volume`, default 70).

- **Recordings where there are some** (2026-11-26): `rules/ambience.json5` in the core pack maps a
  layer to its file or files (`public/packs/core/ambience/*.ogg`), with a gain, optional low- and
  high-pass, `covers` (other layers' synthesized voices it stands in for) and `quiets` (synthesized
  one-shots it turns down: birds, owls, caws, knocks). Read in `src/audio/ambienceRecordings.ts`
  beside the feedback rules. A layer with no file keeps its synthesized voice, and so does one whose
  file is still loading or failed to load: the game never waits on audio. A loop is decoded once, its
  last 1.5 s crossfaded (equal power) into its start so the loop has no seam, and started at a random
  point. `oneShots` are pools of takes, each played with a little pitch and level variation: `bird`,
  `owl`, `caw`, `knock` and `drip` replace the synthesized calls once they have a file, and any other
  name (thunder, a creak) is there for the game to play (`Ambience.oneShot`). None yet. A new
  recording for an existing layer or one-shot needs data only.
- **Layers now:**
  - **wind:** `wind.ogg` (gain 4).
  - **rain:** `rain.ogg` (gain 5.5, covers the synthesized drops).
  - **water:** `creek.ogg` (gain 5), for a river or a pond.
  - **surf:** `seashore.ogg` (gain 2), for the sea, heard from 90 m and full within 12 m. Without a
    surf file the water layer plays for the sea too, as before.
  - **forestDay** and **forestNight:** `forest.ogg` (gain 2.5, synthesized birds at 0.3 of their rate)
    and `forest_night.ogg` (gain 5, owls at 0.6), crossfaded by the hour as the birds and owl are.
    The wood's bed is hushed by rain, a gale and snow, scaled by how alive the biome is, and dulled
    through walls.
  - **Still synthesized:** the dry leaves (wind.ogg is wind only), the bird calls, the owl, and the
    crypt's room tone, drone and drips.
  - **roofRain:** rain on a roof indoors. It has no file yet; once it has one, it replaces the outdoor
    rain indoors.
- **Caves and mines** (the owner's call, 2026-11-26) have no bed and no drips. Their sound is a stone
  reverb on the effects (footsteps, blows): `GameAudio.echo`, a send from the effects bus into a
  2.4 s synthetic tail, opened to 0.35 with the underground share. A crypt keeps its drone, room tone
  and drips, and gets the reverb too.
- **Where:** `src/audio/ambienceMix.ts` is the pure part: `AmbienceState` in (wind and rain from the
  weather blend, the hour, how far underground the light is, the dungeon's kind, indoors, metres to
  the nearest river or pond and to the sea, how alive the biome is), layer levels out.
  `src/game/feedback.ts` fills the state each frame: the weather and the underground share from
  `world.weatherBlend()` and `world.undergroundShare()`; indoors, the biome and the water search,
  eight spokes out to 90 m, four times a second. The sea is water over ground at least 1.5 m under
  the sea's level; a river or a pond lies above it.
  - Birds by day (not in rain, a gale or snow), an owl at night; none indoors or underground.
  - Rain and wind stop underground (the light's own fade, so they fade out walking into a cave); indoors
    they are low-passed at 650 Hz and quieter, but rain on a roof stays. The recordings go through the
    same outdoor bus, so the low-pass, the underground fade and the underwater muffle apply to them.
  - Water is heard from 38 m, full within 4 m.
- **Loudness** (RMS, rendered offline: `node scripts/tools/ambienceLevels.mjs`, which serves this
  checkout itself on 5190-5197):

  | Place | Recorded | Synthesized |
  | --- | --- | --- |
  | wood by day | 0.023-0.025 | 0.020 |
  | night | 0.022 | 0.022 |
  | gale | 0.046 | 0.052 |
  | rain | 0.038 | 0.049 |
  | storm | 0.056 | 0.070 |
  | by the river | 0.031 | 0.030 |
  | on the shore | 0.037 | 0.027 |
  | indoors | 0.009 | 0.010 |
  | indoors in rain | 0.012 | 0.016 |
  | crypt | 0.058 | 0.058 |
  | cave | 0 (the reverb is on the effects) | 0 |

  Rain and storm are a little under the synthesized ones on purpose: rain.ogg's drops peak high, about
  0.8-0.9 in a storm.
- **Checks:** `npm run probe -- scripts/probe/ambience.mjs` checks the levels for the wood by day and
  night, rain, a gale, the river, the sea, indoors, a cave and a crypt, and composes the lair styles.
  It also reads the core pack's recordings and checks each file is there, and runs the ambience on a
  stand-in audio context to check that each layer plays its recording once loaded and its synthesized
  voice when its file will not load.
- **Listening:** `fx.html`, the *Ambience* tab: presets (the wood by day, dusk, night, rain, storm, by
  the river, on the shore, indoors, a cave, a crypt...) and sliders for every field of the state, with
  the levels they make shown. Each loop lists what it plays now and has a *rec* switch between its
  recording and its synthesized voice. Plays on the page's Volume (the Effects one); *Stop all*
  silences it.
- **Not done:**
  - **Data only:** cave drips for crypts, rain on a roof, bird calls, a bigger river (as another water
    file).
  - **Needs game code:** a campfire loop (a fire's distance in the state), mine creaks and distant
    thunder (one-shots with no scheduler yet).
  - **Otherwise:** no sound for snow, mist or the swamp's frogs, and nothing positional (the layers
    are the same everywhere around the player).

## Milestones

1. **Player and music page skeleton:** the song model, synth voices, a hand-written test pattern
   played with the full effect set, and the pattern view and mixer.
2. **Composer v1:** one style end to end (form, harmony, motif, melody, arrangement), with the
   piano roll and song overview.
3. **Sampled instruments:** the instrument pack format, sample loading, the instrument panel, and
   the first sample set.
4. **More styles:** each one tested on the page until it holds up over many seeds.
5. **Director:** hooks into zones and features, and pattern-boundary transitions in the game.

## Decisions

- **Intermittent, with soft edges.** Pieces play with silence and ambience in between. A piece
  never starts or stops abruptly: it fades in from a single layer (a pad or drone, or a lone
  instrument), the other layers join one at a time, and at the end they thin out the same way.
  This is part of the form: the intro and outro sections are written as gradual builds and
  thinnings, not cut on and off. The page can play a sequence of pieces with gaps between them, so
  the rhythm of music and silence can be heard and tuned there.
- **First style: medieval forest ambient.** Calm and simple: strings as a soft background pad, a
  flute lead, plucked guitar (lute-like) for arpeggios and counter-lines, and light medieval
  percussion (frame drum, tambourine, a soft low drum). Modal (Dorian, Aeolian, Mixolydian), slow
  to moderate tempo, slow chord changes, mostly stepwise melody with flute ornaments, sparse
  percussion that is often absent. Its instrument list doubles as the first sample shopping list:
  strings (sustained, looped), flute, guitar or lute, frame drum, tambourine, low drum.
- **No reactivity for now.** The Director is reduced to choosing a style and spacing the pieces.
  Mood, time of day and events can come later.
