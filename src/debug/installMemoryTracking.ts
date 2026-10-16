import { installBufferTracking } from "./memoryTracker";

// Imported first by a page, so the constructors are wrapped before any other module allocates:
// `?memory` in the URL counts every big buffer by what made it (see memoryTracker.ts).
if (new URLSearchParams(location.search).has("memory")) installBufferTracking();
