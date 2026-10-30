import { ContentError, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import { orderPacks, parseFile, type PackSource } from "../world/content/resolveContent";

/**
 * `rules/frontend.json5` (FRONTEND.md, *Pack data*): what a game's front end shows and plays - its
 * title, the world behind the main menu and how the camera drifts over it, where character
 * creation stands the character, the menu's music, and the saving and naming rules. Replaced whole by
 * a later pack, as the other rules files are; anything left out is the default below.
 */
export interface FrontendRules {
  title: string;
  showcase: {
    /** A world config (CONFIG.md), a seed and a dimension: the world built behind the menu. */
    config: string;
    seed: number;
    dimension: string;
    /** The hour of the day, fixed. */
    hour: number;
    /** The camera's path: round `around` at `radius`, `height` over the ground there, rising and
     *  falling by `bob`; looking at `look` metres over the centre. With `arc` (degrees from +x, the
     *  camera's side of the centre) it sways from one end to the other and back in `period` seconds,
     *  so it can keep to the side where the land goes on; without, it goes round in `period`. */
    camera: { around: [number, number]; radius: number; height: number; bob: number; period: number; look: number; arc: [number, number] | null };
    /** Where the character list and creation stand the character, which way it faces (degrees), and
     *  how far the camera is from it. */
    stage: { at: [number, number]; facing: number; distance: number };
  };
  music: { menu: string };
  save: { interval: number };
  names: { min: number; max: number };
}

export const DEFAULT_FRONTEND: FrontendRules = {
  title: "aiworld",
  showcase: {
    config: "tiny",
    seed: 1338,
    dimension: "",
    hour: 17.5,
    camera: { around: [0, 0], radius: 90, height: 30, bob: 6, period: 240, look: 4, arc: null },
    stage: { at: [0, 0], facing: 180, distance: 3.2 },
  },
  music: { menu: "mainTheme" },
  save: { interval: 30 },
  names: { min: 2, max: 16 },
};

const pair = (reader: Reader, raw: unknown, path: string, fallback: [number, number]): [number, number] => {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
    reader.fail(path, "expected [x, z]");
    return fallback;
  }
  return [raw[0], raw[1]];
};

/** The last pack's `rules/frontend.json5`, read and checked. Throws a ContentError. */
export function resolveFrontend(packs: readonly PackSource[]): FrontendRules {
  const issues: ContentIssue[] = [];
  let found: { file: string; data: unknown } | undefined;
  for (const pack of orderPacks([...packs], issues)) {
    const entry = pack.files.find((f) => f.path === "rules/frontend.json5");
    if (!entry) continue;
    const file = `${pack.id}/${entry.path}`;
    const data = parseFile(file, entry.text, issues);
    if (data !== undefined) found = { file, data };
  }
  if (!found) {
    if (issues.length > 0) throw new ContentError(issues);
    return DEFAULT_FRONTEND;
  }
  const d = DEFAULT_FRONTEND;
  const reader = new Reader(issues, found.file);
  const obj = reader.object(found.data, "");
  reader.onlyKeys(obj, "", ["title", "showcase", "music", "save", "names"]);
  const section = (key: string): RawObject => (obj[key] === undefined ? {} : reader.object(obj[key], key));
  const showcase = section("showcase");
  reader.onlyKeys(showcase, "showcase", ["config", "seed", "dimension", "hour", "camera", "stage"]);
  const camera = showcase.camera === undefined ? {} : reader.object(showcase.camera, "showcase.camera");
  reader.onlyKeys(camera, "showcase.camera", ["around", "radius", "height", "bob", "period", "look", "arc"]);
  const stage = showcase.stage === undefined ? {} : reader.object(showcase.stage, "showcase.stage");
  reader.onlyKeys(stage, "showcase.stage", ["at", "facing", "distance"]);
  const music = section("music");
  reader.onlyKeys(music, "music", ["menu"]);
  const save = section("save");
  reader.onlyKeys(save, "save", ["interval"]);
  const names = section("names");
  reader.onlyKeys(names, "names", ["min", "max"]);
  const rules: FrontendRules = {
    title: reader.optionalString(obj, "title", "") ?? d.title,
    showcase: {
      config: reader.optionalString(showcase, "config", "showcase") ?? d.showcase.config,
      seed: reader.optionalNumber(showcase, "seed", "showcase", d.showcase.seed, { min: 0, integer: true }) >>> 0,
      dimension: reader.optionalString(showcase, "dimension", "showcase") ?? d.showcase.dimension,
      hour: reader.optionalNumber(showcase, "hour", "showcase", d.showcase.hour, { min: 0, max: 24 }),
      camera: {
        around: pair(reader, camera.around, "showcase.camera.around", d.showcase.camera.around),
        radius: reader.optionalNumber(camera, "radius", "showcase.camera", d.showcase.camera.radius, { min: 1 }),
        height: reader.optionalNumber(camera, "height", "showcase.camera", d.showcase.camera.height),
        bob: reader.optionalNumber(camera, "bob", "showcase.camera", d.showcase.camera.bob, { min: 0 }),
        period: reader.optionalNumber(camera, "period", "showcase.camera", d.showcase.camera.period, { min: 1 }),
        look: reader.optionalNumber(camera, "look", "showcase.camera", d.showcase.camera.look),
        arc: camera.arc === undefined ? null : pair(reader, camera.arc, "showcase.camera.arc", [0, 360]),
      },
      stage: {
        at: pair(reader, stage.at, "showcase.stage.at", d.showcase.stage.at),
        facing: reader.optionalNumber(stage, "facing", "showcase.stage", d.showcase.stage.facing),
        distance: reader.optionalNumber(stage, "distance", "showcase.stage", d.showcase.stage.distance, { min: 0.5 }),
      },
    },
    music: { menu: reader.optionalString(music, "menu", "music") ?? d.music.menu },
    save: { interval: reader.optionalNumber(save, "interval", "save", d.save.interval, { min: 1 }) },
    names: {
      min: reader.optionalNumber(names, "min", "names", d.names.min, { min: 1, integer: true }),
      max: reader.optionalNumber(names, "max", "names", d.names.max, { min: 1, integer: true }),
    },
  };
  if (issues.length > 0) throw new ContentError(issues);
  return rules;
}
