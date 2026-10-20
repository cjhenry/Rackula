import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { McpflowPreviews } from "./mcpflow-previews";
import type { McpflowPublisher, DeliveryState } from "./mcpflow-publisher";
import type { PreviewInput, PreviewMetadata } from "./mcpflow-preview-types";

const id = "550e8400-e29b-41d4-a716-446655440000";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "rackula-previews-"));
  dirs.push(directory);
  let time = Date.now(),
    renders = 0;
  const input: PreviewInput = {
    layoutId: id,
    revision: 42,
    snapshotHash: "a".repeat(64),
    sourceInstance: "ict365-rackula",
    content: "coherent frozen source",
    rackIds: ["rack/unsafe-name"],
    assets: [],
  };
  const state = {
    layoutId: id,
    revision: 42,
    acknowledgedRevision: 42,
    acknowledgedHash: input.snapshotHash,
    payload: { operation: "upsert" },
    status: "synced",
  } as DeliveryState;
  const publisher = {
    states: async () => [structuredClone(state)],
    status: async () => structuredClone(state),
    previewCapture: async () => structuredClone(input),
  } as unknown as McpflowPublisher;
  const bytes = await sharp({
    create: { width: 24, height: 32, channels: 4, background: "#542ac9" },
  })
    .png()
    .toBuffer();
  const sent: { metadata: PreviewMetadata; bytes: Buffer }[] = [];
  let response: ((m: PreviewMetadata) => Response) | undefined;
  const transport = (async (_url: unknown, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer private-token",
    );
    const form = init.body as FormData;
    expect(form.get("action")).toBe("upload_preview");
    const metadata = JSON.parse(
      form.get("metadata") as string,
    ) as PreviewMetadata;
    sent.push({
      metadata,
      bytes: Buffer.from(await (form.get("image") as File).arrayBuffer()),
    });
    return (
      response?.(metadata) ??
      Response.json({
        ok: true,
        layoutId: id,
        rackId: metadata.rackId,
        face: metadata.face,
        acceptedRevision: metadata.revision,
        contentHash: metadata.contentHash,
        result: "applied",
      })
    );
  }) as typeof fetch;
  const options = {
    directory,
    publisher,
    env: {
      MCPFLOW_PREVIEWS_ENABLED: "true",
      MCPFLOW_INTEGRATION_TOKEN: "private-token",
      MCPFLOW_INTEGRATION_URL: "http://receiver.test/integration",
    },
    now: () => time,
    fetch: transport,
    render: async () => {
      renders++;
      return {
        png: bytes.toString("base64"),
        width: 24,
        height: 32,
        warnings: ["Missing image uses labels"],
      };
    },
  };
  return {
    directory,
    input,
    state,
    options,
    sent,
    bytes,
    worker: new McpflowPreviews(options),
    renders: () => renders,
    advance: () => {
      time += 4000000;
    },
    respond: (r: typeof response) => {
      response = r;
    },
  };
}

