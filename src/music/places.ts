// Which music style plays where: by the biome of the zone the player stands in, and inside some
// buildings by the building. See MUSIC.md.

/** Biome id to style id. A biome not listed plays the forest. */
export const BIOME_STYLES: Record<string, string> = {
  autumnWood: "forest",
  bluebellWood: "glade",
  cloudForest: "glade",
  meadow: "epic",
  desert: "desert",
  desertRange: "desert",
  sandSea: "desert",
  saltFlat: "desert",
  cypressBayou: "swamp",
  reedMarsh: "swamp",
  frozenBog: "swamp",
  frostSteppe: "snow",
  polarDesert: "snow",
  icePeaks: "snow",
  snowyTaiga: "snow",
  greenAlps: "nordic",
  alpineMeadow: "nordic",
  heatherMoor: "highlands",
  windsweptFell: "highlands",
  maquis: "mediterranean",
  sageHills: "mediterranean",
  savanna: "savanna",
  redBush: "savanna",
  rainforest: "jungle",
  palmGrove: "jungle",
};

export const DEFAULT_STYLE = "forest";

/** Building id to style id: inside these the building's own music plays. */
export const BUILDING_STYLES: Record<string, string> = {
  inn: "tavern",
  chapel: "holy",
  crypt: "swamp",
};
