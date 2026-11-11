// The dungeon layouts page (dungeons.html, DUNGEONS.md *Dev pages*): a line-up of one style's
// layouts, a seed each, as plans from above with the graph over them and side views under the
// ground's line - to judge the generator by eye. Edits to the packs reload the page.
import { fetchPackSources } from "../world/content/loadContent";
import { ContentError } from "../world/content/contentReader";
import { resolveDungeons, type DungeonContent } from "../world/dungeons/dungeonDefs";
import { generateLayout, placedSockets, toWorld, type DungeonLayout, type PlacedPart } from "../world/dungeons/layout";
import { asDungeonGround, testGround, testSite, TEST_GROUNDS, type TestGround } from "../world/dungeons/testGrounds";
import { vec3 } from "../world/collision/index";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const plans = element<HTMLDivElement>("plans");
const styleSelect = element<HTMLSelectElement>("style");
const sizeSelect = element<HTMLSelectElement>("size");
const groundSelect = element<HTMLSelectElement>("ground");
const seedInput = element<HTMLInputElement>("seed");
const countInput = element<HTMLInputElement>("count");

const ROLES: Record<PlacedPart["role"], { label: string; fill: string }> = {
  entrance: { label: "Entrance", fill: "#6fa8c7" },
  room: { label: "Room", fill: "#c9a46a" },
  way: { label: "Corridor, stair", fill: "#7d8a96" },
  boss: { label: "Boss room", fill: "#c75f5f" },
  cap: { label: "Walled up", fill: "#4a525c" },
};
element("legend").innerHTML =
  Object.values(ROLES).map((r) => `<div><i style="background:${r.fill}"></i>${r.label}</div>`).join("") +
  `<div><i style="background:#e0c050"></i>Key (in its room)</div><div><i style="background:#e05050"></i>Locked way</div><div><i style="background:#5f9e5f"></i>Ground (side view)</div>`;

const params = new URLSearchParams(location.search);
let content: DungeonContent | null = null;

function readUrl(): void {
  if (params.has("seed")) seedInput.value = params.get("seed")!;
  if (params.has("count")) countInput.value = params.get("count")!;
}

function writeUrl(): void {
  const next = new URLSearchParams({ style: styleSelect.value, size: sizeSelect.value, ground: groundSelect.value, seed: seedInput.value, count: countInput.value });
  history.replaceState(null, "", `${location.pathname}?${next}`);
}

/** A part's footprint, its local bounds' corners turned into the world. */
function footprint(p: PlacedPart): { x: number; z: number }[] {
  const b = p.part.bounds;
  return [vec3(b.min.x, 0, b.min.z), vec3(b.max.x, 0, b.min.z), vec3(b.max.x, 0, b.max.z), vec3(b.min.x, 0, b.max.z)].map((c) => toWorld(p, c));
}

