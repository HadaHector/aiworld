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
- `npm run probe -- scripts/probe/music.mjs [place] [visit] [patterns]` prints a song as tracker
  text, without audio.
- **Styles:**
  - **Forest:** medieval ambient.
  - **Glade:** mysterious, magical nature. Mostly Lydian, slow and built over a drone. A choir pad
    breathes (it swells and fades back every bar), harp arpeggios sweep up, and a flute comes and
    goes with bird-like trills. Bells sparkle high up, echoing away through retriggers. There is
    hardly any percussion.
  - **Desert:** Arabic, after Aladdin, Dune and Diablo II's second act.
    - Hijaz and double harmonic over a drone, with bII–I cadences.
    - An oud ostinato with tremolo picking.
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
    register, sparkles or wails, a mix per part, cadence chords, slides, vibrato, tremolo
    picking, and percussion per section. A knob that is off draws nothing from the seed, so
    existing styles keep their songs.
- **Sample library.** `src/music/xi.ts` reads FastTracker 2 `.xi` instruments: keymapped
  samples, volume envelope with a sustain point, fadeout, auto-vibrato, and ping-pong loops (baked
  forward). Candidates from kiarchive.com sit in `public/samples/kiarchive/<role>/`, which is
  gitignored because their licence is a grey zone. `index.json` lists them by role and
  `SOURCES.txt` records where each one came from. On the music page, each instrument card has a
  picker to swap the synth for a library sound; the choice is kept per browser. The sounds picked
  by ear are the defaults (`DEFAULT_SOUNDS` in `src/musicPage/main.ts`):
  - guitar `nlgtr01f`, strings `ostrs03`, bass `cbass01`, flute `flute09`
  - frame drum `pandr02`, tambourine `tamb02`, low drum `tom008l`
  - choir `aahh02`, harp `plharp01`, bells `glock01`

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
