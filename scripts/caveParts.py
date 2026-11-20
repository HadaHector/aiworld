"""The natural cave's parts (DUNGEONS.md, *The cave*): written as pack files, as dungeonRooms.py does
the crypt's halls. Every way through is a tunnel 9 m wide at the floor and 8 m high, so the rock's
roughness never takes it under 6 m; sockets sit on the floor at a part's edge, facing out.

    python scripts/caveParts.py
"""
import json
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "packs", "core", "dungeonParts")
W, H = 9, 8
SIZE = [W, H]


def sock(at, facing, kind="tunnel"):
    return {"at": at, "facing": facing, "type": kind, "size": SIZE}


def tunnel(points, width=W, height=H):
    return {"tunnel": {"points": points, "width": width, "height": height}}


def chamber(at, radius, height):
    return {"chamber": {"at": at, "radius": radius, "height": height}}


def dump(value, indent=""):
    """JSON5 as the hand-written parts are: keys bare, anything short on one line."""
    flat = flat_dump(value)
    if len(flat) + len(indent) <= 100 or not isinstance(value, (dict, list)):
        return flat
    inner = indent + "  "
    if isinstance(value, dict):
        rows = [inner + k + ": " + dump(v, inner) + "," for k, v in value.items()]
        return "{\n" + "\n".join(rows) + "\n" + indent + "}"
    rows = [inner + dump(v, inner) + "," for v in value]
    return "[\n" + "\n".join(rows) + "\n" + indent + "]"


