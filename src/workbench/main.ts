import { Engine } from "@babylonjs/core";
import { fetchPackSources } from "../world/content/loadContent";
import { resolveContent, type PackSource } from "../world/content/resolveContent";
import { ContentError, formatIssue } from "../world/content/contentReader";
import type { WorldContent } from "../world/content/worldContent";
import type { MaterialDef, GrassSpec } from "../world/materials/materialTypes";
import type { TreeKindDef } from "../world/foliage/foliageConfig";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import { TEXTURE_RESOLUTION } from "../world/materials/textureGen";
import { applyColorMatrix, materialMatrix, type ColorMatrix } from "../world/materials/colorAdjust";
import { bakedAtlas, bakedBark, bakedGround } from "./bakeCache";
import { FOLIAGE_TEXTURE_SIZE } from "../world/foliage/treeTextures";
import { GRASS_TEXTURE_SIZE, bakeGrassTextures } from "../world/foliage/grassTextures";
import { WORLD_SEED } from "../world/world";
import { createStage, type CameraView, type GroundShape, type Stage } from "./stage";
import { createTextureView, type TextureImage } from "./textureView";
import { createTextureCacheLabel } from "../debug/textureCacheLabel";

// ---------------------------------------------------------------------------------------------
// Assets: every file of every pack, by "pack/folder/id".

interface Asset {
  /** "core/materials/grass" - what the URL names. */
  key: string;
  pack: string;
  /** Inside the pack: "materials/grass.json5". */
  path: string;
  /** "materials", or "" for a pack's own files (pack.json5, defaults.json5). */
  folder: string;
  id: string;
}

/** The folders with a preview, and what each asset kind can be looked at as. */
type PreviewFolder = "materials" | "trees" | "bushes" | "rocks" | "grass";
const PREVIEW_FOLDERS: PreviewFolder[] = ["materials", "trees", "bushes", "rocks", "grass"];
/** Everything else is listed after these, its JSON still checked by Preview. */
const FOLDER_ORDER = ["materials", "trees", "bushes", "rocks", "grass", "biomes", "layers", "borderHills", "settlements", "voices", "patches", ""];

interface ViewDef {
  id: string;
  label: string;
  mode: "3d" | "2d";
}

function isPreviewFolder(folder: string): folder is PreviewFolder {
  return (PREVIEW_FOLDERS as string[]).includes(folder);
}

function listAssets(sources: PackSource[]): Asset[] {
  const assets: Asset[] = [];
  for (const pack of sources) {
    for (const file of pack.files) {
      const parts = file.path.split("/");
      const folder = parts.length === 2 ? parts[0] : "";
      const id = parts[parts.length - 1].replace(/\.json5$/, "");
      assets.push({ key: `${pack.id}/${folder ? `${folder}/` : ""}${id}`, pack: pack.id, path: file.path, folder, id });
    }
  }
  const rank = (folder: string): number => {
    const index = FOLDER_ORDER.indexOf(folder);
    return index < 0 ? FOLDER_ORDER.length : index;
  };
  return assets.sort((a, b) => rank(a.folder) - rank(b.folder) || a.folder.localeCompare(b.folder) || a.id.localeCompare(b.id) || a.pack.localeCompare(b.pack));
}

// ---------------------------------------------------------------------------------------------
// Options: what the preview bar offers, all of it kept in the URL.

const TIME_PRESETS: [string, number][] = [
  ["Dawn", 6.6],
  ["Morning", 9],
  ["Noon", 12],
  ["Afternoon", 15.5],
  ["Evening", 17.3],
  ["Night", 0],
];

type Options = Record<string, string>;

const DEFAULT_OPTIONS: Options = {
  time: "Noon",
  sky: "",
  shape: "hills",
  grass: "on",
  ground: "",
  variant: "0",
  lod: "near",
  channel: "color",
  tiles: "2",
};

// ---------------------------------------------------------------------------------------------
// Drafts: an edit survives a reload, but only while the file it was made against is unchanged.

const DRAFT_PREFIX = "aiworld.workbench.draft:";

function loadDraft(key: string, diskText: string): string | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as { base: string; text: string };
    if (draft.base === diskText) return draft.text;
    // The file changed on disk since - the draft was made against something that is gone.
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // No storage: drafts just do not survive a reload.
  }
  return null;
}

