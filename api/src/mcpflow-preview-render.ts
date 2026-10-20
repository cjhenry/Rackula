import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PreviewInput,
  PreviewFace,
  RenderResult,
} from "./mcpflow-preview-types";

/** Frozen inputs and bounded output use private files, avoiding large process-pipe buffers. */
export async function renderPreviewProcess(
  input: PreviewInput,
  rackId: string,
  face: PreviewFace,
): Promise<RenderResult> {
  const directory = await mkdtemp(join(tmpdir(), "rackula-render-"));
  const request = join(directory, "input.json"),
    result = join(directory, "output.json");
  try {
    const encoded = JSON.stringify({ input, rackId, face });
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024)
      throw new Error("Preview input exceeds 32 MiB");
    await writeFile(request, encoded, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./mcpflow-preview-render-child.ts", import.meta.url),
          ),
          request,
          result,
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
            MCPFLOW_CHROMIUM_EXECUTABLE:
              process.env.MCPFLOW_CHROMIUM_EXECUTABLE,
          },
        },
      );
      let error = "",
        failure: Error | undefined;
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const timer = setTimeout(() => {
        failure = new Error(
          "Rendering exceeded 60 seconds; inspect layout complexity or Chromium resources",
        );
        kill();
      }, 60000);
      child.stderr.on("data", (data: Buffer) => {
        error = (error + data.toString()).slice(0, 8192);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        kill();
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        kill();
        if (failure || code !== 0)
          reject(
            failure ?? new Error(error || "Renderer exited without an image"),
          );
        else resolve();
      });
    });
    if ((await stat(result)).size > 6 * 1024 * 1024)
      throw new Error("Renderer output exceeds 6 MiB");
    return JSON.parse(await readFile(result, "utf8")) as RenderResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