describe("durable rack preview delivery", () => {
  test("uploads separate front/rear PNGs only after snapshot acknowledgement", async () => {
    const ctx = await setup();
    ctx.state.acknowledgedRevision = 41;
    expect((await ctx.worker.backfill()).waitingForSnapshot).toBe(1);
    await ctx.worker.tick();
    expect(ctx.sent.length).toBe(0);
    ctx.state.acknowledgedRevision = 42;
    await ctx.worker.tick();
    expect(ctx.sent.map((x) => x.metadata.face)).toEqual(["front", "rear"]);
    expect(ctx.sent[0]!.metadata).toMatchObject({
      revision: 42,
      snapshotHash: "a".repeat(64),
      byteLength: ctx.bytes.length,
      mimeType: "image/png",
    });
    expect(ctx.sent[0]!.bytes.equals(ctx.bytes)).toBe(true);
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "synced",
      ),
    ).toBe(true);
    expect((await ctx.worker.statuses())[0]!.jobs[0]!.warnings).toEqual([
      "Missing image uses labels",
    ]);
  });
  test("lost acknowledgements and process restart reuse exact PNGs and metadata", async () => {
    const ctx = await setup();
    ctx.respond(() => {
      throw new Error("lost reply");
    });
    await ctx.worker.tick();
    expect(ctx.renders()).toBe(2);
    const initial = structuredClone(ctx.sent);
    ctx.advance();
    ctx.respond((m) =>
      Response.json({
        ok: true,
        layoutId: id,
        rackId: m.rackId,
        face: m.face,
        acceptedRevision: 42,
        contentHash: m.contentHash,
        result: "unchanged",
      }),
    );
    const restarted = new McpflowPreviews(ctx.options);
    await restarted.tick();
    expect(ctx.renders()).toBe(2);
    expect(ctx.sent[2]!.metadata).toEqual(initial[0]!.metadata);
    expect(ctx.sent[2]!.bytes.equals(initial[0]!.bytes)).toBe(true);
    expect(
      (await restarted.statuses())[0]!.jobs.every((j) => j.status === "synced"),
    ).toBe(true);
  });
  test("deletion invalidates local previews and releases retained image bytes", async () => {
    const ctx = await setup();
    await ctx.worker.tick();
    ctx.state.revision++;
    ctx.state.payload!.operation = "delete";
    await ctx.worker.tick();
    const row = (await ctx.worker.statuses())[0]!;
    expect(row.current).toBe(false);
    expect(row.jobs.every((j) => j.status === "superseded")).toBe(true);
    const saved = JSON.parse(
      await readFile(
        join(ctx.directory, "office/mcpflow-previews", id, "queue.json"),
        "utf8",
      ),
    );
    expect(saved.input.content).toBe("");
    expect(saved.jobs[0].metadata).toBeUndefined();
    expect(ctx.sent.length).toBe(2);
  });
  test("reassignment and rack removal queue only the newer accepted revision", async () => {
    const ctx = await setup();
    await ctx.worker.tick();
    ctx.input.revision = 43;
    ctx.state.revision = 43;
    ctx.state.acknowledgedRevision = 43;
    ctx.input.snapshotHash = "c".repeat(64);
    ctx.state.acknowledgedHash = ctx.input.snapshotHash;
    ctx.input.rackIds = ["new-rack"];
    await ctx.worker.tick();
    expect(
      ctx.sent.slice(2).map((x) => [x.metadata.revision, x.metadata.rackId]),
    ).toEqual([
      [43, "new-rack"],
      [43, "new-rack"],
    ]);
    expect((await ctx.worker.statuses())[0]!.revision).toBe(43);
  });
  test("concurrent source edit during rendering never uploads the obsolete PNG", async () => {
    const ctx = await setup();
    ctx.options.render = async () => {
      ctx.state.revision = 43;
      return {
        png: ctx.bytes.toString("base64"),
        width: 24,
        height: 32,
        warnings: [],
      };
    };
    await new McpflowPreviews(ctx.options).tick();
    expect(ctx.sent.length).toBe(0);
    expect(ctx.state.revision).toBe(43);
  });
  test("unassignment while upload is in flight cannot acknowledge a newer queue", async () => {
    const ctx = await setup();
    ctx.respond((m) => {
      ctx.state.revision = 43;
      ctx.state.payload!.operation = "delete";
      return Response.json({
        ok: true,
        layoutId: id,
        rackId: m.rackId,
        face: m.face,
        acceptedRevision: 42,
        contentHash: m.contentHash,
        result: "applied",
      });
    });
    await ctx.worker.tick();
    await ctx.worker.tick();
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "superseded",
      ),
    ).toBe(true);
    expect(ctx.sent.length).toBe(1);
  });
  test("permanent receiver errors redact credentials and require explicit retry", async () => {
    const ctx = await setup();
    ctx.respond(() =>
      Response.json(
        { error: "bad private-token", code: "preview_conflict" },
        { status: 409 },
      ),
    );
    await ctx.worker.tick();
    const jobs = (await ctx.worker.statuses())[0]!.jobs;
    expect(
      jobs.every(
        (j) => j.status === "error" && !j.error?.includes("private-token"),
      ),
    ).toBe(true);
    ctx.advance();
    await ctx.worker.tick();
    expect(ctx.sent.length).toBe(2);
    ctx.respond(undefined);
    await ctx.worker.retry(id);
    await ctx.worker.tick();
    expect(ctx.renders()).toBe(2);
    expect(ctx.sent.length).toBe(4);
  });
  test("429 Retry-After and snapshot_not_ready retain durable pending delivery", async () => {
    const ctx = await setup();
    ctx.respond(() =>
      Response.json(
        { error: "wait", code: "snapshot_not_ready" },
        { status: 409 },
      ),
    );
    await ctx.worker.tick();
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "upload_pending",
      ),
    ).toBe(true);
    ctx.advance();
    ctx.respond(() =>
      Response.json(
        { error: "rate limited" },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    );
    await ctx.worker.tick();
    const queue = JSON.parse(
      await readFile(
        join(ctx.directory, "office/mcpflow-previews", id, "queue.json"),
        "utf8",
      ),
    );
    expect(
      queue.jobs[0].nextAttemptAt - ctx.options.now(),
    ).toBeGreaterThanOrEqual(120000);
  });
  test("superseded replies retire only older preview jobs", async () => {
    const ctx = await setup();
    ctx.respond((m) =>
      Response.json({
        ok: true,
        layoutId: id,
        rackId: m.rackId,
        face: m.face,
        acceptedRevision: 50,
        contentHash: null,
        result: "superseded",
      }),
    );
    await ctx.worker.tick();
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "superseded",
      ),
    ).toBe(true);
  });
  test("render failures retry across restart without changing snapshot state", async () => {
    const ctx = await setup();
    const before = structuredClone(ctx.state);
    ctx.options.render = async () => {
      throw new Error("Chromium not installed");
    };
    await ctx.worker.tick();
    expect((await ctx.worker.statuses())[0]!.jobs[0]!.status).toBe(
      "render_pending",
    );
    ctx.advance();
    await new McpflowPreviews(ctx.options).tick();
    ctx.advance();
    await ctx.worker.tick();
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every((j) => j.status === "error"),
    ).toBe(true);
    expect(ctx.state).toEqual(before);
    expect(ctx.sent.length).toBe(0);
  });
  test("disabled uploads allow explicit local rendering without contacting MCPFlow", async () => {
    const ctx = await setup();
    ctx.options.env.MCPFLOW_PREVIEWS_ENABLED = "false";
    await ctx.worker.tick();
    expect(ctx.sent.length).toBe(0);
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "upload_pending",
      ),
    ).toBe(true);
  });
  test("empty layouts complete with zero render or upload jobs", async () => {
    const ctx = await setup();
    ctx.input.rackIds = [];
    await ctx.worker.tick();
    expect(ctx.renders()).toBe(0);
    expect((await ctx.worker.statuses())[0]!.jobs).toEqual([]);
  });
  test("wrong acknowledgement hashes and oversized PNGs cannot claim success", async () => {
    const ctx = await setup();
    ctx.respond((m) =>
      Response.json({
        ok: true,
        layoutId: id,
        rackId: m.rackId,
        face: m.face,
        acceptedRevision: 42,
        contentHash: "bad",
        result: "applied",
      }),
    );
    await ctx.worker.tick();
    expect(
      (await ctx.worker.statuses())[0]!.jobs.every(
        (j) => j.status === "upload_pending",
      ),
    ).toBe(true);
    const other = await setup();
    other.options.render = async () => ({
      png: Buffer.alloc(4194305).toString("base64"),
      width: 24,
      height: 32,
      warnings: [],
    });
    await new McpflowPreviews(other.options).tick();
    expect(other.sent.length).toBe(0);
    expect((await other.worker.statuses())[0]!.jobs[0]!.error).toContain(
      "4 MiB",
    );
  });
});
