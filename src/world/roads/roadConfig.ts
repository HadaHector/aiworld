// Pathfinding grid. Every road vertex lands on this lattice, which is what makes two links that
// run the same way share nodes exactly rather than nearly - see ROAD_REUSE_DISCOUNT.
//
// The single biggest cost knob in the whole feature: halving it quadruples the nodes searched, and
// each new node is a terrain sample. Measured over the whole network at detour 2.2: grid 25 built
// 256 links from 623k samples, grid 35 built 266 from 331k, grid 40 built 274 from 257k. Coarser
// builds MORE, because a wider step both hops narrow obstructions and measures grade over a longer
// run, so fewer steps trip the limit - which is also why it cannot go much coarser than this
// without the grade term quietly ceasing to mean anything.
export const ROAD_GRID = 35;

// Grade is the term that decides whether a road goes over a hill or around it. Below EASY it is
// nearly free; the square above it is what makes a steep climb lose to a long detour. MAX is a
// hard rejection: past it there is no road, whatever the detour would cost.
export const ROAD_EASY_GRADE = 0.08;
export const ROAD_MAX_GRADE = 0.35;
export const ROAD_GRADE_WEIGHT = 9;

// Below this the ground is beach or worse. Not a rejection on its own - a river crossing is below
// it by construction - but outside a river corridor it is.
// Raised off the waterline rather than set at it: the grid only samples every ROAD_GRID units, and
// the ground between two dry nodes can still dip. At 0.5 the finished roads reached -3.34 in
// places - visibly underwater. The margin costs a little coastal ground and buys a dry road.
export const ROAD_MIN_HEIGHT = 2.5;
export const ROAD_MAX_LAKE_FACTOR = 0.15;

// A road may cross a river, and pays per unit of length spent inside the channel.
//
// That one term is what produces near-perpendicular crossings, with no rule and without ever
// needing the river's direction: a crossing at angle t off perpendicular spends W/cos(t) inside the
// corridor, so minimising the length inside it IS minimising the angle. It trades against the
// detour needed to reach a square-on spot, which is the trade a road actually makes.
// Wide enough to contain the whole below-water part of a crossing, which is what makes it the
// right place to suspend the height floor. The bed reaches ~37 across with its edge jitter, and
// the bank climbs at RIVER_BANK_SLOPE from as low as -8, so it takes another ~34 units to get back
// above road level. At 45 the road was left standing in 3 units of water just outside the
// corridor - 546 points below the waterline, half of them within 200 of a river.
export const ROAD_RIVER_CORRIDOR = 75;
export const ROAD_RIVER_CROSSING_WEIGHT = 14;

// Inside the corridor the grade limit is suspended. River banks are cut at RIVER_BANK_SLOPE (0.25)
// - exactly ROAD_MAX_GRADE - so enforcing it would make every river in the world impassable. The
// crossing is the one place the terrain is expected to be reshaped for the road, which is stage 2.
// Until then a crossing is a steep dip, which is honest about what has not been built yet.

// Leaving the zones the link runs between is allowed but expensive. A cost rather than a ban
// because zones are concave: two settlements in one zone can have every straight route between them
// leave it, and a ban would make the link fail instead of detouring.
export const ROAD_OFF_ZONE_PENALTY = 5;

// Travelling on ground that already carries road. This is the whole crossroads mechanism: a new
// link merges onto an existing road wherever merging is genuinely cheaper, follows it while it is
// going the right way, and leaves where it is not - so junctions land at cost-chosen points and
// long links share a trunk, neither of which a "is there a road within N units" test can do.
export const ROAD_REUSE_DISCOUNT = 0.15;

// Search bounds. The ellipse is the real limiter - it confines the search to a corridor around the
// straight line - and the expansion cap is a backstop that currently never fires.
//
// The detour factor trades links against sensible routes. Measured: 1.6 left 57 links unroutable,
// 2.2 left 41, 3.0 left 34 - but 3.0 also produced a "road" 17948 units long between settlements
// under 5000 apart, which is worse than no road. 2.2 keeps the worst detour under 2x.
export const ROAD_MAX_DETOUR_FACTOR = 2.2;
// Only for a link that would otherwise leave part of the world unreachable by road. A route this
// indirect is a bad road, but a bad road is better than a settlement no road reaches at all - and
// because it is tried only after everything else has been built, it is also the one case where the
// route can lean almost entirely on roads that already exist.
export const ROAD_RESCUE_DETOUR_FACTOR = 4;

// A settlement should be reachable from its own zone, not only by a road arriving from a
// neighbouring one. The triangulation does not guarantee that - it connects nearest neighbours
// wherever they are, so a settlement near a zone border routinely ends up with its only link
// crossing into the zone next door. How many nearest same-zone settlements to try before giving
// up: more than one, because the nearest is sometimes the one across a ridge.
export const ROAD_ACCESS_ATTEMPTS = 4;
// A rescue searches a corridor several times the area of a normal link, so it needs a budget to
// match or it fails on the cap rather than on the ground.
export const ROAD_RESCUE_MAX_EXPANSIONS = 30000;
export const ROAD_MAX_EXPANSIONS = 12000;

// Straight-line distance times this is A*'s estimate of the cost remaining.
//
// Deliberately NOT admissible. The true cheapest ground is discounted road at 0.15 per unit, and an
// estimate that assumed it would leave A* exploring almost everything reachable - practically
// Dijkstra. Assuming flat undiscounted ground instead keeps the search tight, at the price of
// sometimes taking a route that is slightly worse than the true optimum. The behaviour that buys
// is exactly right anyway: a road uses another road when it is roughly on the way, and does not
// detour half a kilometre to reach one.
export const ROAD_HEURISTIC_WEIGHT = 1;

// Topology. Candidate links come from a Delaunay triangulation of the settlements; the spanning
// forest of those guarantees everything reachable is connected, and the shortest of the leftovers
// are added back so the network has loops and alternate routes instead of being a pure tree.
export const ROAD_EXTRA_LINK_FRACTION = 0.25;
// Continents are separated by CONTINENT_OCEAN_GAP (6000), so this also keeps the triangulation from
// proposing links across open ocean, which A* would spend its whole expansion budget failing to
// route.
export const ROAD_MAX_LINK_LENGTH = 5000;

// Shaping the raw grid path. Chaikin rounds off the 45-degree staircase an 8-neighbour grid
// produces; simplification then costs nothing visible and cuts the segment count that every later
// stage pays per terrain sample.
//
// One pass, not two, and that is a measured choice rather than a taste one. Corner cutting moves
// the line off the lattice the router checked, onto ground nothing ever sampled - so the smoother
// the line, the less the grade limit means. Measured over the finished network, spans steeper than
// ROAD_MAX_GRADE: 2.7% at one pass, 7.8% at two, 6.2% at three.
export const ROAD_SMOOTHING_PASSES = 1;
export const ROAD_SIMPLIFY_TOLERANCE = 1.5;
