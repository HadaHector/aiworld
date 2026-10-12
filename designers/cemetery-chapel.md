# Cemetery and chapel: the panel's pitches, merged

Task: `designers/tasks/cemetery-chapel.md`. All five answered (run at effort xhigh, 2026-10-12).

## Where they agree (all five, or four of five)

- **Why it is out there**: it is a parish church for scattered farms, or what is left of a village
  that went. It is not placed for the view.
- **Siting**:
  - the highest gentle ground in the cell: a knoll or shelf, grade up to about 0.12;
  - dry ground, never a bog;
  - 0.5–3 km from the settlement it serves, never inside one;
  - one dead-end track to it (links [1, 1]), no road passing through;
  - rare, about 1 cell in 10–20 where it fits.
- **Layout**:
  - the existing chapel stands on the top, its tower towards the gate;
  - a straight path runs from the gate to the tower door;
  - graves lie in rows parallel to the nave, heads west, ordered by age: oldest by the chapel,
    newest by the gate;
  - so walking up the path is walking back in time.
- **Boundary**:
  - a low wall, 0.9–1.4 m, so the graves show over it from the lane;
  - a lychgate (the gate prop with a roof and a bench) as the one built way in;
  - a broken gap at the back in worn yards.
  - Three of them (Priya, Doug, Marta) want the line-structure engine piece built before the other
    engine work for this feature.
- **Props**:
  - markers: headstone, wooden cross, flat slab, table tomb, grave mound;
  - an open grave with a spoil heap and a spade stuck upright;
  - a churchyard cross;
  - an ossuary or charnel house;
  - a sexton's hut;
  - a well by the gate.
- **Plague ground**: a long, low, unmarked mound outside the wall on the far side, its grass the
  wrong colour, with a single cross.
- **Condition**: kept, worn, abandoned or ruined. It drives the grass, the leaning markers, the
  wall's gaps, the roof, the bell and the light.
- **Night**:
  - one light only: an east-window lamp and/or a lantern at the gate;
  - lit only while the place is kept, and meaning the same thing on every seed;
  - the yard itself stays dark;
  - needs `litWindows` to pick a window by position, not a random share.
- **Enemies**: everyone independently chose **lead and grave robbers, not the undead**.
  - The dead stay put.
  - Robbers strip lead roofs, take the bell and the altar silver, and dig the rich graves.
  - They sleep in the nave, the charnel house or the vault, and come with a cart by the back way.
- **Warnings**, read from far to near:
  - cart ruts on a track meant for feet;
  - a wrong light (moving, low, or where none should be);
  - fresh yellow spoil;
  - a tomb lid shoved aside;
  - bare roof boards;
  - an empty belfry.
- **Reward**: it must be visible from outside (the lead roof, the bell, silver glinting). There is
  no inventory yet.
- **Cheaper first enemy**: wolves denning by the ossuary or the plague mound, warned of by bones at
  the door (Rafael, Doug, Marta).
- **Cut**: all five, unprompted: **blighted ground**. Fold its grey dead ground into the plague
  pit, and its broken altar and the "overgrown chapel" into the ruined condition.

## Each one's own idea

| Who | Idea | Fun | Cost | Notes |
|---|---|---|---|---|
| Doug | **Corpse road with resting stones**: a slab on two posts at hip height, at each crest or bend of the track, 3–6 of them. The track is pinned to the track class | 4 | 2 | Reuses the waysign's "at road" placement |
| Saga | **Graves that sink**: new graves are mounds, old ones are hollows with tipped slabs. Paint first, a pit stamp later | 4 | 1–2 | Hollows hold water in the rain |
| Saga | **Bell in the gale**: knocks only in strong gusts, with the lit window to steer by in a whiteout | 4 | 2–3 | Needs sound, which does not exist yet |
| Marta | **One cross generator**: a plank cross with a little shingled roof, a carved trade panel, lean, paint and wear. It also makes wayside crosses | 3 | 1 | Cheapest high-yield prop |
| Marta | **Six histories**: parish, plague votive chapel, lost parish (her favourite), battlefield dead, a family's, a hermit's | – | – | Each brings something to find |
| Marta | **North side railed, not walled**: the outsiders (the unbaptised, suicides) lie beyond it, with hawthorn stakes. The gap there is the robbers' way in | 4 | 3 | Folk fear as the only "magic" |
| Rafael | **The ground keeps its books**: graves reused after about 40 years, old stones stacked against the wall, bones to the ossuary | 4 | 2 | Trade emblems on the markers |
| Rafael | **Whitewash clock**: an Iberian ermida with a bell gable, limewash greying by years since kept. A lime-crust plague strip | 4 | 1 | Southern variant; cypress and holm oak, no yews |
| Priya | **Rows point at the tower**: the slope always leads down to the gate, so you can get lost but stay safe | 4 | 3 | Wayfinding by layout |
| Priya | **Lantern out**: 1 in 4 has no gate light, so you can see that you are lost. Snow-capped stones look like a crowd that never moves | 4 | 1 | Teaches "a moving light is a person" |

## Variants by biome

| Biome | Look |
|---|---|
| Autumn and bluebell wood | Rubble chapel, yews, shingled lychgate |
| Maquis and sage hills | Whitewashed chapel, bell gable instead of a tower, cypress row, limestone |
| Heather moor and fell | Drystone wall, gritstone, juniper |
| Snowy taiga | Log chapel, stockade, wooden stakes |
| Frost steppe | Cairn yard, no wall, a turf-roofed stone chapel |

## Disagreements

- **Yew**:
  - Priya and Doug want it, as a new ancient tree kind;
  - Saga says one feature doesn't earn a tree kind;
  - Rafael says yews belong in the woods, with cypress in the south.
- **Graves as props or paint**:
  - everyone warns about 60–150 markers;
  - instance the shapes, paint the far ones as ground marks (Rafael, Doug, Marta);
  - or merge each plot into one mesh (Saga).
- **Mausoleum**: Doug would skip it (a table tomb does the job); the others keep it for the rich
  variant only.

## Marta's cheapest first cut

1. The chapel, with one lamp chosen by position.
2. Two generators: the cross and the headstone.
3. Plots painted on the ground, with no pads.
4. A lychgate: the gate prop with a roof.
5. A plague mound: the heap generator stretched long.
6. One open grave: a pit, a spoil heap and a spade.
7. A boundary made of one segment type.
