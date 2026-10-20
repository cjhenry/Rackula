import { generateExportSVG } from "$lib/utils/export/svg";
import { exportAsPNG } from "$lib/utils/export/raster";
import { inlineImageHrefs } from "$lib/utils/export/inline-images";
import { getBundledImage } from "$lib/data/bundledImages";
import { placementKey } from "$lib/utils/placement-key";
import type { Layout } from "$lib/types";
import type { ImageStoreMap } from "$lib/types/images";

export async function renderPreview(input: {
  layout: Layout;
  layoutId: string;
  rackId: string;
  face: "front" | "rear";
  images: { key: string; face: "front" | "rear"; dataUrl: string }[];
}) {
  const rack = input.layout.racks.find((r) => r.id === input.rackId);
  if (!rack) throw new Error("Rack missing from migrated saved layout");
  const images: ImageStoreMap = new Map();
  for (const type of input.layout.device_types) {
    const bundled = {
      front: getBundledImage(type.slug, "front"),
      rear: getBundledImage(type.slug, "rear"),
    };
    if (bundled)
      images.set(
        type.slug,
        Object.fromEntries(
          Object.entries(bundled)
            .filter(([, url]) => !!url)
            .map(([face, url]) => [
              face,
              { url, filename: `${type.slug}-${face}.webp` },
            ]),
        ),
      );
  }
  for (const image of input.images) {
    const device = rack.devices.find(
      (d) =>
        d.id === image.key ||
        `placement-${d.id}` === image.key ||
        placementKey(input.layoutId, d.id) === image.key,
    );
    const key = device ? placementKey(input.layoutId, device.id) : image.key;
    const entry = images.get(key) ?? {};
    entry[image.face] = {
      dataUrl: image.dataUrl,
      filename: "preview-source.png",
    };
    images.set(key, entry);
  }
  const svg = generateExportSVG(
    [rack],
    input.layout.device_types,
    {
      format: "png",
      scope: "all",
      includeNames: true,
      includeLegend: false,
      includeQR: false,
      background: "light",
      displayMode: "image-label",
      exportView: input.face,
    },
    images,
    undefined,
    input.layoutId,
  );
  // Every href is compiled bundled data or a server-validated raster, never a source URL.
  for (const image of Array.from(svg.querySelectorAll("image"))) {
    if (
      !/^data:image\/(png|jpeg|webp);base64,/.test(
        image.getAttribute("href") ?? "",
      )
    )
      throw new Error("Untrusted image reference blocked");
  }
  await inlineImageHrefs(svg);
  const width = Number(svg.getAttribute("width")),
    height = Number(svg.getAttribute("height"));
  const scale = Math.min(
    2,
    8192 / width,
    8192 / height,
    Math.sqrt(16000000 / (width * height)),
  );
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Invalid export dimensions");
  const blob = await exportAsPNG(svg, scale);
  if (blob.size > 4194304)
    throw new Error("Rendered PNG exceeds 4 MiB; reduce rack complexity");
  const data = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < data.length; i += 8192)
    binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return {
    png: btoa(binary),
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  };
}
Object.assign(globalThis, { renderPreview });
