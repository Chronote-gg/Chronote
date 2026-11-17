import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("build/search-projection", { recursive: true });
await build({
  entryPoints: ["src/apps/searchProjection/main.ts"],
  outfile: "build/search-projection/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
});
