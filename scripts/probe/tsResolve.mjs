import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Lets a probe script import project source the way the source itself does - extensionless
 * relative imports (`from "../rng"`) - by resolving them to the sibling `.ts` file when one
 * exists. Node's own resolver has no notion of this; without it every probe would need its
 * imports rewritten to add `.ts` first, which is exactly the kind of throwaway busywork this
 * harness exists to remove.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    const url = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
}