function saveDraft(key: string, diskText: string, text: string): void {
  try {
    if (text === diskText) localStorage.removeItem(DRAFT_PREFIX + key);
    else localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ base: diskText, text }));
  } catch {
    // As above.
  }
}

function hasDraft(key: string): boolean {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`workbench.html has no #${id}`);
  return found as T;
}

const assetFilter = element<HTMLInputElement>("assetFilter");
const assetList = element<HTMLElement>("assetList");
const fileName = element<HTMLElement>("fileName");
const editedBadge = element<HTMLElement>("editedBadge");
const revertButton = element<HTMLButtonElement>("revertButton");
const editor = element<HTMLTextAreaElement>("editor");
const issuesBox = element<HTMLElement>("issues");
const seedInput = element<HTMLInputElement>("seed");
const randomSeed = element<HTMLButtonElement>("randomSeed");
const previewButton = element<HTMLButtonElement>("previewButton");
const cacheLabel = createTextureCacheLabel();
cacheLabel.classList.add("hint");
previewButton.before(cacheLabel);
const viewTabs = element<HTMLElement>("viewTabs");
const viewOptions = element<HTMLElement>("viewOptions");
const stageCanvas = element<HTMLCanvasElement>("stageCanvas");
const textureCanvas = element<HTMLCanvasElement>("textureCanvas");
const stageStatus = element<HTMLElement>("stageStatus");
const stageHelp = element<HTMLElement>("stageHelp");
const pixelReadout = element<HTMLElement>("pixelReadout");

const engine = new Engine(stageCanvas, true, { preserveDrawingBuffer: true, stencil: true });
const textureView = createTextureView(textureCanvas, pixelReadout);
new ResizeObserver(() => engine.resize()).observe(stageCanvas);

let sources: PackSource[] = [];
let assets: Asset[] = [];
let current: Asset | null = null;
let diskText = "";
let viewId = "";
let options: Options = { ...DEFAULT_OPTIONS };
let seed = WORLD_SEED;
/** The last content that resolved - what the option menus are filled from. */
let lastContent: WorldContent | null = null;

let stage: Stage | null = null;
/** What the stage on screen shows - the camera is kept while this stays the same. */
let stageSubject = "";
/** What the texture on screen shows - the zoom is kept while this stays the same. */
let textureSubject = "";
/** Bumped by every preview, so one overtaken by a newer one throws its result away. */
let previewToken = 0;

engine.runRenderLoop(() => {
  if (stage && stageCanvas.style.display !== "none") stage.scene.render();
});

/** A console handle on the live preview, as `__aiworld` is on the world (see ../main.ts). */
(window as unknown as { __workbench: unknown }).__workbench = {
  engine,
  get stage() {
    return stage;
  },
  get content() {
    return lastContent;
  },
  preview: () => runPreview(),
};

// ---------------------------------------------------------------------------------------------
// URL

function readUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const parsedSeed = Number(params.get("seed"));
  if (params.has("seed") && Number.isFinite(parsedSeed)) seed = Math.trunc(parsedSeed);
  viewId = params.get("view") ?? "";
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    const value = params.get(key);
    if (value !== null) options[key] = value;
  }
  urlCamera = parseCamera(params.get("cam"));
  if (urlCamera) cameraParam = params.get("cam") ?? "";
  return params.get("asset");
}

function writeUrl(): void {
  const params = new URLSearchParams();
  if (current) params.set("asset", current.key);
  params.set("seed", String(seed));
  if (viewId) params.set("view", viewId);
  for (const [key, value] of Object.entries(options)) {
    if (value !== DEFAULT_OPTIONS[key]) params.set(key, value);
  }
  if (cameraParam) params.set("cam", cameraParam);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

// The 3D camera, in the URL as `cam=alpha,beta,radius,targetX,targetY,targetZ`: a reload - or a
// link - comes back to the same angle, not just the same asset. It belongs to one asset's one view,
// so switching either drops it and the new view frames itself.

/** A camera from the URL, waiting for the first 3D preview to use it. */
let urlCamera: CameraView | undefined;
/** The camera as the URL holds it - kept up to date as the camera moves. */
let cameraParam = "";

function parseCamera(text: string | null): CameraView | undefined {
  const values = (text ?? "").split(",").map(Number);
  if (values.length !== 6 || !values.every(Number.isFinite)) return undefined;
  const [alpha, beta, radius, x, y, z] = values;
  return { alpha, beta, radius, target: [x, y, z] };
}

function formatCamera(view: CameraView): string {
  return [view.alpha, view.beta, view.radius, ...view.target].map((v, i) => v.toFixed(i < 2 ? 3 : 2)).join(",");
}

function forgetCamera(): void {
  urlCamera = undefined;
  cameraParam = "";
}

// ---------------------------------------------------------------------------------------------
// The asset list and the editor

/** The asset list's open categories, by folder - kept across reloads. All closed to begin with. */
const EXPANDED_KEY = "aiworld.workbench.expanded";
const expanded = new Set<string>();
try {
  for (const folder of JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]) expanded.add(folder);
} catch {
  // No storage: every category starts closed.
}

