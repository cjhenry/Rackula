import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["api/src/mcpflow-preview-browser.ts"],
  outfile: "api/src/mcpflow-preview-browser.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  tsconfig: "tsconfig.json",
  loader: { ".webp": "dataurl", ".png": "dataurl", ".jpg": "dataurl" },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    "import.meta.env.DEV": "false",
    "import.meta.env.MODE": '"production"',
  },
  logLevel: "warning",
});