function drawLayout(canvas: HTMLCanvasElement, layout: DungeonLayout, ground: TestGround, cover: number): void {
  const parts = layout.parts;
  const plan = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of parts) {
    plan.minX = Math.min(plan.minX, p.bounds.min.x); plan.maxX = Math.max(plan.maxX, p.bounds.max.x);
    plan.minZ = Math.min(plan.minZ, p.bounds.min.z); plan.maxZ = Math.max(plan.maxZ, p.bounds.max.z);
    plan.minY = Math.min(plan.minY, p.bounds.min.y); plan.maxY = Math.max(plan.maxY, p.bounds.max.y);
  }
  const pad = 8;
  const width = canvas.clientWidth * devicePixelRatio;
  const planW = plan.maxX - plan.minX + 2 * pad, planD = plan.maxZ - plan.minZ + 2 * pad;
  const scale = width / Math.max(planW, 60);
  const planHeight = planD * scale;
  // The side view: along z (the way in runs north), y up, the ground's line over the dungeon.
  let groundTop = -Infinity;
  for (let z = plan.minZ - pad; z <= plan.maxZ + pad; z += 2) for (let x = plan.minX; x <= plan.maxX; x += 4) groundTop = Math.max(groundTop, ground.heightAt(x, z));
  const sideTop = Math.max(plan.maxY, groundTop) + 4, sideBottom = plan.minY - 4;
  // Its own scale: the way in, south to north, across the whole width; metres up as metres along.
  const sideScale = width / planD;
  const sx = (z: number): number => (z - plan.minZ + pad) * sideScale;
  const sideHeight = (sideTop - sideBottom) * sideScale + 20;
  canvas.width = width;
  canvas.height = Math.ceil(planHeight + sideHeight + 16);
  canvas.style.height = `${canvas.height / devicePixelRatio}px`;
  const g = canvas.getContext("2d")!;
  g.lineJoin = "round";
  // North up: z grows upward on screen.
  const px = (x: number): number => (x - plan.minX + pad) * scale;
  const pz = (z: number): number => planHeight - (z - plan.minZ + pad) * scale;
  const depthShade = (y: number): number => 0.45 + 0.55 * (1 - (plan.maxY - y) / Math.max(1, plan.maxY - plan.minY));

  // The plan, deepest first so what lies over shows on top.
  const order = parts.map((_, i) => i).sort((a, b) => parts[a].bounds.max.y - parts[b].bounds.max.y);
  for (const i of order) {
    const p = parts[i];
    const corners = footprint(p);
    g.globalAlpha = depthShade(p.bounds.max.y) * (p.role === "cap" ? 1 : 0.85);
    g.fillStyle = ROLES[p.role].fill;
    g.beginPath();
    corners.forEach((c, k) => (k === 0 ? g.moveTo(px(c.x), pz(c.z)) : g.lineTo(px(c.x), pz(c.z))));
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = i === layout.key ? "#e0c050" : "#12171c";
    g.lineWidth = i === layout.key ? 3 * devicePixelRatio : devicePixelRatio;
    g.stroke();
  }
  // The graph: socket to socket through each part's middle.
  layout.joins.forEach((j, k) => {
    const s = placedSockets(layout, j.a)[j.socketA];
    const centre = (p: PlacedPart): { x: number; z: number } => ({ x: (p.bounds.min.x + p.bounds.max.x) / 2, z: (p.bounds.min.z + p.bounds.max.z) / 2 });
    const a = centre(parts[j.a]), b = centre(parts[j.b]);
    if (parts[j.b].role === "cap") return;
    g.strokeStyle = k === layout.lock ? "#e05050" : j.loop ? "#9fd39f" : "rgba(230,236,242,0.75)";
    g.lineWidth = (k === layout.lock ? 3 : 1.5) * devicePixelRatio;
    g.beginPath();
    g.moveTo(px(a.x), pz(a.z));
    g.lineTo(px(s.at.x), pz(s.at.z));
    g.lineTo(px(b.x), pz(b.z));
    g.stroke();
  });
  // The door.
  const door = placedSockets(layout, 0).find((s) => s.def.type === "surface");
  if (door) {
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(px(door.at.x), pz(door.at.z), 4 * devicePixelRatio, 0, Math.PI * 2);
    g.fill();
  }

  // The side view.
  const top = planHeight + 16;
  const sy = (y: number): number => top + 10 + (sideTop - y) * sideScale;
  g.fillStyle = "#1a2129";
  g.fillRect(0, top, width, sideHeight);
  for (const i of order) {
    const p = parts[i];
    g.globalAlpha = 0.85;
    g.fillStyle = ROLES[p.role].fill;
    g.fillRect(sx(p.bounds.min.z), sy(p.bounds.max.y), (p.bounds.max.z - p.bounds.min.z) * sideScale, (p.bounds.max.y - p.bounds.min.y) * sideScale);
    g.globalAlpha = 1;
  }
  // The ground: its lowest over each z (what the dungeon must be under), and the cover line below it.
  const line = (offset: number, colour: string, dash: number[]): void => {
    g.strokeStyle = colour;
    g.setLineDash(dash.map((d) => d * devicePixelRatio));
    g.lineWidth = 2 * devicePixelRatio;
    g.beginPath();
    for (let z = plan.minZ - pad, k = 0; z <= plan.maxZ + pad; z += 1, k++) {
      let low = Infinity;
      for (let x = plan.minX; x <= plan.maxX; x += 2) low = Math.min(low, ground.heightAt(x, z));
      const X = sx(z), Y = sy(low - offset);
      if (k === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
    }
    g.stroke();
    g.setLineDash([]);
  };
  line(0, "#5f9e5f", []);
  line(cover, "rgba(95,158,95,0.6)", [4, 4]);
}

