import { aabbOverlaps, aabbUnion, emptyAabb, rayAabb, type Aabb, type Vec3 } from "./vec";

const LEAF_SIZE = 4;

interface Node {
  bounds: Aabb;
  /** Leaves: the items in it. */
  items: number[] | null;
  left: Node | null;
  right: Node | null;
}

/**
 * A bounding-box tree over a fixed set of items, built once, all at once: split in half along the
 * longest side of their centres, again and again, down to a few items a leaf. Items are numbered
 * by their place in the list it was built from.
 */
export interface AabbTree {
  readonly bounds: Aabb;
  /** Every item whose box overlaps `box`. */
  query(box: Aabb, visit: (item: number) => void): void;
  /**
   * The items whose boxes a ray passes through, nearer boxes first. `visit` returns how far the ray
   * may still reach - shorter once it has hit something - or a negative number to stop.
   */
  raycast(origin: Vec3, inv: Vec3, maxT: number, visit: (item: number, maxT: number) => number): void;
}

export function buildAabbTree(boxes: readonly Aabb[]): AabbTree {
  const centres = boxes.map((b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }));

  function build(items: number[]): Node {
    let bounds = emptyAabb();
    for (const i of items) bounds = aabbUnion(bounds, boxes[i]);
    if (items.length <= LEAF_SIZE) return { bounds, items, left: null, right: null };
    const spread = emptyAabb();
    for (const i of items) {
      const c = centres[i];
      spread.min.x = Math.min(spread.min.x, c.x); spread.max.x = Math.max(spread.max.x, c.x);
      spread.min.y = Math.min(spread.min.y, c.y); spread.max.y = Math.max(spread.max.y, c.y);
      spread.min.z = Math.min(spread.min.z, c.z); spread.max.z = Math.max(spread.max.z, c.z);
    }
    const sx = spread.max.x - spread.min.x, sy = spread.max.y - spread.min.y, sz = spread.max.z - spread.min.z;
    const axis = sx >= sy && sx >= sz ? "x" : sy >= sz ? "y" : "z";
    const sorted = [...items].sort((a, b) => centres[a][axis] - centres[b][axis]);
    const half = sorted.length >> 1;
    return { bounds, items: null, left: build(sorted.slice(0, half)), right: build(sorted.slice(half)) };
  }

  const root = build(boxes.map((_, i) => i));

  function query(box: Aabb, visit: (item: number) => void): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!aabbOverlaps(node.bounds, box)) continue;
      if (node.items) {
        for (const i of node.items) if (aabbOverlaps(boxes[i], box)) visit(i);
      } else {
        stack.push(node.left!, node.right!);
      }
    }
  }

  function raycast(origin: Vec3, inv: Vec3, maxT: number, visit: (item: number, maxT: number) => number): void {
    let reach = maxT;
    const walk = (node: Node, enter: number): boolean => {
      if (enter > reach) return true;
      if (node.items) {
        for (const i of node.items) {
          if (rayAabb(origin, inv, boxes[i], reach) === Infinity) continue;
          reach = visit(i, reach);
          if (reach < 0) return false;
        }
        return true;
      }
      const tl = rayAabb(origin, inv, node.left!.bounds, reach);
      const tr = rayAabb(origin, inv, node.right!.bounds, reach);
      const [first, firstT, second, secondT] = tl <= tr ? [node.left!, tl, node.right!, tr] : [node.right!, tr, node.left!, tl];
      if (firstT !== Infinity && !walk(first, firstT)) return false;
      if (secondT !== Infinity && !walk(second, secondT)) return false;
      return true;
    };
    if (boxes.length === 0) return;
    const t = rayAabb(origin, inv, root.bounds, reach);
    if (t !== Infinity) walk(root, t);
  }

  return { bounds: root.bounds, query, raycast };
}
