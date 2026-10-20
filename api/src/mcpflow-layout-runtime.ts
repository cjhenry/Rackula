import yaml from "js-yaml";
import { createHash } from "node:crypto";
import { LayoutSchemaBase, LayoutSchema } from "$lib/schemas";
import { assertSchemaVersionSupported } from "$lib/schemas/migrations";
import { adaptLegacyLayout } from "$lib/storage/adapt-legacy-layout-core";
import { toHumanUnits } from "$lib/utils/position";
import { effectiveFace } from "$lib/utils/effective-face";
import { orientDeviceType } from "$lib/utils/device-width";
import { assertYamlComplexityBounded } from "./yaml-safety";
import type { Layout } from "$lib/types";
import type { SyncSnapshot } from "./mcpflow-contract";

const stableId = (value: string) =>
  `sync-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
export function normalizeLayout(
  content: string,
  layoutId: string,
): SyncSnapshot {
  const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  assertYamlComplexityBounded(raw, Buffer.byteLength(content));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Layout must be an object");
  const body = raw as Record<string, unknown>;
  const metadata = body.metadata as { schema_version?: unknown } | undefined;
  assertSchemaVersionSupported(
    typeof metadata?.schema_version === "string"
      ? metadata.schema_version
      : undefined,
  );
  const originalIds = new Set<string>();
  const racks = (
    Array.isArray(body.racks) ? body.racks : body.rack ? [body.rack] : []
  ) as Record<string, unknown>[];
  for (const [index, rack] of racks.entries()) {
    rack.id ??= stableId(`${layoutId}:rack:${index}`);
    for (const device of (rack.devices ?? []) as { id: string }[]) {
      if (originalIds.has(device.id))
        throw new Error(`Duplicate placement ID: ${device.id}`);
      originalIds.add(device.id);
    }
  }
  const base = LayoutSchemaBase.parse(body);
  const adapted = adaptLegacyLayout(base as unknown as Layout);
  // Only newly synthesized carriers get deterministic IDs; source placement IDs stay intact.
  for (const rack of adapted.racks) {
    const remap = new Map<string, string>();
    for (const device of rack.devices) {
      if (!originalIds.has(device.id)) {
        const children = rack.devices
          .filter((child) => child.container_id === device.id)
          .map((child) => child.id)
          .sort();
        remap.set(
          device.id,
          stableId(
            `${layoutId}:${rack.id}:${device.device_type}:${children.join(",")}`,
          ),
        );
      }
    }
    for (const device of rack.devices) {
      device.id = remap.get(device.id) ?? device.id;
      if (device.container_id)
        device.container_id =
          remap.get(device.container_id) ?? device.container_id;
    }
  }
  // Newly created office layouts legitimately have no racks yet. The base schema
  // still validates their fields; placement integrity applies once racks exist.
  const layout = adapted.racks.length ? LayoutSchema.parse(adapted) : adapted;
  const types = new Map(layout.device_types.map((type) => [type.slug, type]));
  const equipment: SyncSnapshot["equipment"] = {};
  for (const rack of layout.racks) {
    for (const device of rack.devices) {
      const type = types.get(device.device_type);
      if (type?.serial_number || type?.asset_tag || type?.notes) {
        equipment[device.id] = {
          serial: type.serial_number ?? "",
          assetTag: type.asset_tag ?? "",
          notes: type.notes ?? "",
          mcpAssetId: null,
        };
      }
    }
  }
  return {
    name: layout.name,
    deviceTypes: layout.device_types.map((type) => ({
      id: type.slug,
      manufacturer: type.manufacturer ?? "",
      model: type.model ?? "",
      slots: [
        ...(type.slots ?? []).map((slot) => ({
          id: slot.id,
          name: slot.name ?? slot.id,
        })),
        ...(type.device_bays ?? []).map((bay) => ({
          id: stableId(`bay:${type.slug}:${bay.name}`),
          name: bay.name,
        })),
      ],
    })),
    racks: layout.racks.map((rack) => ({
      id: rack.id,
      name: rack.name,
      heightU: rack.height,
      startingUnit: rack.starting_unit,
      descending: rack.desc_units,
      devices: rack.devices.map((device) => {
        const type = types.get(device.device_type);
        if (!type)
          throw new Error(`Unknown device type: ${device.device_type}`);
        const parentId = device.container_id || device.parent_device || null;
        const parent = device.parent_device
          ? rack.devices.find((item) => item.id === device.parent_device)
          : undefined;
        if (
          device.parent_device &&
          (!parent ||
            !types
              .get(parent.device_type)
              ?.device_bays?.some((bay) => bay.name === device.device_bay))
        )
          throw new Error(`Unknown legacy parent/bay for ${device.id}`);
        return {
          id: device.id,
          typeId: device.device_type,
          name: device.name ?? type.model ?? device.device_type,
          face: effectiveFace(device, type),
          heightU: orientDeviceType(type, device.rotation).u_height,
          positionU: parentId ? null : toHumanUnits(device.position),
          containerId: parentId,
          slotId: device.container_id
            ? (device.slot_id ?? null)
            : parent
              ? stableId(`bay:${parent.device_type}:${device.device_bay}`)
              : null,
        };
      }),
    })),
    equipment,
    source: {
      version: body.version,
      racks: layout.racks.map((rack) => ({
        id: rack.id,
        devices: rack.devices.map((device) => ({
          id: device.id,
          position: device.position,
          rotation: device.rotation,
          face: device.face,
          container_id: device.container_id,
          slot_id: device.slot_id,
        })),
      })),
    },
  };
}
