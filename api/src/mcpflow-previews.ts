import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { McpflowPublisher } from "./mcpflow-publisher";
import type { EnvMap } from "./security";
import type {
  PreviewInput,
  PreviewMetadata,
  PreviewFace,
} from "./mcpflow-preview-types";
import { durableBytes, durableJson } from "./durable-file";
import { renderPreviewProcess } from "./mcpflow-preview-render";

type Job = {
  rackId: string;
  face: PreviewFace;
  status:
    "render_pending" | "upload_pending" | "synced" | "error" | "superseded";
  attempts: number;
  nextAttemptAt: number | null;
  error?: string;
  warnings?: string[];
  metadata?: PreviewMetadata;
  file?: string;
};
type Queue = {
  version: 1;
  layoutId: string;
  revision: number;
  snapshotHash: string;
  input: PreviewInput;
  jobs: Job[];
};
type Options = {
  directory: string;
  publisher: McpflowPublisher;
  env: EnvMap;
  render?: typeof renderPreviewProcess;
  fetch?: typeof fetch;
  now?: () => number;
};
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class McpflowPreviews {
  private readonly directory: string;
  private running = false;
  private operation: Promise<unknown> = Promise.resolve();
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(run);
    this.operation = next;
    return next;
  }
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  public error?: string;
  constructor(private readonly options: Options) {
    this.directory = join(options.directory, "office", "mcpflow-previews");
    this.now = options.now ?? Date.now;
  }
  private folder(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid preview layout UUID");
    return join(this.directory, id);
  }
  private clean(message: string) {
    const token = this.options.env.MCPFLOW_INTEGRATION_TOKEN;
    return (token ? message.split(token).join("[redacted]") : message)
      .replace(/[\r\n]/g, " ")
      .slice(0, 500);
  }
  private async load(id: string): Promise<Queue | null> {
    try {
      const queue = JSON.parse(
        await readFile(join(this.folder(id), "queue.json"), "utf8"),
      ) as Queue;
      if (
        queue.version !== 1 ||
        queue.layoutId !== id ||
        !Number.isSafeInteger(queue.revision) ||
        !Array.isArray(queue.jobs)
      )
        throw new Error("Invalid preview queue; restore publisher state");
      return queue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async persist(queue: Queue) {
    await durableJson(join(this.folder(queue.layoutId), "queue.json"), queue);
  }
  private async current(queue: Queue) {
    const state = await this.options.publisher.status(queue.layoutId);
    return (
      !!state &&
      state.payload?.operation === "upsert" &&
      state.revision === queue.revision &&
      state.acknowledgedRevision === queue.revision &&
      state.acknowledgedHash === queue.snapshotHash
    );
  }
  async statuses() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rows = [];
    for (const id of await readdir(this.directory)) {
      if (!uuid.test(id)) continue;
      const queue = await this.load(id);
      if (queue)
        rows.push({
          layoutId: id,
          revision: queue.revision,
          current: await this.current(queue),
          jobs: queue.jobs.map(({ file: _file, ...job }) => {
            void _file;
            return job;
          }),
        });
    }
    return rows;
  }
  /** Durable intent is separate from rendering and never touches snapshot delivery state. */
  backfill() {
    return this.exclusive(() => this.collect());
  }
  private async collect() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.error = undefined;
    const result = { queued: 0, waitingForSnapshot: 0, skipped: 0, errors: 0 };
    for (const state of await this.options.publisher.states()) {
      try {
        if (state.payload?.operation !== "upsert") {
          result.skipped++;
          continue;
        }
        if (
          state.revision !== state.acknowledgedRevision ||
          !state.acknowledgedHash
        ) {
          result.waitingForSnapshot++;
          continue;
        }
        let queue = await this.load(state.layoutId);
        if (
          queue?.revision === state.revision &&
          queue.snapshotHash === state.acknowledgedHash
        )
          continue;
        const input = await this.options.publisher.previewCapture(
          state.layoutId,
        );
        if (!input) {
          result.waitingForSnapshot++;
          continue;
        }
        await mkdir(this.folder(state.layoutId), {
          recursive: true,
          mode: 0o700,
        });
        queue = {
          version: 1,
          layoutId: state.layoutId,
          revision: input.revision,
          snapshotHash: input.snapshotHash,
          input,
          jobs: input.rackIds.flatMap((rackId) =>
            (["front", "rear"] as const).map((face) => ({
              rackId,
              face,
              status: "render_pending" as const,
              attempts: 0,
              nextAttemptAt: this.now(),
            })),
          ),
        };
        await this.persist(queue); // Frozen input survives process exit and lost upload acknowledgements.
        result.queued++;
        await this.cleanup(queue);
      } catch (error) {
        result.errors++;
        this.error = this.clean(
          error instanceof Error ? error.message : "Preview capture failed",
        );
      }
    }
    return result;
  }
  private async cleanup(queue: Queue) {
    const keep = new Set([
      "queue.json",
      ...queue.jobs.map((job) => job.file).filter(Boolean),
    ]);
    for (const file of await readdir(this.folder(queue.layoutId))) {
      if (/^[a-f0-9]{64}\.png$/.test(file) && !keep.has(file))
        await rm(join(this.folder(queue.layoutId), file));
    }
  }
  retry(id: string) {
    return this.exclusive(() => this.retryLocked(id));
  }
  private async retryLocked(id: string) {
    const queue = await this.load(id);
    if (!queue) return;
    for (const job of queue.jobs)
      if (job.status === "error") {
        job.status = job.metadata ? "upload_pending" : "render_pending";
        job.nextAttemptAt = this.now();
        job.error = undefined;
        job.attempts = 0;
      }
    await this.persist(queue);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.exclusive(() => this.runTick());
    } finally {
      this.running = false;
    }
  }
  private async runTick() {
    await this.collect();
    for (const row of await this.statuses()) {
      const queue = (await this.load(row.layoutId))!;
      await this.cleanup(queue);
      if (!(await this.current(queue))) {
        for (const job of queue.jobs) {
          job.status = "superseded";
          job.nextAttemptAt = null;
          delete job.file;
          delete job.metadata;
        }
        queue.input.assets = [];
        queue.input.content = "";
        await this.persist(queue);
        await this.cleanup(queue);
        continue;
      }
      for (const job of queue.jobs) {
        if (!(await this.current(queue))) break;
        if (
          job.nextAttemptAt === null ||
          job.nextAttemptAt > this.now() ||
          !["render_pending", "upload_pending"].includes(job.status)
        )
          continue;
        try {
          if (job.status === "render_pending") {
            const rendered = await (
              this.options.render ?? renderPreviewProcess
            )(queue.input, job.rackId, job.face);
            const bytes = Buffer.from(rendered.png, "base64");
            if (!bytes.length || bytes.length > 4194304)
              throw new Error("Rendered PNG exceeds 4 MiB or is empty");
            const decoded = sharp(bytes, {
              limitInputPixels: 16000000,
              failOn: "warning",
            });
            const info = await decoded.metadata();
            if (
              info.format !== "png" ||
              (info.pages ?? 1) !== 1 ||
              info.width !== rendered.width ||
              info.height !== rendered.height ||
              rendered.width > 8192 ||
              rendered.height > 8192
            )
              throw new Error("Rendered PNG dimensions or type are invalid");
            await decoded.raw().toBuffer();
            if (!(await this.current(queue))) break;
            const metadata: PreviewMetadata = {
              schemaVersion: 1,
              sourceInstance: queue.input.sourceInstance,
              layoutId: queue.layoutId,
              revision: queue.revision,
              snapshotHash: queue.snapshotHash,
              rackId: job.rackId,
              face: job.face,
              contentHash: sha(bytes),
              mimeType: "image/png",
              width: info.width!,
              height: info.height!,
              byteLength: bytes.length,
              generatedAt: new Date(this.now())
                .toISOString()
                .replace(/\.\d{3}Z$/, "Z"),
            };
            const cachedBytes = queue.jobs.reduce(
              (n, j) => n + (j.metadata?.byteLength ?? 0),
              0,
            );
            if (cachedBytes + bytes.length > 128 * 1024 * 1024)
              throw new Error(
                "Preview cache exceeds 128 MiB for this layout; reduce rack/image complexity",
              );
            job.file = `${metadata.contentHash}.png`;
            await durableBytes(
              join(this.folder(queue.layoutId), job.file),
              bytes,
            );
            job.metadata = metadata;
            job.warnings = rendered.warnings;
            job.status = "upload_pending";
            await this.persist(queue);
          }
          // Persisted bytes, including generatedAt, are reused on every retry.
          if (this.options.env.MCPFLOW_PREVIEWS_ENABLED === "true")
            await this.upload(queue, job);
        } catch (error) {
          job.attempts++;
          job.status =
            job.attempts < 3 && !job.metadata ? "render_pending" : "error";
          job.nextAttemptAt =
            job.status === "error" ? null : this.now() + 30000 * job.attempts;
          job.error = this.clean(
            error instanceof Error ? error.message : "Preview failed",
          );
        }
        await this.persist(queue);
      }
    }
  }
  private async upload(queue: Queue, job: Job) {
    const metadata = job.metadata!;
    const bytes = await readFile(join(this.folder(queue.layoutId), job.file!));
    if (
      sha(bytes) !== metadata.contentHash ||
      bytes.length !== metadata.byteLength
    )
      throw new Error(
        "Stored preview is damaged; restore its exact PNG or advance the snapshot revision",
      );
    if (!(await this.current(queue))) return;
    let status = 0,
      body: Record<string, unknown> = {},
      retryAfter = 0;
    try {
      if (
        !this.options.env.MCPFLOW_INTEGRATION_URL ||
        !this.options.env.MCPFLOW_INTEGRATION_TOKEN
      )
        throw new Error("Integration not configured");
      const form = new FormData();
      form.set("action", "upload_preview");
      form.set("metadata", JSON.stringify(metadata));
      form.set(
        "image",
        new Blob([bytes], { type: "image/png" }),
        "preview.png",
      );
      const response = await (this.options.fetch ?? fetch)(
        this.options.env.MCPFLOW_INTEGRATION_URL,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${this.options.env.MCPFLOW_INTEGRATION_TOKEN}`,
          },
          body: form,
        },
      );
      status = response.status;
      const after = response.headers.get("Retry-After");
      if (after)
        retryAfter = /^\d+$/.test(after)
          ? Number(after) * 1000
          : Math.max(0, Date.parse(after) - this.now());
      const reader = response.body?.getReader();
      let text = "";
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (Buffer.byteLength(text) + value.byteLength > 65536)
              throw new Error("Response exceeds 64 KiB");
            text += new TextDecoder().decode(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (status === 200) status = 0;
    }
    const identity =
      body.ok === true &&
      body.layoutId === metadata.layoutId &&
      body.rackId === metadata.rackId &&
      body.face === metadata.face;
    if (
      status === 200 &&
      identity &&
      body.result === "superseded" &&
      Number.isSafeInteger(body.acceptedRevision) &&
      (body.acceptedRevision as number) > metadata.revision &&
      body.contentHash === null
    ) {
      job.status = "superseded";
      job.nextAttemptAt = null;
      return;
    }
    if (
      status === 200 &&
      identity &&
      ["applied", "unchanged"].includes(body.result as string) &&
      body.acceptedRevision === metadata.revision &&
      body.contentHash === metadata.contentHash
    ) {
      job.status = "synced";
      job.nextAttemptAt = null;
      job.error = undefined;
      return;
    }
    const transient =
      status === 0 ||
      status === 429 ||
      status >= 500 ||
      status === 200 ||
      (status === 409 && body.code === "snapshot_not_ready");
    job.attempts++;
    job.status = transient ? "upload_pending" : "error";
    job.nextAttemptAt = transient
      ? this.now() +
        Math.min(
          3600000,
          Math.max(
            Number.isFinite(retryAfter) ? retryAfter : 0,
            Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 9)) *
              (0.75 + Math.random() * 0.5),
          ),
        )
      : null;
    job.error = this.clean(
      `Preview delivery ${status ? `HTTP ${status}` : "failed or timed out"}: ${typeof body.error === "string" ? body.error : "check receiver preview support, credentials and network"}`,
    );
  }
  start() {
    if (this.timer || this.options.env.MCPFLOW_PREVIEWS_ENABLED !== "true")
      return;
    const run = () => {
      void this.tick().catch((error) => {
        this.error = this.clean(
          error instanceof Error ? error.message : "Preview worker failed",
        );
      });
    };
    run();
    this.timer = setInterval(run, 5000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
