import { Color3 } from "@babylonjs/core";
import type { BiomeDefinition } from "./biomeTypes";

const plains: BiomeDefinition = {
  id: "plains",
  name: "Plains",
  colors: {
    color0: new Color3(0.76, 0.7, 0.5),
    height0: -1,
    color1: new Color3(0.33, 0.52, 0.25),
    height1: 1.7,
    color2: new Color3(0.45, 0.42, 0.4),
    height2: 4.5,
    color3: new Color3(0.95, 0.95, 0.97),
    height3: 7,
    slopeThreshold: 0.75,
    slopeColor: new Color3(0.45, 0.42, 0.4),
  },
  height: { baseElevation: 0, amplitudeScale: 0.25, frequencyScale: 1.0 },
  borderType: "smooth",
  spawnWeight: 3,
};

const forest: BiomeDefinition = {
  id: "forest",
  name: "Forest",
  colors: {
    color0: new Color3(0.35, 0.28, 0.18),
    height0: -0.5,
    color1: new Color3(0.14, 0.32, 0.12),
    height1: 2.5,
    color2: new Color3(0.3, 0.34, 0.24),
    height2: 5,
    color3: new Color3(0.3, 0.29, 0.28),
    height3: 8,
    slopeThreshold: 0.72,
    slopeColor: new Color3(0.3, 0.29, 0.28),
  },
  height: { baseElevation: 0.5, amplitudeScale: 0.35, frequencyScale: 1.3 },
  borderType: "smooth",
  spawnWeight: 2,
};

const hills: BiomeDefinition = {
  id: "hills",
  name: "Hills",
  colors: {
    color0: new Color3(0.7, 0.62, 0.45),
    height0: 0,
    color1: new Color3(0.45, 0.5, 0.28),
    height1: 3,
    color2: new Color3(0.48, 0.45, 0.42),
    height2: 6,
    color3: new Color3(0.75, 0.73, 0.68),
    height3: 9,
    slopeThreshold: 0.78,
    slopeColor: new Color3(0.48, 0.45, 0.42),
  },
  height: { baseElevation: 1.5, amplitudeScale: 0.5, frequencyScale: 1.0 },
  borderType: "smooth",
  spawnWeight: 2,
};

const desert: BiomeDefinition = {
  id: "desert",
  name: "Desert",
  colors: {
    color0: new Color3(0.87, 0.78, 0.58),
    height0: -1.5,
    color1: new Color3(0.82, 0.68, 0.42),
    height1: 1,
    color2: new Color3(0.68, 0.5, 0.32),
    height2: 3.5,
    color3: new Color3(0.9, 0.75, 0.5),
    height3: 6,
    slopeThreshold: 0.7,
    slopeColor: new Color3(0.68, 0.5, 0.32),
  },
  height: { baseElevation: 0, amplitudeScale: 0.3, frequencyScale: 0.7, persistence: 0.5 },
  borderType: "smooth",
  spawnWeight: 1.5,
};

const mountains: BiomeDefinition = {
  id: "mountains",
  name: "Mountains",
  colors: {
    color0: new Color3(0.4, 0.38, 0.36),
    height0: 2,
    color1: new Color3(0.35, 0.33, 0.32),
    height1: 6,
    color2: new Color3(0.3, 0.29, 0.28),
    height2: 10,
    color3: new Color3(0.97, 0.97, 0.99),
    height3: 13,
    slopeThreshold: 0.8,
    slopeColor: new Color3(0.3, 0.29, 0.28),
  },
  height: { baseElevation: 6, amplitudeScale: 1.0, frequencyScale: 1.1, octaves: 5, persistence: 0.45 },
  borderType: "smooth",
  spawnWeight: 1,
};

const tundra: BiomeDefinition = {
  id: "tundra",
  name: "Tundra",
  colors: {
    color0: new Color3(0.55, 0.58, 0.55),
    height0: -0.5,
    color1: new Color3(0.75, 0.78, 0.78),
    height1: 2,
    color2: new Color3(0.6, 0.6, 0.62),
    height2: 4.5,
    color3: new Color3(0.96, 0.97, 0.99),
    height3: 6.5,
    slopeThreshold: 0.73,
    slopeColor: new Color3(0.6, 0.6, 0.62),
  },
  height: { baseElevation: 1, amplitudeScale: 0.3, frequencyScale: 0.9 },
  borderType: "smooth",
  spawnWeight: 1,
};

export const BIOME_REGISTRY: BiomeDefinition[] = [plains, forest, hills, desert, mountains, tundra];
