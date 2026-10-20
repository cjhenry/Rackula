import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { McpflowPreviews } from "./mcpflow-previews";
import { normalizeLayout } from "./mcpflow-normalizer.js";
import type { McpflowPublisher, DeliveryState } from "./mcpflow-publisher";
import type { PreviewInput, PreviewMetadata } from "./mcpflow-preview-types";

test.skipIf(!process.env.RACKULA_SIHS_PREVIEW_INPUT)(
  "actual SIHS renders four private PNGs and retries exact multipart bytes over HTTP",
  async () => {
    const source = JSON.parse(
      await readFile(process.env.RACKULA_SIHS_PREVIEW_INPUT!, "utf8"),
    ) as PreviewInput;
    const snapshot = normalizeLayout(source.content, source.layoutId);
    expect(snapshot.racks.length).toBe(2);
    expect(snapshot.racks.reduce((n, r) => n + r.devices.length, 0)).toBe(25);
    const accepted = new Map<
      string,
      { metadata: PreviewMetadata; hash: string }
    >();
    let uploads = 0,
      lostReply = false,
      time = Date.now();
    // Contract reference server only. The actual MCPFlow preview receiver is still pending.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== "Bearer test-preview-only")
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        const encoded = await request.arrayBuffer();
        expect(encoded.byteLength).toBeLessThanOrEqual(4259840);
        const form = await new Response(encoded, {
          headers: { "Content-Type": request.headers.get("content-type")! },
        }).formData();
        expect([...form.keys()].sort()).toEqual([
          "action",
          "image",
          "metadata",
        ]);
        expect(form.get("action")).toBe("upload_preview");
        expect(
          Buffer.byteLength(form.get("metadata") as string),
        ).toBeLessThanOrEqual(8192);
        const metadata = JSON.parse(
          form.get("metadata") as string,
        ) as PreviewMetadata;
        const image = form.get("image") as File;
        expect(image.type).toBe("image/png");
        const bytes = Buffer.from(await image.arrayBuffer());
        const hash = createHash("sha256").update(bytes).digest("hex");
        const decoder = sharp(bytes, { limitInputPixels: 16000000 });
        const dimensions = await decoder.metadata();
        await decoder.raw().toBuffer();
        expect(dimensions.width).toBe(metadata.width);
        expect(dimensions.height).toBe(metadata.height);
        expect(metadata.contentHash).toBe(hash);
        expect(metadata.byteLength).toBe(bytes.length);
        expect(metadata.snapshotHash).toBe(source.snapshotHash);
        expect(metadata.revision).toBe(source.revision);
        expect(metadata.sourceInstance).toBe(source.sourceInstance);
        expect(source.rackIds.includes(metadata.rackId)).toBe(true);
        const key = metadata.rackId + ":" + metadata.face;
        const existing = accepted.get(key);
        if (existing) expect(existing).toEqual({ metadata, hash });
        else accepted.set(key, { metadata, hash });
        uploads++;
        if (!lostReply) {
          lostReply = true;
          return Response.json(
            { error: "simulated lost acknowledgement after acceptance" },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          layoutId: metadata.layoutId,
          rackId: metadata.rackId,
          face: metadata.face,
          acceptedRevision: metadata.revision,
          contentHash: hash,
          result: existing ? "unchanged" : "applied",
        });
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "rackula-sihs-http-"));
    try {
      const state = {
        layoutId: source.layoutId,
        revision: source.revision,
        acknowledgedRevision: source.revision,
        acknowledgedHash: source.snapshotHash,
        status: "synced",
        payload: { operation: "upsert" },
      } as DeliveryState;
      const publisher = {
        states: async () => [state],
        status: async () => state,
        previewCapture: async () => source,
      } as unknown as McpflowPublisher;
      const options = {
        directory,
        publisher,
        env: {
          MCPFLOW_PREVIEWS_ENABLED: "true",
          MCPFLOW_INTEGRATION_URL: `http://127.0.0.1:${server.port}/integration`,
          MCPFLOW_INTEGRATION_TOKEN: "test-preview-only",
        },
        now: () => time,
      };
      await new McpflowPreviews(options).tick();
      expect(accepted.size).toBe(4);
      time += 4000000;
      const restarted = new McpflowPreviews(options);
      await restarted.tick();
      expect(uploads).toBe(5);
      expect(
        (await restarted.statuses())[0]!.jobs.every(
          (j) => j.status === "synced",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  300000,
);
