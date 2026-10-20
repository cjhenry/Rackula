import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import yaml from "js-yaml";
import { renderPreviewProcess } from "./mcpflow-preview-render";
import { migrateLayout } from "./mcpflow-normalizer.js";
import type { PreviewInput } from "./mcpflow-preview-types";
const id = "550e8400-e29b-41d4-a716-446655440000";
async function input(
  name = "v0.6.0-single-rack.rackula.yaml",
): Promise<PreviewInput> {
  const content = await readFile(
    new URL(`../../src/tests/fixtures/upgrade-corpus/${name}`, import.meta.url),
    "utf8",
  );
  return {
    content,
    layoutId: id,
    revision: 42,
    snapshotHash: "a".repeat(64),
    sourceInstance: "ict365-rackula",
    assets: [],
    rackIds: migrateLayout(content, id).racks.map((r) => r.id),
  };
}
describe.skipIf(process.env.RACKULA_PREVIEW_RENDER_TESTS !== "true")(
  "real server-side export renderer",
  () => {
    test("renders front and rear PNGs with the existing saved-layout export utilities", async () => {
      const source = await input();
      const raw = yaml.load(source.content) as {
        device_types: { is_full_depth: boolean }[];
      };
      raw.device_types[0]!.is_full_depth = false;
      source.content = yaml.dump(raw);
      const front = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      const rear = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "rear",
      );
      for (const result of [front, rear]) {
        const info = await sharp(Buffer.from(result.png, "base64")).metadata();
        expect(info.format).toBe("png");
        expect(info.width).toBe(result.width);
        expect(info.height).toBe(result.height);
        expect(result.height).toBeGreaterThan(100);
      }
      expect(front.png === rear.png).toBe(false);
    }, 60000);
    test("uploaded and embedded rasters change the drawing; invalid and external images use labels", async () => {
      const source = await input();
      const layout = migrateLayout(source.content, id);
      const first = layout.racks[0]!.devices[0]!;
      const saved = yaml.load(source.content) as {
        rack: { devices: { front_image?: string }[] };
      };
      saved.rack.devices[0]!.front_image = "saved-custom.png";
      source.content = yaml.dump(saved);
      const original = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      const png = await sharp({
        create: { width: 200, height: 20, channels: 3, background: "#ff00ff" },
      })
        .png()
        .toBuffer();
      source.assets = [
        {
          key: first.id,
          face: "front",
          mimeType: "image/png",
          data: png.toString("base64"),
        },
      ];
      const custom = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      expect(custom.png === original.png).toBe(false);
      source.assets = [];
      const raw = yaml.load(source.content) as Record<string, unknown>;
      raw.images = {
        [`placement-${first.id}`]: {
          front: `data:image/png;base64,${png.toString("base64")}`,
        },
      };
      source.content = yaml.dump(raw);
      const embedded = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      expect(embedded.png === custom.png).toBe(true);
      raw.images = {
        bad: { front: "http://169.254.169.254/latest/meta-data" },
      };
      source.content = yaml.dump(raw);
      source.assets = [
        {
          key: first.id,
          face: "front",
          mimeType: "image/png",
          data: Buffer.from("not an image").toString("base64"),
        },
      ];
      const missing = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      expect(missing.warnings.length).toBeGreaterThan(0);
      expect(missing.png === original.png).toBe(true);
    }, 60000);
    test("empty racks and migrated container placements render without inventing rail positions", async () => {
      const source = await input();
      const raw = yaml.load(source.content) as { rack: { devices: unknown[] } };
      raw.rack.devices = [];
      source.content = yaml.dump(raw);
      const empty = await renderPreviewProcess(
        source,
        source.rackIds[0]!,
        "front",
      );
      expect(empty.width).toBeGreaterThan(0);
      const container = await input("pre-carrier-slot-position.rackula.yaml");
      const layout = migrateLayout(container.content, id);
      const child = layout.racks[0]!.devices.find((d) => d.id === "rb-left")!;
      expect(child.container_id).toBeTruthy();
      expect(child.slot_id).toBe("col-1");
      const preview = await renderPreviewProcess(
        container,
        container.rackIds[0]!,
        "front",
      );
      expect(preview.png.length).toBeGreaterThan(100);
    }, 60000);
    test("oversized source images are bounded and fail independently of snapshot synchronization", async () => {
      const source = await input();
      const saved = yaml.load(source.content) as {
        rack: { devices: { id: string; front_image?: string }[] };
      };
      saved.rack.devices[0]!.front_image = "large.png";
      source.content = yaml.dump(saved);
      source.assets = [
        {
          key: saved.rack.devices[0]!.id,
          face: "front",
          mimeType: "image/png",
          data: "A".repeat(24 * 1024 * 1024),
        },
      ];
      await expect(
        renderPreviewProcess(source, source.rackIds[0]!, "front"),
      ).rejects.toThrow("16 MiB");
    }, 20000);
  },
);
