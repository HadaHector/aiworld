import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Registered as a --import so it is active before the server's own imports resolve.
register("./guard.mjs", pathToFileURL("./scripts/server/"));
