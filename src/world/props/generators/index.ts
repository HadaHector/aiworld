import type { PropGenerator } from "../propGenerator";
import { felledLog, logStack } from "./logs";
import { barrel, choppingBlock, crate, sawbuck } from "./woodwork";

/** Every prop generator, by the name a prop's `type` gives. A new one is a file of its own here,
 *  and a line in this table - its settings are read from its own `params`. */
export const PROP_GENERATORS: Record<string, PropGenerator> = { logStack, felledLog, choppingBlock, sawbuck, crate, barrel };
