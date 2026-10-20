/** Isolated process: receives frozen source only, with no integration credentials. */
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import sharp from "sharp";
import yaml from "js-yaml";
import { migrateLayout } from "./mcpflow-normalizer.js";
import { detectImageMime } from "./storage/asset-validation";
import type { PreviewInput, PreviewFace } from "./mcpflow-preview-types";

export async function renderFrozen(
  input: PreviewInput,
  rackId: string,
  face: PreviewFace,
) {
  const layout = migrateLayout(input.content, input.layoutId);
  if (
    layout.racks.length > 100 ||
    layout.racks.some((r) => r.height > 100 || r.devices.length > 2000)
  )
    throw new Error("Preview layout exceeds rack/device bounds");
  const warnings: string[] = [];
  const sources = new Map<
    string,
    { key: string; face: PreviewFace; data: string; mimeType: string }
  >();
  const raw = yaml.load(input.content, { schema: yaml.JSON_SCHEMA }) as {
    images?: Record<string, { front?: string; rear?: string }>;
  };
  for (const [key, faces] of Object.entries(raw.images ?? {})) {
    for (const direction of ["front", "rear"] as const) {
      const ref = faces?.[direction];
      if (typeof ref !== "string") continue;
      const match =
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(ref);
      if (match)
        sources.set(`${key}:${direction}`, {
          key,
          face: direction,
          data: match[2]!,
          mimeType: match[1]!,
        });
      else warnings.push(`Unavailable embedded image: ${key}/${direction}`);
    }
  }
  for (const image of input.assets) {
    const device = layout.racks
      .flatMap((rack) => rack.devices)
      .find((device) =>
        [
          device.id,
          `placement-${device.id}`,
          `placement-${input.layoutId}:${device.id}`,
        ].includes(image.key),
      );
    const type = layout.device_types.find((type) => type.slug === image.key);
    if (device?.[`${image.face}_image`] || type?.[`${image.face}_image`])
      sources.set(`${image.key}:${image.face}`, image);
  }
  if (sources.size > 1000)
    throw new Error("Preview source exceeds 1,000 images");
  let total = 0;
  let decodedPixels = 0;
  const images: { key: string; face: PreviewFace; dataUrl: string }[] = [];
  for (const image of sources.values()) {
    total += Math.ceil((image.data.length * 3) / 4);
    if (total > 16 * 1024 * 1024)
      throw new Error("Preview source images exceed 16 MiB");
    try {
      if (image.data.length > 7 * 1024 * 1024)
        throw new Error("Image exceeds 5 MiB");
      const bytes = Buffer.from(image.data, "base64");
      if (
        bytes.length > 5 * 1024 * 1024 ||
        detectImageMime(bytes) !== image.mimeType
      )
        throw new Error("Invalid image type or length");
      const decoder = sharp(bytes, {
        limitInputPixels: 16000000,
        failOn: "warning",
      });
      const info = await decoder.metadata();
      if (
        (info.pages ?? 1) !== 1 ||
        !info.width ||
        !info.height ||
        info.width > 8192 ||
        info.height > 8192
      )
        throw new Error("Image dimensions exceed limits");
      decodedPixels += info.width * info.height;
      if (decodedPixels > 64000000)
        throw new Error("Aggregate source decode budget exceeded");
      const normalized = await decoder
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      images.push({
        key: image.key,
        face: image.face,
        dataUrl: `data:image/png;base64,${normalized.toString("base64")}`,
      });
    } catch {
      warnings.push(
        `Unavailable image: ${image.key}/${image.face}; using bundled image or label`,
      );
    }
  }
  for (const rack of layout.racks.filter((rack) => rack.id === rackId))
    for (const device of rack.devices)
      for (const direction of [face]) {
        if (
          device[`${direction}_image`] &&
          !images.some(
            (i) =>
              i.face === direction &&
              [
                device.id,
                `placement-${device.id}`,
                `placement-${input.layoutId}:${device.id}`,
              ].includes(i.key),
          )
        )
          warnings.push(
            `Missing uploaded image: ${device.id}/${direction}; using bundled image or label`,
          );
      }
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MCPFLOW_CHROMIUM_EXECUTABLE || undefined,
    args: [
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  try {
    const context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const scriptErrors: string[] = [];
    page.on("pageerror", (error) => scriptErrors.push(error.message));
    await page.setContent(
      "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'\">",
    );
    await page.addScriptTag({
      content: await readFile(
        new URL("./mcpflow-preview-browser.js", import.meta.url),
        "utf8",
      ),
    });
    if (scriptErrors.length) throw new Error(scriptErrors.join("; "));
    const result = await page.evaluate(
      async (data) => {
        const renderer = (
          globalThis as unknown as {
            renderPreview: (
              data: unknown,
            ) => Promise<{ png: string; width: number; height: number }>;
          }
        ).renderPreview;
        return renderer(data);
      },
      { layout, layoutId: input.layoutId, rackId, face, images },
    );
    return { ...result, warnings: warnings.slice(0, 100) };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  try {
    const data = JSON.parse(await Bun.file(process.argv[2]!).text()) as {
      input: PreviewInput;
      rackId: string;
      face: PreviewFace;
    };
    await Bun.write(
      process.argv[3]!,
      JSON.stringify(await renderFrozen(data.input, data.rackId, data.face)),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Preview rendering failed",
    );
    process.exitCode = 1;
  }
}
