import { build } from "esbuild";

await build({
  entryPoints: ["src/desktop/preload/index.cts"],
  outfile: "dist/desktop/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
