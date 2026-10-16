/** A profile curve: points [along, value], `along` rising from 0 to 1 (see CHARACTERS.md). */
export type CurvePoints = [number, number][];

/**
 * A curve through its points, smooth between them and never overshooting them (monotone cubic,
 * Fritsch-Carlson): a calf drawn as three points bulges where it is told to and nowhere else.
 * Outside the first and last point it holds their values.
 */
export function curveSampler(points: CurvePoints): (t: number) => number {
  const n = points.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => points[0][1];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) slopes.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const tangents: number[] = [slopes[0]];
  for (let i = 1; i < n - 1; i++) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  tangents.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangents[i] = (3 * a * slopes[i]) / h;
      tangents[i + 1] = (3 * b * slopes[i]) / h;
    }
  }
  return (t) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * tangents[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * tangents[i + 1];
  };
}
