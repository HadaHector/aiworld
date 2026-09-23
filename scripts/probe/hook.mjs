import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Registered as a --import so it's active before the probe script's own imports resolve.
register("./tsResolve.mjs", pathToFileURL("./scripts/probe/"));
