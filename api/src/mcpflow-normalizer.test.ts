import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { normalizeLayout } from "./mcpflow-normalizer.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const corpus = new URL(
  "../../src/tests/fixtures/upgrade-corpus/",
  import.meta.url,
);

describe("MCPFlow normalized layout export", () => {
  test("migrates legacy rail positions and uses effective front/rear occupancy", async () => {
    const yaml = await readFile(
      new URL("v0.6.0-single-rack.rackula.yaml", corpus),
      "utf8",
    );
    const snapshot = normalizeLayout(yaml, id);
    const rack = snapshot.racks[0]!;
    expect(
      rack.devices.find((device) => device.id === "dev-switch"),
    ).toMatchObject({ positionU: 5, heightU: 1, face: "both" });
    expect(
      rack.devices.find((device) => device.id === "dev-server"),
    ).toMatchObject({ positionU: 10, heightU: 2 });
  });

  test("migrates carriers with stable identities and explicit slots across repeated exports", async () => {
    const yaml = await readFile(
      new URL("pre-carrier-slot-position.rackula.yaml", corpus),
      "utf8",
    );
    const first = normalizeLayout(yaml, id);
    expect(normalizeLayout(yaml, id)).toEqual(first);
    const child = first.racks[0]!.devices.find(
      (device) => device.id === "rb-left",
    )!;
    expect(child.positionU).toBeNull();
    expect(child.slotId).toBe("col-1");
    expect(
      first.racks[0]!.devices.find((device) => device.id === child.containerId)
        ?.positionU,
    ).toBe(40);
  });

  test("preserves numbering, half-depth faces and explicit source serial annotations", async () => {
    const yaml = (
      await readFile(new URL("v0.6.0-single-rack.rackula.yaml", corpus), "utf8")
    )
      .replace("desc_units: false", "desc_units: true")
      .replace("starting_unit: 1", "starting_unit: 25")
      .replace(
        'slug: "switch-1u"',
        'slug: "switch-1u"\n    is_full_depth: false\n    serial_number: "SOURCE-SERIAL"\n    asset_tag: "SOURCE-TAG"',
      );
    const snapshot = normalizeLayout(yaml, id);
    expect(snapshot.racks[0]).toMatchObject({
      startingUnit: 25,
      descending: true,
    });
    expect(
      snapshot.racks[0]!.devices.find((device) => device.id === "dev-switch"),
    ).toMatchObject({ positionU: 5, face: "front" });
    expect(snapshot.equipment["dev-switch"]).toMatchObject({
      serial: "SOURCE-SERIAL",
      assetTag: "SOURCE-TAG",
      mcpAssetId: null,
    });
  });

  test("real normalized legacy and container payloads satisfy the deployed PHP contract", async () => {
    const receiver = process.env.MCPFLOW_CONTRACT_HELPER;
    if (!receiver) return;
    for (const name of [
      "v0.6.0-single-rack.rackula.yaml",
      "pre-carrier-slot-position.rackula.yaml",
      "v26.9.2-duplicate-slot-ids.rackula.yaml",
    ]) {
      const snapshot = normalizeLayout(
        await readFile(new URL(name, corpus), "utf8"),
        id,
      );
      const payload = {
        action: "sync_layout",
        schemaVersion: 2,
        sourceInstance: "ict365-rackula",
        layoutId: id,
        revision: 1,
        operation: "upsert",
        sourceUpdatedAt: "2026-10-20T12:00:00Z",
        clientId: 1,
        snapshot,
      };
      const result = spawnSync(
        "php",
        [
          "-r",
          `require $argv[1]; $event=rackulaNormalize((array)json_decode(stream_get_contents(STDIN)), 'ict365-rackula'); echo $event['contentHash'];`,
          receiver,
        ],
        { input: JSON.stringify(payload), encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