function render(): void {
  if (!content) return;
  writeUrl();
  plans.replaceChildren();
  const style = content.styles.get(styleSelect.value);
  if (!style) return;
  const ground = testGround(groundSelect.value);
  const first = Number(seedInput.value) || 0;
  const count = Math.max(1, Math.min(24, Number(countInput.value) || 6));
  for (let seed = first; seed < first + count; seed++) {
    const card = document.createElement("div");
    card.className = "plan";
    const t0 = performance.now();
    let layout: DungeonLayout;
    try {
      layout = generateLayout(content, style.id, sizeSelect.value, seed, testSite(ground), asDungeonGround(ground));
    } catch (error) {
      card.textContent = `seed ${seed}: ${(error as Error).message}`;
      plans.append(card);
      continue;
    }
    const ms = performance.now() - t0;
    const rooms = layout.parts.filter((p) => p.role === "room" || p.role === "boss").length;
    const depth = testSite(ground).y - Math.min(...layout.parts.map((p) => p.bounds.min.y + 1));
    const walk = new URLSearchParams({ preset: "dungeon", style: style.id, size: sizeSelect.value, seed: String(seed), ground: ground.id });
    const title = document.createElement("div");
    title.className = "title";
    title.innerHTML =
      `<b>seed ${seed}</b><span>${rooms} rooms, ${layout.parts.length} parts, ${depth.toFixed(0)} m down` +
      `${layout.minimal ? ", <b>minimal</b>" : ""}${layout.attempt > 0 && !layout.minimal ? `, try ${layout.attempt + 1}` : ""}, ${ms.toFixed(1)} ms</span>` +
      `<a href="collision.html?${walk}" target="_blank">Walk it</a>`;
    if (layout.failures.length > 0) title.title = layout.failures.join("\n");
    const canvas = document.createElement("canvas");
    card.append(title, canvas);
    plans.append(card);
    drawLayout(canvas, layout, ground, style.cover);
  }
}

async function start(): Promise<void> {
  readUrl();
  for (const g of TEST_GROUNDS) groundSelect.add(new Option(g.label, g.id, false, g.id === params.get("ground")));
  try {
    content = resolveDungeons(await fetchPackSources());
  } catch (error) {
    element("error").textContent = error instanceof ContentError ? error.message : String(error);
    return;
  }
  for (const id of content.styles.keys()) styleSelect.add(new Option(content.styles.get(id)!.name, id, false, id === params.get("style")));
  const fillSizes = (): void => {
    const style = content!.styles.get(styleSelect.value);
    const wanted = sizeSelect.value || params.get("size");
    sizeSelect.replaceChildren(...Object.keys(style?.sizes ?? {}).map((s) => new Option(s, s, false, s === wanted)));
  };
  fillSizes();
  styleSelect.addEventListener("change", () => { fillSizes(); render(); });
  for (const input of [sizeSelect, groundSelect, seedInput, countInput]) input.addEventListener("change", render);
  element("prev").addEventListener("click", () => { seedInput.value = String((Number(seedInput.value) || 0) - (Number(countInput.value) || 6)); render(); });
  element("next").addEventListener("click", () => { seedInput.value = String((Number(seedInput.value) || 0) + (Number(countInput.value) || 6)); render(); });
  addEventListener("resize", render);
  render();
}

void start();
