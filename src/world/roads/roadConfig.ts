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

// It is paid for the WORSE of a step's two ends, so it rewards travelling along a road rather than
// merely touching one. Landing-only would let a path weave on and off and collect it every other
// step - two diagonal steps with one discounted cost 56.9 against 70 for going straight, so
// zigzagging would be cheaper than a straight line.
//
// Tried and rejected: grading the discount outward in rings, so a route passing nearby had a
// gradient to slide down onto the road. It made things worse - running BESIDE a road became cheap
// too, so roads exactly overlaid fell from 41.6% to 39.2% of nearby road length and parallel
// stretches rose. Cheap ground next to a road is an invitation to use the ground, not the road.

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

// A route this much longer than the straight line between its two settlements is not a road anyone
// would build - and, more to the point, it is not a road at all: a path that indirect is almost
// entirely running along roads that already exist, so the connection it claims to make is one the
// network already provides. Drawing it anyway is what put a second line beside half the roads on
// the map.
//
// Measured at Kuhad, whose links all misbehaved: Kuhad -> Nemorn Bridge came out 5780 units for a
// 2044 straight line, swinging far south before turning back north, because a boundary-hill ridge
// stands between them - the direct line is in bounds and unblocked but has 11 steps over the grade
// limit in 59. The right answer there is no direct road, not a road the long way round.
//
// Applied only to ordinary links, which are optional by nature - the network offers another way
// round. An access or rescue link exists precisely because nothing better was available, and for
// those an indirect road beats no road.
export const ROAD_MAX_PATH_RATIO = 1.9;
// Continents are separated by CONTINENT_OCEAN_GAP (6000), so this also keeps the triangulation from
// proposing links across open ocean, which A* would spend its whole expansion budget failing to
// route.
export const ROAD_MAX_LINK_LENGTH = 5000;

// Shaping the raw grid path. An 8-neighbour grid can only travel at multiples of 45 degrees, so
// any other heading comes out as a staircase; straightening replaces each run of steps with the
// longest straight line that is still road-worthy, and then corners are rounded.
//
// The ladder of spans, in lattice steps, tried at each anchor - longest first, so the first that
// passes is taken. Fixed rungs rather than a scan keep this to a few chord tests per anchor, and
// the chords themselves are nearly free because the cells they cross are already cached.
export const ROAD_STRAIGHTEN_SPAN_STEPS = [24, 16, 11, 8, 6, 4, 3, 2];

// A corner is rounded by a fixed radius rather than by a fraction of its segments, which is what
// Chaikin does. Once straightening has produced segments hundreds of units long, a fractional cut
// would round the corner over hundreds of units and undo the straight runs it was given.
// How much longer inside a river channel a straightened chord may be than the path it replaces.
// Zero would refuse chords that shave a unit off a crossing for reasons that have nothing to do
// with the river; a fraction of the corridor width leaves room for that and nothing more.
export const ROAD_RIVER_STRAIGHTEN_SLACK = 20;

// How near an existing road a shaped point has to be before it is pulled onto it. Just under the
// grid step, so it catches two links that straightening split apart across one lattice cell and
// leaves genuinely separate roads alone.
export const ROAD_SNAP_DISTANCE = 50;
// The line is resampled this finely before snapping, so a shared stretch follows the existing road
// through its bends instead of chording across them. Well under the snap distance on purpose.
export const ROAD_SNAP_SAMPLE = 12;

export const ROAD_CORNER_RADIUS = 45;
export const ROAD_CORNER_SEGMENTS = 6;
export const ROAD_SIMPLIFY_TOLERANCE = 1.5;

// A small sideways wander on the straight parts, so a road reads as trodden rather than surveyed.
// Everything else about a road's shape answers to the terrain; this is the one part that does not,
// so it is kept small enough that it cannot argue with anything the router decided.
export const ROAD_WOBBLE_AMPLITUDE = 30;
export const ROAD_WOBBLE_WAVELENGTH = 200;
// A second, longer wave at a lower weight. One wavelength of smooth noise still reads as regular;
// beating two against each other makes the wander vary in size along the road, which is what stops
// it looking like a ripple applied to a straight line. Longer rather than shorter on purpose - a
// shorter one would need the line resampled finer still.
export const ROAD_WOBBLE_WAVELENGTH_LONG = 400;
export const ROAD_WOBBLE_LONG_RATIO = 0.6;
// Several samples per wavelength, or the wander comes out as a straight line through a few
// displaced corners. This is what the point count is spent on - see the note in roadNetwork.
export const ROAD_WOBBLE_SAMPLE_STEP = 5;
// How far either side the road has to be straight for the wander to apply, and the turn across
// that window at which it fades out entirely. Where a road is turning, its shape is the router's
// answer to the terrain, and wobbling it would be second-guessing a decision made for a reason.
export const ROAD_WOBBLE_STRAIGHT_WINDOW = 30;
export const ROAD_WOBBLE_TURN_FADE_START = 4;
export const ROAD_WOBBLE_TURN_FADE_END = 14;
// Faded to nothing at both ends so a road still meets its settlements exactly where it was routed.
export const ROAD_WOBBLE_END_TAPER = 40;
// Below the wander's own amplitude, or simplification would throw the wander away again. This is
// what the point count is really set by: 0.25 gives 125k points across the network, 0.5 gives 83k
// and 0.9 gives 50k, while the wander delivered on straight road barely moves (p90 1.34, 1.47,
// 1.71). Coarser does not mean less wander, it means blockier wander.
export const ROAD_WOBBLE_SIMPLIFY_TOLERANCE = 0.5;

export const ROAD_WOBBLE_SALT = 703;

// --- The rendered road surface ---

// Half the width of the ribbon. A cart track, not a highway: the character capsule is 1.8 units
// tall, so 3 units either side is a road two carts can pass on.
export const ROAD_MESH_HALF_WIDTH = 3;
// How far the ribbon sits above the ground it is draped on. Small, because it follows the terrain
// exactly rather than bridging it - it only has to clear the terrain's own triangles, whose
// vertices are 2.5 units apart.
export const ROAD_MESH_LIFT = 0.08;
// Depth bias, in Babylon's polygon-offset units. Negative pulls toward the camera.
export const ROAD_MESH_Z_OFFSET = -4;
// Spacing of the ribbon's rungs. Well under the terrain's own 2.5-unit vertex spacing would be
// wasteful; well over it and the road cuts through ground it should be lying on. Also has to stay
// well under the chunk size, or a segment could cross a chunk without a point inside it.
export const ROAD_MESH_POINT_SPACING = 2.5;
// World units of road per texture repeat.
export const ROAD_MESH_TEXTURE_LENGTH = 8;
