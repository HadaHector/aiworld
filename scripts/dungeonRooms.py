"""Writes the crypt's outlined rooms and ways (public/packs/core/dungeonParts) from their floor
outlines (DUNGEONS.md, *A part*): walls 1 m thick round the outline with openings for the sockets,
a floor and a vault over every rectangle of it, light spots along the walls, spawn and chest spots.

    python scripts/dungeonRooms.py

Each part is an outline (an axis-aligned polygon, the room's inside, in order round it), the
rectangles it is made of (for its floor and vault), its height inside, and its openings - each on an
edge of the outline: where along it, how wide and high, the socket type, and how far a doorway may
reach in. An edge may be open (a corridor's end: no wall at all, the socket at its line).
"""
import json
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "packs", "core", "dungeonParts")
SMALL = ("crypt", 6, 6)
LARGE = ("cryptLarge", 10, 8)


def fmt(v):
    v = round(v, 3)
    return str(int(v)) if v == int(v) else str(v)


def build(outline, rects, height, openings, open_edges=(), pillars=()):
    """Colliders (boxes), sockets and the openings' middles, from an outline."""
    n = len(outline)
    # Which way is outside each edge: the outline's turn (positive area: counter-clockwise in x, z).
    area = sum(outline[i][0] * outline[(i + 1) % n][1] - outline[(i + 1) % n][0] * outline[i][1] for i in range(n)) / 2
    boxes = []
    sockets = []
    for r in rects:
        x0, z0, x1, z1 = r
        boxes.append([x0 - 1, -1, z0 - 1, x1 + 1, 0, z1 + 1])
        boxes.append([x0 - 1, height, z0 - 1, x1 + 1, height + 1, z1 + 1])
    for i in range(n):
        if i in open_edges:
            continue
        (ax, az), (bx, bz) = outline[i], outline[(i + 1) % n]
        dx, dz = bx - ax, bz - az
        length = abs(dx) + abs(dz)
        ux, uz = dx / length, dz / length
        # Outside: to the right of the way round for a counter-clockwise outline.
        ox, oz = (uz, -ux) if area > 0 else (-uz, ux)
        # Extended over convex corners (the outline turning away from outside), unless the edge
        # there is open (a corridor's end).
        def convex(k):
            (px, pz), (cx, cz), (qx, qz) = outline[(k - 1) % n], outline[k], outline[(k + 1) % n]
            cross = (cx - px) * (qz - cz) - (cz - pz) * (qx - cx)
            return (cross > 0) == (area > 0)
        start = -1 if convex(i) and (i - 1) % n not in open_edges else 0
        end = length + (1 if convex((i + 1) % n) and (i + 1) % n not in open_edges else 0)
        # Pieces along the edge, less the openings on it; a lintel over each.
        cuts = sorted([o for o in openings if o["edge"] == i], key=lambda o: o["at"])
        pieces, lintels = [], []
        t = start
        for o in cuts:
            a, b = o["at"] - o["size"][1] / 2, o["at"] + o["size"][1] / 2
            pieces.append((t, a))
            lintels.append((a, b, o["size"][2]))
            t = b
        pieces.append((t, end))

        def box(s0, s1, y0, y1):
            p0 = (ax + ux * s0, az + uz * s0)
            p1 = (ax + ux * s1, az + uz * s1)
            q0 = (p0[0] + ox, p0[1] + oz)
            q1 = (p1[0] + ox, p1[1] + oz)
            xs = [p0[0], p1[0], q0[0], q1[0]]
            zs = [p0[1], p1[1], q0[1], q1[1]]
            return [min(xs), y0, min(zs), max(xs), y1, max(zs)]

        for s0, s1 in pieces:
            if s1 - s0 > 1e-6:
                boxes.append(box(s0, s1, -1, height + 1))
        for a, b, h in lintels:
            if h < height:
                boxes.append(box(a, b, h, height + 1))
        for o in cuts:
            px, pz = ax + ux * o["at"] + ox, az + uz * o["at"] + oz
            facing = {(0, 1): 0, (1, 0): 90, (0, -1): 180, (-1, 0): 270}[(round(ox), round(oz))]
            sockets.append({"at": [px, 0, pz], "facing": facing, "type": o["size"][0], "size": [o["size"][1], o["size"][2]], "reach": o.get("reach", 1.5)})
    for x0, z0, x1, z1 in pillars:
        boxes.append([x0, -1, z0, x1, height + 1, z1])
    for i in open_edges:
        o = next(o for o in openings if o["edge"] == i)
        (ax, az), (bx, bz) = outline[i], outline[(i + 1) % n]
        dx, dz = bx - ax, bz - az
        length = abs(dx) + abs(dz)
        ux, uz = dx / length, dz / length
        ox, oz = (uz, -ux) if area > 0 else (-uz, ux)
        px, pz = ax + ux * o["at"], az + uz * o["at"]
        facing = {(0, 1): 0, (1, 0): 90, (0, -1): 180, (-1, 0): 270}[(round(ox), round(oz))]
        sockets.append({"at": [px, 0, pz], "facing": facing, "type": o["size"][0], "size": [o["size"][1], o["size"][2]], "reach": o.get("reach", 1)})
    return boxes, sockets