def flat_dump(value):
    if isinstance(value, dict):
        return "{ " + ", ".join(k + ": " + flat_dump(v) for k, v in value.items()) + " }" if value else "{}"
    if isinstance(value, list):
        return "[" + ", ".join(flat_dump(v) for v in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return json.dumps(value)


def write(name, comment, part):
    text = "// " + comment + "\n" + dump(part) + "\n"
    with open(os.path.join(OUT, name + ".json5"), "w", encoding="utf8", newline="\n") as f:
        f.write(text)


# The way in: a tunnel down into the hill from the mouth, its top closed by a fall of rock for now
# (the mouth that opens to the surface is step 5's). Walked from the way on up to the fall: a body
# arrives near its top, looking up at it.
write("caveEntrance", "A cave's way in: a tunnel sloping down into the hill, 6 m down over 26 m.", {
    "tags": ["cave", "entrance"],
    "sockets": [sock([0, 0, 0], 180, "surface"), sock([0, -20, 42], 0)],
    "field": [tunnel([[0, -14, 16], [0, -15, 22], [0, -18, 32], [0, -20, 42]])],
    "paths": [[[0, -20, 42], [0, -18, 32], [0, -15, 22], [0, -14.2, 18]]],
    "spots": {"light": [[3, -14, 21]]},
})

# The way in on a steep hillside (dungeons/caveMouths.ts): a slip 22 m across cut 20 m back into
# the hill from the surface socket at its foot, a flat rock floor, big boulders along its sides and
# in a ring at its back round the way in - the field draws them all against the ground. The tunnel
# goes in level from the ring under the hill, then down. A body arrives just inside, looking out.
write("caveMouth", "A cave's way in on a steep hillside: a slip cut into the hill, ringed with boulders, the tunnel in level then down.", {
    "tags": ["cave", "entrance"],
    "mouth": {"width": 22, "length": 20},
    "sockets": [sock([0, 0, 0], 180, "surface"), sock([0, -14, 68], 0)],
    "field": [tunnel([[0, 0, 17], [0, 0, 32], [0, -12, 60], [0, -14, 68]])],
    "paths": [[[0, -14, 68], [0, -12, 60], [0, 0, 32], [0, 0, 24], [0, 0, 12]]],
    "spots": {"light": [[0, 0, 30]]},
})

write("caveTunnel", "A cave tunnel, 24 m, winding a little.", {
    "tags": ["cave", "tunnel"],
    "weight": 3,
    "sockets": [sock([0, 0, 0], 180), sock([0, 0, 24], 0)],
    "field": [tunnel([[0, 0, 0], [1.5, 0, 8], [-1.5, 0, 16], [0, 0, 24]])],
    "spots": {"spawns": [[0, 0, 12]], "light": [[0, 0, 12]]},
})

for side, name in ((1, "caveBendRight"), (-1, "caveBendLeft")):
    write(name, "A cave tunnel turning a quarter " + ("right" if side > 0 else "left") + ".", {
        "tags": ["cave", "tunnel", "bend"],
        "weight": 2,
        "sockets": [sock([0, 0, 0], 180), sock([18 * side, 0, 18], 90 if side > 0 else 270)],
        "field": [tunnel([[0, 0, 0], [0, 0, 6], [3 * side, 0, 13], [10 * side, 0, 17], [18 * side, 0, 18]])],
        "spots": {"light": [[4 * side, 0, 14]]},
    })

write("caveSlope", "A cave tunnel sloping down 8 m over 28 m (under 25 degrees).", {
    "tags": ["cave", "tunnel", "descent"],
    "weight": 2,
    "sockets": [sock([0, 0, 0], 180), sock([0, -8, 28], 0)],
    "field": [tunnel([[0, 0, 0], [0, 0, 4], [-1, -4, 14], [0, -8, 24], [0, -8, 28]])],
    "spots": {"light": [[-1, -4, 14]]},
})

for side, name in ((1, "caveDescentRight"), (-1, "caveDescentLeft")):
    write(name, "A cave tunnel curving a quarter " + ("right" if side > 0 else "left") + " as it goes down 8 m.", {
        "tags": ["cave", "tunnel", "descent"],
        "weight": 1,
        "sockets": [sock([0, 0, 0], 180), sock([22 * side, -8, 22], 90 if side > 0 else 270)],
        "field": [tunnel([[0, 0, 0], [0, 0, 4], [2 * side, -3, 13], [9 * side, -6, 20], [18 * side, -8, 22], [22 * side, -8, 22]])],
        "spots": {"light": [[9 * side, -6, 20]]},
    })

write("caveFork", "Where a cave tunnel forks: on ahead to either side.", {
    "tags": ["cave", "tunnel", "fork"],
    "weight": 1.5,
    "sockets": [sock([0, 0, 0], 180), sock([-16, 0, 16], 270), sock([16, 0, 16], 90)],
    "field": [tunnel([[0, 0, 0], [0, 0, 15]]), tunnel([[-16, 0, 16], [0, 0, 15], [16, 0, 16]])],
    "spots": {"spawns": [[0, 0, 14]], "light": [[0, 0, 15]]},
})

write("caveChamber", "A cave chamber, 30 by 26 m at the floor and 14 m high, ways out on every side.", {
    "tags": ["cave", "chamber"],
    "weight": 3,
    "room": True,
    "sockets": [sock([0, 0, -13], 180), sock([15, 0, 0], 90), sock([-15, 0, 0], 270), sock([0, 0, 13], 0)],
    "field": [chamber([0, 0, 0], [15, 13], 14)],
    "spots": {"spawns": [[5, 0, 3], [-5, 0, -3]], "light": [[0, 0, 0], [8, 0, -6], [-8, 0, 6]], "chest": [[-9, 0, 6]]},
})

write("caveChamberLong", "A long cave chamber, two domes run together, 46 m end to end.", {
    "tags": ["cave", "chamber"],
    "weight": 2,
    "room": True,
    "sockets": [sock([0, 0, -10], 180), sock([0, 0, 36], 0), sock([12, 0, 26], 90)],
    "field": [chamber([0, 0, 4], [11, 13], 12), chamber([0, 0, 24], [12, 12], 15)],
    "spots": {"spawns": [[3, 0, 4], [-3, 0, 24]], "light": [[0, 0, 4], [0, 0, 14], [0, 0, 26]]},
})

write("caveChamberGreat", "A great cave chamber, 40 by 34 m at the floor and 20 m high.", {
    "tags": ["cave", "chamber", "great"],
    "weight": 1.5,
    "room": True,
    "stage": [0.2, 1],
    "sockets": [sock([0, 0, -17], 180), sock([20, 0, 0], 90), sock([-20, 0, 0], 270), sock([0, 0, 17], 0)],
    "field": [chamber([0, 0, 0], [20, 17], 20)],
    "spots": {"spawns": [[7, 0, 4], [-8, 0, -3], [0, 0, 9]], "light": [[0, 0, 0], [-11, 0, 6], [11, 0, -6], [6, 0, 10]], "chest": [[12, 0, -7]]},
})

write("caveDen", "A low side chamber off a tunnel, a dead end: someone's den.", {
    "tags": ["cave", "chamber", "den"],
    "weight": 1,
    "room": True,
    "sockets": [sock([0, 0, 0], 180)],
    "field": [chamber([0, 0, 13], [11, 10], 10)],
    "spots": {"spawns": [[2, 0, 13]], "light": [[0, 0, 13], [4, 0, 18]], "chest": [[-5, 0, 17]]},
})

write("caveLair", "The boss's lair: the cave's greatest chamber, 44 by 40 m and 22 m high, one way in.", {
    "tags": ["cave", "boss"],
    "room": True,
    "sockets": [sock([0, 0, 0], 180)],
    "field": [chamber([0, 0, 21], [22, 20], 22)],
    "spots": {"boss": [[0, 0, 28]], "spawns": [[-8, 0, 14], [8, 0, 14]], "light": [[0, 0, 21], [-12, 0, 26], [12, 0, 26], [-10, 0, 10], [10, 0, 10]], "chest": [[0, 0, 36]]},
})

# A tunnel's end: its stub alone, rounded off.
write("caveCap", "A cave tunnel's dead end, rounded off.", {
    "tags": ["cave", "cap"],
    "weight": 2,
    "sockets": [sock([0, 0, 0], 180)],
    "field": [],
})

# A dead end under a chimney: the tunnel's floor sweeps up into it, curving round and up, leaning
# on away from the way in and narrowing to a point some 30 m over it (where the rock over it allows:
# else another cap).
write("caveShaftCap", "A cave tunnel's dead end sweeping up into a leaning chimney some 30 m high, narrowing to a point.", {
    "tags": ["cave", "cap"],
    "weight": 1,
    "sockets": [sock([0, 0, 0], 180)],
    "field": [
        tunnel([[0, 0, 0], [0, 0, 5]]),
        {"tube": {"points": [[0, 4.5, 3, 4.5], [0, 5, 9, 5], [0, 7.5, 13.5, 5.5], [0, 12, 16.5, 5.5], [0, 18, 18, 4.8], [0, 24, 18.5, 3.8], [0, 29, 18, 2.4], [0, 33, 17, 0.6]]}},
    ],
})

# A dead end going down a little into a hollow, gravel washed down into its bottom.
def low(shape, level):
    shape[next(iter(shape))]["low"] = level
    return shape

# The gravel cap's hollow takes its gravel under 0.8 m below its way in.
write("caveGravelCap", "A cave tunnel's dead end, down a little into a hollow filled with gravel.", {
    "tags": ["cave", "cap"],
    "weight": 1,
    "sockets": [sock([0, 0, 0], 180)],
    "field": [low(tunnel([[0, 0, 0], [0, 0, 4], [0, -2.5, 10], [0, -3.5, 15]], 11, 8.5), -0.8)],
})

# A C-shaped way down: a wide, low room curling half round a thick pillar of rock, falling 8 m as it
# goes, coming back down past it and out to the side (straight back the way it came, whatever grew
# on would run into what it came from).
arc = []
for k in range(0, 7):
    t = math.pi - k * math.pi / 6
    arc.append([round(10 + 10 * math.cos(t), 2), round(-8 * k / 6, 2), round(4 + 10 * math.sin(t), 2)])
write("caveCurl", "A C-shaped way down: a wide room curling half round a thick rock pillar, 8 m down, out to the side.", {
    "tags": ["cave", "tunnel", "descent"],
    "weight": 1.5,
    "sockets": [sock([0, 0, 0], 180), sock([30, -8, -1], 90)],
    "field": [tunnel([[0, 0, 0]] + arc + [[21, -8, 0], [25, -8, -1], [30, -8, -1]], 14, 12), {"pillar": {"at": [10, -12, 4], "radius": 3.5, "height": 34}}],
    "spots": {"spawns": [[10, -4, 13]], "light": [[3, -1, 11]]},
})

# A longer tunnel zig-zagging down into a dip 8 m deep and back up, gravel in its bottom - and a way
# off to the side, level, from the bottom of the dip: a junction on two levels.
write("caveZigzag", "A cave tunnel zig-zagging 8 m down into a dip and back up again, 32 m, gravel in the dip - and a way off to the side from the bottom of the dip: a junction on two levels.", {
    "tags": ["cave", "tunnel", "fork"],
    "weight": 2,
    "sockets": [sock([0, 0, 0], 180), sock([0, 0, 32], 0), sock([-16, -8, 17], 270)],
    "field": [low(tunnel([[0, 0, 0], [0, 0, 3], [3, -2.5, 8], [-3, -6.5, 13.5], [-1, -8, 16.5], [1.5, -7.8, 18.5], [3.5, -5.5, 22], [-2, -2.2, 26], [0, 0, 29], [0, 0, 32]], 13, 8.5), -4.5), tunnel([[-7, -8, 17.5], [-11, -8, 17.5], [-16, -8, 17]])],
    "spots": {"spawns": [[0, -8, 17]], "light": [[-3, -6.5, 13.5]]},
})

# A long meander: 60 m, bending one way and then further the other in plan, sagging 8 m in a smooth
# dip along its middle, gravel at the bottom of it - straight and level where it joins.
meander = [[0, 0, 0], [0, 0, 4]]
for k in range(1, 13):
    z = 4 + k * 52 / 13
    u = (z - 4) / 52
    # A small bend one way over its first half, a deeper one the other way over its second.
    meander.append([round(math.sin(2 * math.pi * u) * (4 if u < 0.5 else 7.5), 2), round(-8 * math.sin(u * math.pi) ** 2, 2), round(z, 2)])
meander += [[0, 0, 56], [0, 0, 60]]
write("caveMeander", "A long cave tunnel, 60 m, bending one way and then further the other, sagging 8 m along its middle, gravel at the bottom.", {
    "tags": ["cave", "tunnel"],
    "weight": 1.5,
    "sockets": [sock([0, 0, 0], 180), sock([0, 0, 60], 0)],
    "field": [low(tunnel(meander, 10, 8.5), -5)],
    "spots": {"spawns": [[meander[7][0], meander[7][1], meander[7][2]]], "light": [[meander[4][0], meander[4][1], meander[4][2]], [meander[10][0], meander[10][1], meander[10][2]]]},
})

# A tall cavern entered on a ledge 10 m up: the way on is down off it, at its foot - jumped down,
# never climbed, so it is only ever entered at the ledge.
write("caveCavern", "A tall cavern, 26 m high: in on a ledge 10 m up, the way on at its foot - a jump down, no way back up.", {
    "tags": ["cave", "chamber"],
    "weight": 1.5,
    "room": True,
    "entries": [1],
    "sockets": [sock([0, 0, 0], 180), sock([0, 10, 26], 0)],
    "field": [chamber([0, 0, 13], [13, 13], 26), {"block": {"min": [-8, -2, 19], "max": [8, 10, 32]}}],
    "paths": [[[0, 10, 26], [0, 10, 20.5]], [[0, 0, 15], [0, 0, 0]]],
    "spots": {"spawns": [[4, 0, 8], [-5, 0, 5]], "light": [[0, 0, 9], [5, 10, 23]], "chest": [[-4, 10, 23]]},
})
print("written")
