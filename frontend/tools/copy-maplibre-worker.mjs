/* Stage MapLibre's worker where the browser can actually fetch it.
 *
 * The library spawns a module worker from a URL, and webpack rewrites that
 * URL into one that resolves to the page itself in the static export — the
 * worker then loads index.html, dies on the MIME check, and every GeoJSON
 * source on every map silently never renders (tracks, colony hulls, animal
 * dots, the replay). No error surfaces on the main thread.
 *
 * The cure maplibre documents for mangling bundlers: serve the worker as a
 * plain file and point `setWorkerUrl` at it. Copied from node_modules on
 * every dev/build run rather than committed, so the worker can never drift
 * from the installed library version. `.js` extension on purpose: the file
 * is loaded as a module worker (MIME is what matters), and every server in
 * play maps `.js` to a JavaScript MIME type without being asked.
 */
import { copyFileSync } from "node:fs";

/* The worker is a module worker and imports its sibling by RELATIVE path, so
   the shared chunk must sit next to it under the same name it was built with. */
copyFileSync(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url),
  new URL("../public/maplibre-gl-worker.js", import.meta.url),
);
copyFileSync(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs", import.meta.url),
  new URL("../public/maplibre-gl-shared.mjs", import.meta.url),
);
console.log("maplibre worker staged: public/maplibre-gl-worker.js (+ shared chunk)");
