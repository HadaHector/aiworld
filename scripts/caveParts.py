"""The natural cave's parts (DUNGEONS.md, *The cave*): written as pack files, as dungeonRooms.py does
the crypt's halls. Every way through is a tunnel 9 m wide at the floor and 8 m high, so the rock's
roughness never takes it under 6 m; sockets sit on the floor at a part's edge, facing out.

    python scripts/caveParts.py
"""
import json
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
    "sockets": [sock([0, 0, 0], 180)],
    "field": [],
})
print("written")
