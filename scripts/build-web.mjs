/**
 * Fallback web build: bundles the client with bun instead of Vite.
 *
 * Vite is the normal path (`npm --prefix web run build`). This script exists
 * for machines that have bun but cannot reach the npm registry - an air-gapped
 * build host, or a corporate proxy that blocks registry.npmjs.org. The output
 * matches the shape Vite produces, content hashes included, so
 * `server/internal/webui` embeds either one without knowing the difference.
 *
 *   node scripts/build-web.mjs
 *
 * Output: web/dist/{index.html, manifest.webmanifest, 404.html, assets/, brand/}
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const dist = join(web, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

// Two flags matter here.
//
// --production turns on minification AND sets NODE_ENV. Without it bun emits
// development jsxDEV() calls that the production React build does not export,
// and the bundle dies on load with "Z is not a function".
//
// The [hash] in the output names is not cosmetic: the server promises
// "immutable, cache for a year" only for names that carry a content hash (see
// server/internal/webui/webui.go). Stable names would mean browsers keep
// running the old bundle after an upgrade.
execFileSync(
  "bun",
  [
    "build",
    join(web, "src/main.tsx"),
    "--production",
    "--target=browser",
    "--format=esm",
    `--outdir=${join(dist, "assets")}`,
    "--entry-naming=[name]-[hash].[ext]",
    "--asset-naming=[name]-[hash].[ext]",
  ],
  { stdio: "inherit", cwd: web },
);

// main.tsx imports styles.css, so bun emits the stylesheet next to the script.
// Find both by extension rather than by name - the hash is not knowable here.
const built = readdirSync(join(dist, "assets"));
const pick = (ext) => {
  const hit = built.find((f) => f.endsWith(ext));
  if (!hit) throw new Error(`bun produced no ${ext} in assets/: ${built.join(", ")}`);
  return hit;
};
const js = pick(".js");
const css = pick(".css");

// Static files ship as-is.
for (const name of ["manifest.webmanifest", "404.html", "brand"]) {
  cpSync(join(web, "public", name), join(dist, name), { recursive: true });
}

// Point index.html at whatever the hashes turned out to be.
const html = readFileSync(join(web, "index.html"), "utf8")
  .replace(/<script[^>]*src="[^"]*main\.tsx"[^>]*><\/script>/, `<script type="module" src="/assets/${js}"></script>`)
  .replace(/<\/head>/, `  <link rel="stylesheet" href="/assets/${css}" />\n  </head>`);
if (!html.includes(js) || !html.includes(css)) {
  throw new Error("index.html did not pick up the built assets - check web/index.html markup");
}
writeFileSync(join(dist, "index.html"), html);

const kb = (p) => `${(statSync(p).size / 1024).toFixed(1)} КБ`;
console.log(`готово: ${js} ${kb(join(dist, "assets", js))}, ${css} ${kb(join(dist, "assets", css))}`);