function toggleGroup(folder: string): void {
  if (expanded.has(folder)) expanded.delete(folder);
  else expanded.add(folder);
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // As above.
  }
  renderAssetList();
}

function renderAssetList(): void {
  const filter = assetFilter.value.trim().toLowerCase();
  const shown = assets.filter((asset) => !filter || asset.key.toLowerCase().includes(filter));
  assetList.replaceChildren();
  let group = "\u0000";
  for (const asset of shown) {
    if (asset.folder !== group) {
      group = asset.folder;
      const folder = group;
      const header = document.createElement("button");
      header.type = "button";
      header.className = "assetGroup";
      // While filtering, every category with a match is open, so a search finds things.
      const open = filter !== "" || expanded.has(folder);
      header.setAttribute("aria-expanded", String(open));
      const count = shown.filter((a) => a.folder === folder).length;
      header.textContent = `${open ? "▾" : "▸"} ${folder || "pack"} (${count})`;
      if (folder && !isPreviewFolder(folder)) {
        const note = document.createElement("small");
        note.textContent = " - JSON only";
        header.append(note);
      }
      if (!open && current?.folder === folder) {
        const note = document.createElement("small");
        note.textContent = ` - ${current.id}`;
        note.className = "currentNote";
        header.append(note);
      }
      header.addEventListener("click", () => toggleGroup(folder));
      assetList.append(header);
    }
    if (filter === "" && !expanded.has(asset.folder)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset";
    if (!isPreviewFolder(asset.folder)) button.classList.add("noPreview");
    if (asset === current) button.classList.add("selected");
    const name = document.createElement("span");
    name.textContent = asset.id;
    button.append(name);
    if (hasDraft(asset.key)) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = "●";
      dot.title = "Edited, not saved";
      button.append(dot);
    }
    if (sources.length > 1) {
      const pack = document.createElement("span");
      pack.className = "pack";
      pack.textContent = asset.pack;
      button.append(pack);
    }
    button.addEventListener("click", () => selectAsset(asset, true));
    assetList.append(button);
  }
}

/** A file's text as a textarea holds it: a textarea turns every CRLF into LF, so the disk's text
 *  does too, or an untouched file would read as edited. */
function fileTextOf(asset: Asset): string {
  const text = sources.find((pack) => pack.id === asset.pack)?.files.find((file) => file.path === asset.path)?.text ?? "";
  return text.replace(/\r\n/g, "\n");
}

function selectAsset(asset: Asset, preview: boolean): void {
  // A different asset starts on its first view; the first one selected keeps the URL's.
  if (current && current !== asset) {
    viewId = "";
    forgetCamera();
  }
  current = asset;
  diskText = fileTextOf(asset);
  editor.value = loadDraft(asset.key, diskText) ?? diskText;
  fileName.textContent = `${asset.pack}/${asset.path}`;
  updateEditedBadge();
  renderAssetList();
  renderPreviewBar();
  writeUrl();
  if (preview) void runPreview();
}

function updateEditedBadge(): void {
  editedBadge.classList.toggle("shown", editor.value !== diskText);
}

let draftTimer: number | undefined;
editor.addEventListener("input", () => {
  updateEditedBadge();
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    if (!current) return;
    const hadDraft = hasDraft(current.key);
    saveDraft(current.key, diskText, editor.value);
    if (hadDraft !== hasDraft(current.key)) renderAssetList();
  }, 300);
});