def light_spots(outline, openings, height, every=12):
    """Torches along the walls, every so far, kept off the openings."""
    n = len(outline)
    area = sum(outline[i][0] * outline[(i + 1) % n][1] - outline[(i + 1) % n][0] * outline[i][1] for i in range(n)) / 2
    spots = []
    for i in range(n):
        (ax, az), (bx, bz) = outline[i], outline[(i + 1) % n]
        dx, dz = bx - ax, bz - az
        length = abs(dx) + abs(dz)
        if length < 6:
            continue
        ux, uz = dx / length, dz / length
        ox, oz = (uz, -ux) if area > 0 else (-uz, ux)
        count = max(1, int(length // every))
        for k in range(count):
            s = length * (k + 0.5) / count
            if any(o["edge"] == i and abs(o["at"] - s) < o["size"][1] / 2 + 1.5 for o in openings):
                continue
            spots.append([ax + ux * s - ox * 0.6, min(5, height * 0.55), az + uz * s - oz * 0.6])
    return spots


def write(name, comment, tags, part, room, weight, outline, rects, height, openings, paths, stage=None, open_edges=(), pillars=(), spawns=(), chest=None, quest=None, extra_light=(), extra_boss=()):
    boxes, sockets = build(outline, rects, height, openings, open_edges, pillars)
    spots = {"light": light_spots(outline, openings, height) + list(extra_light)}
    if spawns:
        spots["spawns"] = list(spawns)
    if chest:
        spots["chest"] = [chest]
    if quest:
        spots["quest"] = [quest]
    if extra_boss:
        spots["boss"] = list(extra_boss)
    lines = [f"// {line}" for line in comment.split("\n")]
    lines.append("// Written by scripts/dungeonRooms.py from its outline - change it there.")
    lines.append("{")
    lines.append(f"  tags: {json.dumps(tags)},")
    if room:
        lines.append("  room: true,")
    lines.append(f"  weight: {fmt(weight)},")
    if stage:
        lines.append(f"  stage: [{fmt(stage[0])}, {fmt(stage[1])}],")
    lines.append("  sockets: [")
    for s in sockets:
        lines.append(f"    {{ at: [{', '.join(fmt(v) for v in s['at'])}], facing: {s['facing']}, type: \"{s['type']}\", size: [{fmt(s['size'][0])}, {fmt(s['size'][1])}], reach: {fmt(s['reach'])} }},")
    lines.append("  ],")
    lines.append("  colliders: [")
    for b in boxes:
        lines.append(f"    {{ box: [{', '.join(fmt(v) for v in b)}] }},")
    lines.append("  ],")
    lines.append("  paths: [")
    for p in paths:
        lines.append("    [" + ", ".join("[" + ", ".join(fmt(v) for v in q) + "]" for q in p) + "],")
    lines.append("  ],")
    lines.append("  spots: {")
    for k, v in spots.items():
        lines.append(f"    {k}: [" + ", ".join("[" + ", ".join(fmt(c) for c in q) + "]" for q in v) + "],")
    lines.append("  },")
    lines.append("}")
    with open(os.path.join(OUT, part + ".json5"), "w", encoding="utf8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def op(edge, at, size, reach=1.5):
    return {"edge": edge, "at": at, "size": size, "reach": reach}


# --- Halls ---------------------------------------------------------------------------------------
# Each with a gallery's way (large) as well as corridors' (small): where the two sizes of way meet.

# A long hall: 20 m by 56 m, 11 m to the vault - in from a gallery at one end, a corridor on out of
# the other and off each side.
write("cryptHallLong", "A long burial hall: 20 m by 56 m inside, 11 m to the vault - in from a gallery at one end,\na corridor on out of the other and off each side.",
      ["crypt", "hall", "large"], "cryptHallLong", True, 2,
      [(-10, 1), (10, 1), (10, 57), (-10, 57)], [(-10, 1, 10, 57)], 11,
      [op(0, 10, LARGE), op(2, 10, SMALL), op(3, 37, SMALL), op(1, 39, SMALL)],
      [[[0, 0, 0], [0, 0, 20], [0, 0, 40], [0, 0, 58]], [[-11, 0, 20], [0, 0, 20]], [[0, 0, 40], [11, 0, 40]]],
      stage=[0.1, 1], spawns=[[0, 0, 12], [-4, 0, 30], [4, 0, 48]], chest=[-7, 0, 54], quest=[7, 0, 28])

# An L: an arm 22 m wide and 44 m long, its end turning 30 m to the side - round the corner from the
# door.
write("cryptHallL", "A hall round a corner: an arm 22 m wide and 44 m long, its far end turning 30 m to the side -\nwhat is in it is out of sight of the door. In from a gallery; 11 m to the vault.",
      ["crypt", "hall", "large"], "cryptHallL", True, 2,
      [(-11, 1), (11, 1), (11, 23), (41, 23), (41, 45), (-11, 45)], [(-11, 1, 11, 45), (11, 23, 41, 45)], 11,
      [op(0, 11, LARGE), op(3, 11, SMALL), op(4, 41, SMALL), op(5, 11, SMALL)],
      [[[0, 0, 0], [0, 0, 34], [42, 0, 34]], [[0, 0, 34], [0, 0, 46]], [[-12, 0, 34], [0, 0, 34]]],
      stage=[0.1, 1], spawns=[[0, 0, 14], [28, 0, 34], [-5, 0, 40]], chest=[37, 0, 42], quest=[-7, 0, 5])

# A fat T: a stem 20 m wide in from a gallery, a crossbar 52 m by 26 m - corridors off both ends,
# a gallery on out of its far side.
write("cryptHallT", "A hall in a fat T: a stem 20 m wide in from a gallery, the crossbar 52 m by 26 m beyond -\ncorridors off both its ends, a gallery on out of its far side. 12 m to the vault.",
      ["crypt", "hall", "large"], "cryptHallT", True, 2,
      [(-10, 1), (10, 1), (10, 19), (26, 19), (26, 45), (-26, 45), (-26, 19), (-10, 19)], [(-10, 1, 10, 19), (-26, 19, 26, 45)], 12,
      [op(0, 10, LARGE), op(3, 13, SMALL), op(4, 26, LARGE), op(5, 13, SMALL)],
      [[[0, 0, 0], [0, 0, 32], [0, 0, 46]], [[-27, 0, 32], [0, 0, 32], [27, 0, 32]]],
      stage=[0.1, 1], spawns=[[0, 0, 10], [-17, 0, 32], [17, 0, 32]], chest=[-23, 0, 42], quest=[22, 0, 22])

# A smaller hall: 20 m square, 9 m high, a corridor in, a corridor and a gallery out of its sides.
write("cryptHallSmall", "A smaller hall: 20 m square, 9 m to the vault - a corridor in, a corridor out of one side and\na gallery out of the other: the way turns in it.",
      ["crypt", "hall", "large"], "cryptHallSmall", True, 2,
      [(-10, 1), (10, 1), (10, 21), (-10, 21)], [(-10, 1, 10, 21)], 9,
      [op(0, 10, SMALL), op(1, 10, SMALL), op(3, 10, LARGE)],
      [[[0, 0, 0], [0, 0, 11], [11, 0, 11]], [[-11, 0, 11], [0, 0, 11]]],
      spawns=[[-3, 0, 15], [4, 0, 6]], chest=[-7, 0, 18])

# A pillared hall: 36 m square, 12 m high, four piers round its middle - seen across between them.
write("cryptHallPillars", "A pillared hall: 36 m square, 12 m to the vault, four piers round its middle - the room seen\nacross between them, cover among them. In from a gallery, a corridor off every other side.",
      ["crypt", "hall", "large"], "cryptHallPillars", True, 2,
      [(-18, 1), (18, 1), (18, 37), (-18, 37)], [(-18, 1, 18, 37)], 12,
      [op(0, 18, LARGE), op(1, 18, SMALL), op(2, 18, SMALL), op(3, 18, SMALL)],
      [[[0, 0, 0], [0, 0, 19], [0, 0, 38]], [[-19, 0, 19], [0, 0, 19], [19, 0, 19]]],
      stage=[0.1, 1], pillars=[(-10.5, 8.5, -7.5, 11.5), (7.5, 8.5, 10.5, 11.5), (-10.5, 26.5, -7.5, 29.5), (7.5, 26.5, 10.5, 29.5)],
      spawns=[[-12, 0, 6], [12, 0, 32], [-13, 0, 28], [0, 0, 19]], chest=[15, 0, 4], quest=[-15, 0, 34])

# --- The boss ------------------------------------------------------------------------------------

# A great boss hall: twice the plain one's floor - 40 m by 44 m, 16 m to the vault - in from a
# gallery, four piers well out from its middle: room to fight, cover at its edges.
write("cryptBossHallGreat", "A great boss hall: 40 m by 44 m inside, 16 m to the vault - twice the plain boss hall's floor -\nin from a gallery, four piers well out from its middle: room to fight, cover at its edges.",
      ["crypt", "hall", "boss", "large"], "cryptBossHallGreat", True, 1,
      [(-20, 1), (20, 1), (20, 45), (-20, 45)], [(-20, 1, 20, 45)], 16,
      [op(0, 20, LARGE)],
      [[[0, 0, 0], [0, 0, 23]]],
      pillars=[(-14, 10, -11, 13), (11, 10, 14, 13), (-14, 33, -11, 36), (11, 33, 14, 36)],
      spawns=[[-8, 0, 8], [8, 0, 8]], chest=[0, 0, 41], quest=[-16, 0, 40],
      extra_boss=[[0, 0, 26]])

# --- Ways with alcoves -----------------------------------------------------------------------------

# A corridor 16 m long with an alcove 6 m wide and 4 m deep off its side: room for a chest, a tomb,
# or something waiting.
write("cryptCorridorAlcove", "A crypt corridor, 6 m wide and high, 16 m long, an alcove 6 m wide and 4 m deep off its side -\nroom for a chest, a tomb or something waiting.",
      ["crypt", "corridor"], "cryptCorridorAlcove", False, 2,
      [(-3, 0), (3, 0), (3, 5), (7, 5), (7, 11), (3, 11), (3, 16), (-3, 16)], [(-3, 0, 3, 16), (3, 5, 7, 11)], 6,
      [op(0, 3, SMALL, 1), op(6, 3, SMALL, 1)],
      [[[0, 0, 0], [0, 0, 16]]], open_edges=(0, 6),
      spawns=[[5, 0, 8]], chest=[5.5, 0, 8], extra_light=[[-2.4, 3.5, 8]])

# A gallery 20 m long with an alcove off each side.
write("cryptGalleryAlcoves", "A gallery 20 m long, 10 m wide and 8 m high, an alcove 8 m wide and 4 m deep off each side.",
      ["crypt", "corridor", "large"], "cryptGalleryAlcoves", False, 2,
      [(-5, 0), (5, 0), (5, 6), (9, 6), (9, 14), (5, 14), (5, 20), (-5, 20), (-5, 14), (-9, 14), (-9, 6), (-5, 6)],
      [(-5, 0, 5, 20), (5, 6, 9, 14), (-9, 6, -5, 14)], 8,
      [op(0, 5, LARGE, 1), op(6, 5, LARGE, 1)],
      [[[0, 0, 0], [0, 0, 20]]], open_edges=(0, 6),
      spawns=[[7, 0, 10], [-7, 0, 10]], chest=[-7.5, 0, 10])
print("written")
