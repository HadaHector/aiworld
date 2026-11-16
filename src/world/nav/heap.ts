/** A binary min-heap of nodes by key, ties to the lower node - so searches are deterministic. */
export interface NodeHeap {
  readonly size: number;
  /** The least key, or Infinity when empty. */
  peek(): number;
  push(key: number, node: number): void;
  /** Takes the node with the least key. */
  pop(): number;
}

export function createNodeHeap(): NodeHeap {
  const keys: number[] = [];
  const nodes: number[] = [];
  const less = (i: number, j: number): boolean => keys[i] < keys[j] || (keys[i] === keys[j] && nodes[i] < nodes[j]);
  const swap = (i: number, j: number): void => {
    [keys[i], keys[j]] = [keys[j], keys[i]];
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  };
  return {
    get size() {
      return nodes.length;
    },
    peek: () => (keys.length > 0 ? keys[0] : Infinity),
    push(key, node) {
      keys.push(key);
      nodes.push(node);
      for (let i = nodes.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (!less(i, p)) break;
        swap(i, p);
        i = p;
      }
    },
    pop() {
      const node = nodes[0];
      const last = nodes.length - 1;
      swap(0, last);
      keys.pop();
      nodes.pop();
      for (let i = 0; ; ) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < last && less(l, m)) m = l;
        if (r < last && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
      return node;
    },
  };
}