editor.addEventListener("keydown", (event) => {
  // Two spaces for a tab, as the pack files are written, rather than leaving the textarea.
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    const { selectionStart, selectionEnd } = editor;
    editor.setRangeText("  ", selectionStart, selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
});

revertButton.addEventListener("click", () => {
  if (!current) return;
  editor.value = diskText;
  saveDraft(current.key, diskText, diskText);
  updateEditedBadge();
  renderAssetList();
  void runPreview();
});

assetFilter.addEventListener("input", renderAssetList);

// ---------------------------------------------------------------------------------------------
// Seed and preview controls

seedInput.addEventListener("change", () => {
  const value = Number(seedInput.value);
  if (!Number.isFinite(value)) return;
  seed = Math.trunc(value);
  writeUrl();
});
seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    seedInput.dispatchEvent(new Event("change"));
    void runPreview();
  }
});
randomSeed.addEventListener("click", () => {
  seed = Math.floor(Math.random() * 1_000_000);
  seedInput.value = String(seed);
  writeUrl();
  void runPreview();
});
previewButton.addEventListener("click", () => void runPreview());
window.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void runPreview();
  }
});

// ---------------------------------------------------------------------------------------------
// The preview bar: which view, and its options

function viewsFor(asset: Asset | null, content: WorldContent | null): ViewDef[] {
  if (!asset || !isPreviewFolder(asset.folder)) return [];
  switch (asset.folder) {
    case "materials":
      return [
        { id: "ground", label: "On the ground", mode: "3d" },
        { id: "texture", label: "Texture", mode: "2d" },
      ];
    case "grass":
      return [
        { id: "patch", label: "Patch", mode: "3d" },
        { id: "blades", label: "Blade texture", mode: "2d" },
      ];
    case "trees":
    case "bushes":
    case "rocks": {
      const def = content ? kindOf(content, asset) : undefined;
      const model = def?.shape.model;
      const views: ViewDef[] = [
        { id: "model", label: "Model", mode: "3d" },
        { id: "placed", label: "On the ground", mode: "3d" },
      ];
      if (model !== "primitive" && model !== "boulder") views.push({ id: "leaves", label: "Leaf atlas", mode: "2d" });
      if (model === "branching" || model === "conifer") views.push({ id: "bark", label: "Bark", mode: "2d" });
      if (model === "boulder") views.push({ id: "bark", label: "Stone", mode: "2d" });
      return views;
    }
  }
}

function currentView(): ViewDef | undefined {
  const views = viewsFor(current, lastContent);
  return views.find((view) => view.id === viewId) ?? views[0];
}

function select(label: string, key: string, choices: [string, string][], onChange: () => void): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.append(label);
  const input = document.createElement("select");
  for (const [value, text] of choices) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    input.append(option);
  }
  if (!choices.some(([value]) => value === options[key])) options[key] = choices[0]?.[0] ?? "";
  input.value = options[key];
  input.addEventListener("change", () => {
    options[key] = input.value;
    writeUrl();
    onChange();
  });
  wrapper.append(input);
  return wrapper;
}

function checkbox(label: string, key: string, onChange: () => void): HTMLLabelElement {
  const wrapper = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = options[key] === "on";
  input.addEventListener("change", () => {
    options[key] = input.checked ? "on" : "off";
    writeUrl();
    onChange();
  });
  wrapper.append(input, label);
  return wrapper;
}

