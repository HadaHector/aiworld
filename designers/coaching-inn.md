# The coaching inn: the panel's follow-up

What the design panel (Marta, Rafael, Saga, Doug, Priya) answered when asked for the smithy, more
props, and inn names, merged. What is built is marked **(built)**.

## The smithy

All five want one on some inns, not every one, and all five want it walked into. They agree on:

- **The building**: one low room, about 6-8 m across and 4.5-6.5 m deep, rubble walls to about
  3.8 m at the eaves, its roof the biome's own (Doug: stone slate in the north, not clay). One
  side open - a wide bay about 3 m across where the barn door is hung back by day, pulled to at
  night with a bar of light under it. Rafael and Marta put the open side to the yard, so sparks and
  noise stay off the road; Doug and Priya to the road, so travellers see the forge.
- **The forge**: a stone or clay hearth against the back wall, about 1.4 m wide and 0.9-1.1 m
  high, under a hood narrowing into the chimney.
- **The bellows**: leather on a timber frame beside the hearth, worked by a lever.
- **The anvil**: on an oak or elm stump 0.6-0.8 m high, out in front of the hearth near the open
  side, where the light falls on it.
- **The quench trough**: an oak tub with iron hoops or a stone trough, about 1.0-1.2 m long, by
  the hearth or just outside the bay.
- **Shoeing**: outside the room, in a lean-to off one side, open on two sides, with a ring post
  for the horse and a shoeing frame or block. Nobody wants a horse inside the forge.
- **At night**: the forge is the brightest thing on the road. It throws an orange wedge 3-5 m out
  of the open side, and sparks rise from the chimney. Its glow is a `flame`-like glow on the
  hearth. Saga and Priya add the anvil's ring as sound, which is not built yet.
- **Lying about**: a coal or charcoal sack, iron bar stock in a rack, a heap of horseshoes, tongs
  and hammers on a rack (the existing toolRack), a leather apron on a peg, a wagon tyre on the
  floor.

What it needs: a `smithy` room type (none exists), an `interior` block on `smithy.json5`, an open
side to the building, and the props below.

## Props

Shared ones (marked by the panel as serving farms, towns or the camp) first.

**Outdoor** - in the yard, by the buildings, along the road:

- **Well (built)**: a stone curb about 1 m high, a windlass on two posts, a bucket on its rope,
  sometimes a roof. Marta: now and then a second one boarded over, its lid nailed shut.
- **Trough (built)**: stone or oak, about 2 m long, water near its brim, by the stable.
- **Dung heap (built)**: a dark mound behind the stable, with straw through it. Rafael and
  Marta want a fork stuck in it.
- **Wayside sign (built)**: a post about 3 m high, a board about 1.2 m wide on an arm. The emblem
  is painted big, so those who cannot read know it.
- **Mounting block**: two or three stone steps by the coach door. Doug would rather the trough
  did the job.
- **Hitching rail**: a rail on two posts with iron rings, by the trough or the taproom.
- **Cart**: two-wheeled, its shafts down. Wanted by four of five; it also serves farms and the camp.
- **Milestone**: a squat stone post carved with the towns. Doug and Saga.
- **Snow poles** (Saga): a slim black-topped pole every 40 m along roads in the snow. In a
  blizzard they are the road.
- **Hen coop, straw bales, water butt, laundry line, dog kennel**: lived-in clutter, for farms too.
- **Fingerpost, shrine niche (St Christopher), gibbet post, toll bar**: one each, all road pieces.

**Indoor**, per room:

- **Taproom**: a settle (a high-backed bench by the hearth, wanted by all five), a tally board
  or tally sticks by the bar, a shelf of pewter, a dog basket by the fire, a cask on a stand.
- **Kitchen**: a spit on fire-dogs, a pot crane, a dresser, a kneading trough, onion strings and a
  flitch of bacon from the beams, a flour bin.
- **Guest room**: a washstand with ewer and basin (all five), a chamber pot under the bed, a cloak
  on a peg rail, boots by the door, a candle stand.
- **Cellar**: a cask on a cradle with a tap (the cellar's landmark), a cheese shelf, stone crocks.
- **Store**: a steelyard hanging from a beam, sacks on a hook bench, an oat bin.
- **Stair and gallery**: a lantern on the newel, boots by the guest doors, a boot scraper.
- **Stable**: a manger and hay rack, harness on pegs, a saddle on a trestle, a pitchfork.
- **Smithy**: as above.

## Names

All five separate the **sign** (a picture, read by everyone) from the **name** (the words). The
built generator (`names` in `features/coachingInn.json5`, see `FeatureNaming`) takes their common
ground **(built)**:

- **The <Colour> <Sign>**: the most common shape. The Red Hart, The Grey Ram.
- **The <Sign>**, and **The <Sign> at the <Place>**: The Hart at the Ford.
- **The <Quality> <Sign>**: the voice's own adjectives. The Pale Swan, The Starving Wolf.
- **<Keeper>'s Rest**: the keeper's name in the voice's sounds.
- **The Halfway <Sign>**, and whole signs that take no colour: The Cross Keys, The Three
  Horseshoes.
- **Signs by voice**: a sand-sea inn never has a hart (Marta's lists). Arid: camel, jackal,
  palm; frozen: bear, elk, wolf; murky: heron, pike, eel; stony: anvil, goat, eagle; shaded: owl,
  boar, stag.

Not built yet:

- **The place word from the road itself** (Rafael, Marta): "at the Ford" only where the road
  crosses a river, "at the Pass" only where it climbs.
- **A saint's name** where a shrine stands near (Marta, Priya).
- **One in twenty a flavour name** (Rafael, Saga): The Lamp That Stays Lit.
- **The emblem on the sign matching the name's beast or thing.**
