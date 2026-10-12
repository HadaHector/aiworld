# Task: a cemetery and its chapel

Read `designers/BRIEF.md` first, then this.

## What we want

A new feature (one per cell at most, like the quarry, the logging camp and the coaching inn): a
**cemetery with a chapel**, standing on its own out in the land, not inside a settlement. It is
meant to be the first feature that fits **enemies** later. There is no combat, no NPCs and no
enemies in the game yet, so design the place first and foremost as something good to walk into
today, but think about how it would hold enemies when they come: who or what they would be (keep
to the brief: mostly made by people, magic only a flavour), where they would wait or come from, how
the place warns the player before they walk in, and what would be there worth the risk.

## What already exists you can build on

- A **chapel** building (one tall room with an interior, see `public/packs/core/buildings/` and
  INTERIORS.md), which the generator can vary per biome style.
- **Compounds**: a feature is a yard with buildings round it, props placed by rules (in the yard,
  at its edge, by a building, in front of one, at a gate, along a road), lanes and trails out to
  the roads, levelled pads, trees cleared. A **gate** prop exists, but no fences or walls yet: a
  line-based structure (fence, wall, hedge) is planned and a cemetery may be the place it is
  needed most.
- **Lit windows** at night, per building; lanterns and fires inside.
- **Feature names** from voices, shown on the map and on signs as a tooltip.
- **Stumps that age with moss**, a **heap** generator (mounds), the weather and day/night.
- `FEATURES.md` already lists "Graveyard / necropolis" and "Old battlefield"; "overgrown chapel"
  and "blighted ground" appear in the biome table. Read those rows.

## Cover all of these, in your own voice and from your own angle

1. **The place**: layout of the cemetery and the chapel together. Where the chapel stands, how
   the graves are laid out (rows, clusters, family plots, by age), paths, the boundary and its
   way in, trees (yews?), what else belongs (a lychgate, a bell, an ossuary or charnel house, a
   sexton's hut or shed, a well, a cross, a mausoleum, open graves, a spade left in one...).
2. **Grave markers and props**: a list of the props it needs, each with how it looks (shape,
   size in metres, material, wear). Which ones are cheap generators that could be reused
   elsewhere.
3. **Variety**: how two cemeteries are told apart. Age (kept, neglected, abandoned, ruined), size,
   the biome and its culture, a rich family's tombs or a plague pit. What the generator rolls.
4. **Where it appears**: the siting rule (near roads or away from them, on a rise, how far from
   settlements, which biomes).
5. **Night and weather**: how it reads at dusk, at night, in mist. What light, if any.
6. **Enemies, later**: as above. Who, where they come from, the warning signs, the reward. What
   the place would need from the engine for that (spawn points, a lair, something to loot).
7. **Names**: name patterns and words for it, for the voices.

Use the brief's pitch format for the ideas you care about most; the numbered points above can be
answered in shorter prose where a full pitch is too much. Finish with **What I'd cut**, as always.