function renderPreviewBar(): void {
  viewTabs.replaceChildren();
  viewOptions.replaceChildren();
  const views = viewsFor(current, lastContent);
  const view = currentView();
  for (const candidate of views) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = candidate.label;
    if (candidate === view) button.classList.add("active");
    button.addEventListener("click", () => {
      if (viewId === candidate.id && candidate === view) return;
      viewId = candidate.id;
      forgetCamera();
      writeUrl();
      renderPreviewBar();
      void runPreview();
    });
    viewTabs.append(button);
  }
  if (!view || !current) return;
  const rebuild = (): void => void runPreview();
  const content = lastContent;

  if (view.mode === "3d") {
    viewOptions.append(
      select("Light", "time", TIME_PRESETS.map(([name]) => [name, name]), () => stage?.setTime(timeHours())),
      ...(view.id === "model" ? [] : [select("Sky", "sky", [["", content ? `Auto (${autoSkyBiome(content, current).name})` : "Auto"], ...(content?.biomes ?? []).map((biome): [string, string] => [biome.id, biome.name])], rebuild),
      select("Ground", "shape", [
        ["flat", "Flat"],
        ["hills", "Hills"],
        ["steep", "Steep"],
      ], rebuild)]),
    );
    if (current.folder !== "materials" && content && view.id !== "model") {
      viewOptions.append(select("On", "ground", groundChoices(content, current), rebuild));
    }
    if (view.id !== "model") viewOptions.append(checkbox("Grass", "grass", rebuild));
    if ((current.folder === "trees" || current.folder === "bushes" || current.folder === "rocks") && content) {
      const def = kindOf(content, current);
      const variants = def ? variantCount(def) : 1;
      const variantMenu = select("Variant", "variant", [...Array.from({ length: variants }, (_, i): [string, string] => [String(i), String(i + 1)]), ["all", "All"]], rebuild);
      // Stepping through one model at a time keeps the camera where it is, so each variant is seen
      // from the same side as the last.
      const step = (by: number): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = by < 0 ? "◀" : "▶";
        button.title = by < 0 ? "Previous variant" : "Next variant";
        button.addEventListener("click", () => {
          const at = options.variant === "all" ? (by < 0 ? 0 : -1) : Number(options.variant) || 0;
          options.variant = String((at + by + variants) % variants);
          writeUrl();
          renderPreviewBar();
          rebuild();
        });
        return button;
      };
      variantMenu.append(step(-1), step(1));
      viewOptions.append(variantMenu);
      if ((current.folder === "trees" || current.folder === "rocks") && def?.shape.model !== "primitive" && def?.shape.model !== "bush") {
        viewOptions.append(select("Detail", "lod", [
          ["near", "Near"],
          ["far", "Far"],
        ], rebuild));
      }
    }
  } else {
    const atlas = view.id === "leaves" || view.id === "blades";
    viewOptions.append(
      select(
        "Channel",
        "channel",
        view.id === "blades"
          ? [
              ["color", "Colour"],
              ["shading", "Shading"],
              ["petals", "Petals"],
              ["alpha", "Alpha"],
            ]
          : atlas
          ? [
              ["color", "Colour"],
              ["alpha", "Alpha"],
            ]
          : [
              ["color", "Colour"],
              ["roughness", "Roughness"],
              ["height", "Height"],
              ["normal", "Normal"],
            ],
        rebuild,
      ),
    );
    if (!atlas) viewOptions.append(select("Tiles", "tiles", [["1", "1×1"], ["2", "2×2"], ["3", "3×3"]], rebuild));
  }
}

function timeHours(): number {
  return (TIME_PRESETS.find(([name]) => name === options.time) ?? TIME_PRESETS[2])[1];
}

/** The materials a tree or grass can be stood on: for grass, the ones that grow it come first. */
function groundChoices(content: WorldContent, asset: Asset): [string, string][] {
  const all = content.materials.map((material): [string, string] => [material.id, material.name]);
  if (asset.folder !== "grass") {
    const preferred = content.materials.find((m) => m.id === content.defaultMaterialId);
    return preferred ? [[preferred.id, preferred.name], ...all.filter(([id]) => id !== preferred.id)] : all;
  }
  const growers = content.materials.filter((material) => material.grass.some((spec) => spec.kind === asset.id));
  return [...growers.map((m): [string, string] => [m.id, `${m.name} (grows it)`]), ...all.filter(([id]) => !growers.some((m) => m.id === id))];
}

/**
 * The biome whose sky and light an asset is seen under by default: one it grows in - a material a
 * biome's ground is made of, a tree or bush a biome grows, a grass a biome's own ground grows -
 * else the plains, else the first.
 */
function autoSkyBiome(content: WorldContent, asset: Asset): BiomeDefinition {
  const usesMaterial = (biome: BiomeDefinition, id: string): boolean =>
    biome.baseMaterialId === id || biome.materialLayers.some((layer) => layer.materialId === id);
  const grows = (biome: BiomeDefinition): boolean => {
    switch (asset.folder) {
      case "materials":
        return usesMaterial(biome, asset.id);
      case "trees":
        return asset.id in (biome.outputs.foliage?.outputs ?? {});
      case "bushes":
        return asset.id in (biome.outputs.bushes?.outputs ?? {});
      case "rocks":
        return asset.id in (biome.outputs.rocks?.outputs ?? {});
      case "grass":
        return content.materials.some((material) => material.grass.some((spec) => spec.kind === asset.id) && usesMaterial(biome, material.id));
      default:
        return false;
    }
  };
  // The base material outranks a layer: a biome made of it rather than one that has patches of it.
  return (
    content.biomes.find((biome) => asset.folder === "materials" && biome.baseMaterialId === asset.id) ??
    content.biomes.find(grows) ??
    content.biomes.find((biome) => biome.id === "plains") ??
    content.biomes[0]
  );
}

