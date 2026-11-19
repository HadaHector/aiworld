import type { PropGenerator } from "../propGenerator";
import { felledLog, logStack } from "./logs";
import { barrel, choppingBlock, crate, gate, grindstone, sawbuck } from "./woodwork";
import { heap, signpost, trough, well } from "./yard";
import { drystoneWall, railFence } from "./walls";
import { fingerArm, fingerpost } from "./signs";
import { antlerMount, campfire, firewoodStack, gameGallows, herbBundle, hideFrame, houndKennel } from "./lodge";
import { pierBridge } from "./bridges";
import { gravePost, headstone, lychgate, tomb, urn } from "./graves";
import { altar, armchair, banner, bed, bench, cabinet, candles, chair, chandelier, chest, counter, fireplace, lantern, rack, sack, sconce, stool, stove, table, wallTorch } from "./furniture";
import { crystals } from "./crystals";

/** Every prop generator, by the name a prop's `type` gives. A new one is a file of its own here,
 *  and a line in this table - its settings are read from its own `params`. */
export const PROP_GENERATORS: Record<string, PropGenerator> = {
  logStack,
  felledLog,
  choppingBlock,
  sawbuck,
  crate,
  barrel,
  grindstone,
  gate,
  well,
  trough,
  heap,
  signpost,
  fingerpost,
  fingerArm,
  pierBridge,
  railFence,
  headstone,
  gravePost,
  tomb,
  lychgate,
  drystoneWall,
  table,
  chair,
  armchair,
  stool,
  bench,
  bed,
  cabinet,
  chest,
  sack,
  counter,
  fireplace,
  stove,
  lantern,
  altar,
  candles,
  crystals,
  chandelier,
  urn,
  sconce,
  wallTorch,
  banner,
  rack,
  hideFrame,
  gameGallows,
  houndKennel,
  firewoodStack,
  campfire,
  antlerMount,
  herbBundle,
};
