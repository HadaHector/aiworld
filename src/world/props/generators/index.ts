import type { PropGenerator } from "../propGenerator";
import { felledLog, logStack } from "./logs";
import { barrel, choppingBlock, crate, gate, grindstone, sawbuck } from "./woodwork";
import { altar, armchair, banner, bed, bench, cabinet, chair, chest, counter, fireplace, lantern, rack, sack, sconce, stool, stove, table } from "./furniture";

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
  sconce,
  banner,
  rack,
};