function kindOf(content: WorldContent, asset: Asset): TreeKindDef | undefined {
  const kinds = asset.folder === "bushes" ? content.bushKinds : asset.folder === "rocks" ? content.rockKinds : content.treeKinds;
  return kinds.find((kind) => kind.id === asset.id);
}

function variantCount(def: TreeKindDef): number {
  return def.shape.model === "primitive" ? 1 : def.shape.variants;
}

// ---------------------------------------------------------------------------------------------
// Preview

function showIssues(lines: string[]): void {
  issuesBox.textContent = lines.join("\n");
  issuesBox.classList.toggle("shown", lines.length > 0);
}

function setStatus(text: string): void {
  stageStatus.textContent = text;
}

/** Lets the browser paint the status before a long bake on this thread. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function sourcesWithEdit(): PackSource[] {
  if (!current) return sources;
  const asset = current;
  const text = editor.value;
  return sources.map((pack) =>
    pack.id !== asset.pack ? pack : { ...pack, files: pack.files.map((file) => (file.path === asset.path ? { ...file, text } : file)) },
  );
}

function showMode(mode: "3d" | "2d" | "none"): void {
  stageCanvas.style.display = mode === "3d" ? "block" : "none";
  textureCanvas.style.display = mode === "2d" ? "block" : "none";
  stageHelp.textContent =
    mode === "3d" ? "Drag: orbit · Right-drag: pan · Wheel: zoom" : mode === "2d" ? "Wheel: zoom · Drag: pan · Double-click: fit" : "";
  if (mode !== "2d") textureView.clear();
  if (mode !== "3d") dropStage();
  // A 2D view has no camera. (Not on "none": that is also how the page starts, before the camera
  // the URL came with has been used.)
  if (mode === "2d" && cameraParam) {
    forgetCamera();
    writeUrl();
  }
}

function dropStage(): void {
  stage?.dispose();
  stage = null;
  stageSubject = "";
}

async function runPreview(): Promise<void> {
  const token = ++previewToken;
  const asset = current;
  if (!asset) return;
  showIssues([]);

  let content: WorldContent;
  try {
    content = resolveContent(sourcesWithEdit());
  } catch (error) {
    showIssues(error instanceof ContentError ? error.issues.map(formatIssue) : [String(error)]);
    setStatus("");
    return;
  }
  lastContent = content;
  renderPreviewBar();

  const view = currentView();
  if (!view) {
    showMode("none");
    setStatus(asset.folder ? `No preview for ${asset.folder} yet - the JSON checks out.` : "The JSON checks out.");
    return;
  }

  try {
    if (view.mode === "3d") await preview3d(token, asset, view, content);
    else await preview2d(token, asset, view, content);
  } catch (error) {
    if (token !== previewToken) return;
    console.error(error);
    showIssues([error instanceof Error ? error.message : String(error)]);
    setStatus("");
  }
}

function groundMaterial(content: WorldContent, asset: Asset): MaterialDef {
  const choices = groundChoices(content, asset);
  const id = choices.some(([value]) => value === options.ground) ? options.ground : choices[0][0];
  return content.materials.find((material) => material.id === id)!;
}

async function preview3d(token: number, asset: Asset, view: ViewDef, content: WorldContent): Promise<void> {
  const lightBiome = content.biomes.find((biome) => biome.id === options.sky) ?? autoSkyBiome(content, asset);
  const grassOn = options.grass === "on";
  let ground: MaterialDef;
  let grass: GrassSpec[] = [];
  let trees: Parameters<typeof createStage>[2]["trees"];

  if (asset.folder === "materials") {
    ground = content.materials.find((material) => material.id === asset.id)!;
    if (grassOn) grass = ground.grass;
  } else if (asset.folder === "grass") {
    ground = groundMaterial(content, asset);
    // The kind as the material that grows it grows it, or as a plain green meadow of it.
    const spec = ground.grass.find((entry) => entry.kind === asset.id) ?? content.materials.flatMap((m) => m.grass).find((entry) => entry.kind === asset.id);
    grass = [{ kind: asset.id, density: spec?.density ?? 1.2, color: spec?.color ?? [0.36, 0.5, 0.22] }];
    // Everything else the ground grows too, if asked for - the kind among its neighbours.
    if (grassOn) grass.push(...ground.grass.filter((entry) => entry.kind !== asset.id));
  } else {
    ground = groundMaterial(content, asset);
    if (grassOn) grass = ground.grass;
    const def = kindOf(content, asset)!;
    const variants = variantCount(def);
    const chosen = options.variant === "all" ? Array.from({ length: variants }, (_, i) => i) : [Math.min(variants - 1, Number(options.variant) || 0)];
    trees = { kinds: [def], specimens: chosen.map((variant) => ({ kind: def.id, variant, scale: 1 })), far: options.lod === "far" };
  }

  const subject = `${asset.key}|${view.id}`;
  const keepView: CameraView | undefined = stage && stageSubject === subject ? stage.getView() : urlCamera;
  showMode("3d");
  setStatus("Building");
  const built = await createStage(engine, stageCanvas, {
    seed,
    content,
    ground,
    grass,
    shape: options.shape as GroundShape,
    bare: view.id === "model",
    trees,
    timeHours: timeHours(),
    lightBiome,
    view: keepView,
    onProgress: (phase) => {
      if (token === previewToken) setStatus(phase);
    },
  });
  if (token !== previewToken) {
    built.dispose();
    return;
  }
  stage?.dispose();
  stage = built;
  stageSubject = subject;
  urlCamera = undefined;
  // The URL follows the camera - written once it settles, not on every frame of a drag.
  let cameraTimer: number | undefined;
  const recordCamera = (): void => {
    cameraParam = formatCamera(built.getView());
    writeUrl();
  };
  built.camera.onViewMatrixChangedObservable.add(() => {
    window.clearTimeout(cameraTimer);
    cameraTimer = window.setTimeout(() => {
      if (stage === built) recordCamera();
    }, 250);
  });
  recordCamera();
  setStatus("");
}

async function preview2d(token: number, asset: Asset, view: ViewDef, content: WorldContent): Promise<void> {
  const subject = `${asset.key}|${view.id}`;
  setStatus("Baking");
  await nextPaint();
  let image: TextureImage;

  if (view.id === "texture" || view.id === "bark") {
    let color: Uint8Array;
    let normal: Uint8Array;
    let matrix: ColorMatrix | undefined;
    if (view.id === "texture") {
      const material = content.materials.find((m) => m.id === asset.id)!;
      const baked = await bakedGround(material, seed);
      color = baked.colorBuffer;
      normal = baked.normalBuffer;
      matrix = materialMatrix(material);
    } else {
      const def = kindOf(content, asset)!;
      const bark = (await bakedBark(def, seed))!;
      color = bark.color;
      normal = bark.normal;
      if (def.shape.model === "boulder") matrix = def.shape.stone.adjust;
    }
    image = surfaceImage(color, normal, TEXTURE_RESOLUTION, options.channel, Number(options.tiles) || 1, matrix);
  } else if (view.id === "leaves") {
    const atlas = bakedAtlas(kindOf(content, asset)!, seed)!;
    image = atlasImage(atlas, FOLIAGE_TEXTURE_SIZE, options.channel);
  } else {
    const layer = content.grassKinds.findIndex((kind) => kind.id === asset.id);
    const layerSize = GRASS_TEXTURE_SIZE * GRASS_TEXTURE_SIZE * 4;
    const all = bakeGrassTextures(seed, content.grassKinds);
    const kind = content.grassKinds[layer];
    const stem = content.materials.flatMap((material) => material.grass).find((spec) => spec.kind === asset.id)?.color ?? [0.36, 0.5, 0.22];
    image = bladeImage(all.slice(layer * layerSize, (layer + 1) * layerSize), GRASS_TEXTURE_SIZE, options.channel, stem, kind.blades.flowerHeads?.colors[0] ?? [1, 1, 1]);
  }

  if (token !== previewToken) return;
  showMode("2d");
  textureView.show(image, textureSubject === subject);
  textureSubject = subject;
  setStatus("");
}

/** A baked surface (colour with roughness in alpha, normal with height in alpha) as one channel -
 *  its colour through `matrix`, the material's colour adjustment, as the terrain shader draws it. */
