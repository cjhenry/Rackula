import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
await build({
  absWorkingDir: root,
  entryPoints: ["api/src/mcpflow-layout-runtime.ts"],
  outfile: "api/src/mcpflow-normalizer.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  tsconfig: "tsconfig.json",
  define: {
    __APP_VERSION__: JSON.stringify(version),
    "import.meta.env.DEV": "false",
  },
  logLevel: "warning",
});