function surfaceImage(color: Uint8Array, normal: Uint8Array, size: number, channel: string, tiles: number, matrix?: ColorMatrix): TextureImage {
  const pixels = new Uint8Array(size * size * 4);
  const drawn = (o: number): [number, number, number] => {
    const rgb: [number, number, number] = [color[o] / 255, color[o + 1] / 255, color[o + 2] / 255];
    return matrix ? applyColorMatrix(matrix, rgb) : rgb;
  };
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (channel === "color" && matrix) {
      const [r, g, b] = drawn(o);
      pixels[o] = Math.min(255, r * 255);
      pixels[o + 1] = Math.min(255, g * 255);
      pixels[o + 2] = Math.min(255, b * 255);
    } else if (channel === "roughness" || channel === "height") {
      const value = channel === "roughness" ? color[o + 3] : normal[o + 3];
      pixels[o] = pixels[o + 1] = pixels[o + 2] = value;
    } else {
      const source = channel === "normal" ? normal : color;
      pixels[o] = source[o];
      pixels[o + 1] = source[o + 1];
      pixels[o + 2] = source[o + 2];
    }
    pixels[o + 3] = 255;
  }
  const at = (x: number, y: number): number => (y * size + x) * 4;
  const unit = (v: number): string => (v / 255).toFixed(2);
  return {
    width: size,
    height: size,
    pixels,
    tiles,
    describe: (x, y) => {
      const o = at(x, y);
      const [r, g, b] = drawn(o);
      return `rgb ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)}  roughness ${unit(color[o + 3])}  height ${unit(normal[o + 3])}`;
    },
  };
}

/**
 * A grass kind's blade texture. It holds no colour of its own - R is shading, G a petal mask, A the
 * cut-out (see grassTextures.ts) - so "color" composes it as the grass shader does, with a tint a
 * material grows it in and its first petal colour. Turned upright: the root is the texture's first
 * row.
 */
function bladeImage(source: Uint8Array, size: number, channel: string, stem: [number, number, number], petal: [number, number, number]): TextureImage {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = ((size - 1 - y) * size + x) * 4;
      const d = (y * size + x) * 4;
      const shade = source[o] / 255;
      const petalMask = source[o + 1] / 255;
      if (channel === "color") {
        const rootShade = 0.8 + 0.2 * (1 - y / (size - 1));
        for (let c = 0; c < 3; c++) pixels[d + c] = Math.round(255 * Math.min(1, (stem[c] * rootShade * (1 - petalMask) + petal[c] * petalMask) * shade));
        pixels[d + 3] = source[o + 3];
      } else {
        const value = channel === "shading" ? source[o] : channel === "petals" ? source[o + 1] : source[o + 3];
        pixels[d] = pixels[d + 1] = pixels[d + 2] = value;
        pixels[d + 3] = 255;
      }
    }
  }
  const unit = (v: number): string => (v / 255).toFixed(2);
  return {
    width: size,
    height: size,
    pixels,
    tiles: 1,
    describe: (x, y) => {
      const o = ((size - 1 - y) * size + x) * 4;
      return `shading ${unit(source[o])}  petals ${unit(source[o + 1])}  alpha ${unit(source[o + 3])}`;
    },
  };
}

/** A cut-out atlas, as it is or as its alpha. */
function atlasImage(source: Uint8Array, size: number, channel: string): TextureImage {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (channel === "alpha") {
      pixels[o] = pixels[o + 1] = pixels[o + 2] = source[o + 3];
      pixels[o + 3] = 255;
    } else {
      pixels[o] = source[o];
      pixels[o + 1] = source[o + 1];
      pixels[o + 2] = source[o + 2];
      pixels[o + 3] = source[o + 3];
    }
  }
  const unit = (v: number): string => (v / 255).toFixed(2);
  return {
    width: size,
    height: size,
    pixels,
    tiles: 1,
    describe: (x, y) => {
      const o = (y * size + x) * 4;
      return `rgba ${unit(source[o])} ${unit(source[o + 1])} ${unit(source[o + 2])} ${unit(source[o + 3])}`;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Start

async function start(): Promise<void> {
  const wanted = readUrl();
  seedInput.value = String(seed);
  showMode("none");
  setStatus("Loading packs");
  try {
    sources = await fetchPackSources();
  } catch (error) {
    showIssues(error instanceof ContentError ? error.issues.map(formatIssue) : [String(error)]);
    setStatus("The packs could not be loaded");
    return;
  }
  assets = listAssets(sources);
  // The menus need content before the first preview has resolved any.
  try {
    lastContent = resolveContent(sources);
  } catch {
    lastContent = null;
  }
  const first = assets.find((asset) => asset.key === wanted) ?? assets.find((asset) => asset.folder === "materials") ?? assets[0];
  setStatus("");
  if (first) selectAsset(first, true);
}

void start();
