import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeStore } from "./office";
import { McpflowPublisher } from "./mcpflow-publisher";
import type { StorageDriver } from "./storage/driver";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const id = "550e8400-e29b-41d4-a716-446655440000";
async function setup(deliver?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "rackula-publisher-"));
  dirs.push(directory);
  const office = new OfficeStore(directory);
  await office.initialize({ username: "admin", passwordHash: "hash" });
  await office.update((state) => {
    state.clients = [
      { id: "mcp-1", name: "First", mcpClientId: 1 },
      { id: "mcp-2", name: "Second", mcpClientId: 2 },
    ];
    state.sites = [
      { id: "main-1", name: "Main", clientId: "mcp-1" },
      { id: "main-2", name: "Main", clientId: "mcp-2" },
    ];
    state.layouts[id] = { clientId: "mcp-1", siteId: "main-1", equipment: {} };
  });
  const content = await readFile(
    new URL(
      "../../src/tests/fixtures/upgrade-corpus/v0.6.0-single-rack.rackula.yaml",
      import.meta.url,
    ),
    "utf8",
  );
  const data = new Map([[id, { content, updatedAt: "2026-10-20T12:00:00Z" }]]);
  const storage = {
    async getLayout(key: string) {
      return data.get(key) ?? null;
    },
    async listLayouts() {
      return [...data.keys()].map((key) => ({ id: key }));
    },
    async saveLayout(yaml: string, key: string) {
      data.set(key, { content: yaml, updatedAt: new Date().toISOString() });
      return { id: key, isNew: false, updatedAt: new Date().toISOString() };
    },
    async deleteLayout(key: string) {
      return data.delete(key);
    },
  } as unknown as StorageDriver;
  const sent: Record<string, unknown>[] = [];
  const transport =
    deliver ??
    ((async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(init!.body as string);
      sent.push(payload);
      return Response.json({
        ok: true,
        layoutId: id,
        acceptedRevision: payload.revision,
        result: "applied",
        contentHash: "a".repeat(64),
      });
    }) as unknown as typeof fetch);
  const publisher = new McpflowPublisher({
    directory,
    office,
    storage,
    env: {
      MCPFLOW_INTEGRATION_URL: "http://MCPFlow/api/integrations/rackula.php",
      MCPFLOW_INTEGRATION_TOKEN: "secret-token",
      MCPFLOW_SOURCE_INSTANCE: "ict365-rackula",
    },
    fetch: transport,
  });
  await publisher.initialize();
  return {
    publisher,
    directory,
    office,
    storage,
    data,
    sent,
    transport,
    content,
  };
}

describe("durable MCPFlow publisher", () => {
  test("persists and sends deletion tombstones even before an initial backfill", async () => {
    const ctx = await setup();
    await ctx.publisher.mutate(id, { content: null, assignment: null });
    await ctx.publisher.deliver();
    expect(ctx.sent[0]).toMatchObject({ operation: "delete", revision: 1 });
    expect(ctx.data.has(id)).toBe(false);
  });
  test("reconciliation finishes an interrupted source transaction before capturing content or ownership", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    const save = ctx.storage.saveLayout.bind(ctx.storage);
    ctx.storage.saveLayout = async (...args) => {
      await save(...args);
      throw new Error("interrupted after layout write");
    };
    await expect(
      ctx.publisher.mutate(id, {
        content: ctx.content.replace(
          "Old Single-Rack Lab",
          "Coherent recovery",
        ),
        assignment: { clientId: "mcp-2", siteId: "main-2", equipment: {} },
      }),
    ).rejects.toThrow("interrupted after layout write");
    ctx.storage.saveLayout = save;
    await ctx.publisher.reconcile();
    expect((await ctx.publisher.status(id))?.payload).toMatchObject({
      clientId: 2,
      snapshot: { name: "Coherent recovery" },
    });
  });
  test("backfills, confirms unchanged content, and keeps reports separate", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    expect(ctx.sent[0]).toMatchObject({
      action: "sync_layout",
      schemaVersion: 2,
      clientId: 1,
      revision: 1,
    });
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    expect(ctx.sent[1]?.revision).toBe(1);
    expect(
      (await ctx.office.read()).layouts[id]?.mcpDocumentId,
    ).toBeUndefined();
    expect((await ctx.publisher.status(id))?.status).toBe("synced");
  });

  test("retains the exact revision after a lost acknowledgement across restart", async () => {
    let calls = 0;
    const ctx = await setup((async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls++;
      if (calls === 1) throw new Error("lost acknowledgement secret-token");
      const value = JSON.parse(init!.body as string);
      return Response.json({
        ok: true,
        layoutId: id,
        acceptedRevision: value.revision,
        result: "unchanged",
        contentHash: "b".repeat(64),
      });
    }) as unknown as typeof fetch);
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    const pending = await ctx.publisher.status(id);
    expect(pending?.error).not.toContain("secret-token");
    const reopened = new McpflowPublisher({
      directory: ctx.directory,
      office: ctx.office,
      storage: ctx.storage,
      env: {
        MCPFLOW_INTEGRATION_URL: "http://MCPFlow/api/integrations/rackula.php",
        MCPFLOW_INTEGRATION_TOKEN: "secret-token",
      },
      fetch: ctx.transport,
    });
    await reopened.initialize();
    await reopened.retry(id);
    await reopened.deliver();
    expect((await reopened.status(id))?.acknowledgedRevision).toBe(1);
    expect((await reopened.status(id))?.status).toBe("synced");
  });

  test("an old response cannot acknowledge a concurrent new edit", async () => {
    let release!: (response: Response) => void;
    const ctx = await setup(
      (async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })) as unknown as typeof fetch,
    );
    await ctx.publisher.reconcile();
    const delivery = ctx.publisher.deliver();
    while (!release) await Bun.sleep(1);
    await ctx.publisher.mutate(id, {
      content: ctx.content.replace("Old Single-Rack Lab", "Edited layout"),
    });
    release(
      Response.json({
        ok: true,
        layoutId: id,
        acceptedRevision: 1,
        result: "applied",
        contentHash: "a".repeat(64),
      }),
    );
    await delivery;
    expect(await ctx.publisher.status(id)).toMatchObject({
      revision: 2,
      status: "pending",
    });
  });

  test("journals deletion before discarding data and recovers interrupted source commits", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    const original = ctx.storage.deleteLayout;
    ctx.storage.deleteLayout = async () => {
      throw new Error("process interrupted");
    };
    await expect(
      ctx.publisher.mutate(id, { content: null, assignment: null }),
    ).rejects.toThrow("process interrupted");
    expect(ctx.data.has(id)).toBe(true);
    ctx.storage.deleteLayout = original;
    await ctx.publisher.initialize();
    await ctx.publisher.deliver();
    expect(ctx.data.has(id)).toBe(false);
    expect(ctx.sent.at(-1)).toMatchObject({ operation: "delete", revision: 2 });
    expect(ctx.sent.at(-1)?.snapshot).toBeUndefined();
  });

  test("unassignment tombstones and reassignment retains global identity with increasing revisions", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    await ctx.publisher.mutate(id, {
      assignment: { clientId: "", siteId: "", equipment: {} },
    });
    await ctx.publisher.deliver();
    expect(ctx.sent.at(-1)).toMatchObject({ operation: "delete", revision: 2 });
    await ctx.publisher.mutate(id, {
      assignment: { clientId: "mcp-2", siteId: "main-2", equipment: {} },
    });
    await ctx.publisher.deliver();
    expect(ctx.sent.at(-1)).toMatchObject({
      operation: "upsert",
      revision: 3,
      clientId: 2,
      layoutId: id,
    });
  });

  test("failed scans never infer deletions", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    ctx.storage.listLayouts = async () => {
      throw new Error("incomplete scan");
    };
    await expect(ctx.publisher.reconcile()).rejects.toThrow("incomplete scan");
    expect((await ctx.publisher.status(id))?.payload?.operation).toBe("upsert");
  });

  test("superseded delivery blocks until explicit coherent revision-floor reconciliation", async () => {
    let superseded = true;
    const ctx = await setup((async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(init!.body as string);
      return Response.json({
        ok: true,
        layoutId: id,
        acceptedRevision: superseded ? 20 : payload.revision,
        result: superseded ? "superseded" : "applied",
        contentHash: "a".repeat(64),
      });
    }) as unknown as typeof fetch);
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    expect(await ctx.publisher.status(id)).toMatchObject({
      status: "reconcile_required",
      receiverRevision: 20,
    });
    await ctx.publisher.retry(id);
    await ctx.publisher.deliver();
    expect((await ctx.publisher.status(id))?.status).toBe("reconcile_required");
    superseded = false;
    await ctx.publisher.reconcileFloor(id, 20);
    await ctx.publisher.deliver();
    expect(await ctx.publisher.status(id)).toMatchObject({
      status: "synced",
      revision: 21,
    });
  });

  test("permanent errors stop retries and redact receiver echoes of credentials", async () => {
    let calls = 0;
    const ctx = await setup((async () => {
      calls++;
      return Response.json(
        { error: "Asset ownership failure secret-token" },
        { status: 422 },
      );
    }) as unknown as typeof fetch);
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    await ctx.publisher.deliver();
    expect(calls).toBe(1);
    expect((await ctx.publisher.status(id))?.error).toContain(
      "Asset ownership failure",
    );
    expect((await ctx.publisher.status(id))?.error).not.toContain(
      "secret-token",
    );
  });

  test("honors Retry-After and sends credentials only with redirect rejection and a timeout", async () => {
    let calls = 0;
    const started = Date.now();
    const ctx = await setup((async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls++;
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(
        { error: "Busy" },
        { status: 429, headers: { "Retry-After": "120" } },
      );
    }) as unknown as typeof fetch);
    await ctx.publisher.reconcile();
    await ctx.publisher.deliver();
    await ctx.publisher.deliver();
    expect(calls).toBe(1);
    expect(
      (await ctx.publisher.status(id))?.nextAttemptAt,
    ).toBeGreaterThanOrEqual(started + 120000);
  });

  test("oversized payloads fail visibly without truncation or transmission", async () => {
    const ctx = await setup();
    await ctx.publisher.mutateAssignment(id, (current) => ({
      ...current!,
      equipment: {
        "dev-switch": {
          serial: "",
          assetTag: "",
          hostname: "",
          managementIp: "",
          installed: "",
          warrantyExpires: "",
          notes: "x".repeat(1048576),
        },
      },
    }));
    await ctx.publisher.deliver();
    expect(ctx.sent).toEqual([]);
    expect(await ctx.publisher.status(id)).toMatchObject({ status: "error" });
    expect((await ctx.publisher.status(id))?.error).toContain("1 MiB");
    expect(
      (await ctx.office.read()).layouts[id]?.equipment["dev-switch"]?.notes,
    ).toBe("x".repeat(1048576));
  });

  test("serializes concurrent equipment edits and source saves without losing either", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    const annotate = (deviceId: string) =>
      ctx.publisher.mutateAssignment(id, (current) => ({
        ...current!,
        equipment: {
          ...current!.equipment,
          [deviceId]: {
            serial: deviceId,
            assetTag: "",
            hostname: "",
            managementIp: "",
            installed: "",
            warrantyExpires: "",
            notes: "",
          },
        },
      }));
    await Promise.all([
      annotate("dev-switch"),
      annotate("dev-server"),
      ctx.publisher.mutate(id, {
        content: ctx.content.replace("Old Single-Rack Lab", "Concurrent edit"),
      }),
    ]);
    await ctx.publisher.deliver();
    expect(
      (await ctx.office.read()).layouts[id]?.equipment["dev-switch"]?.serial,
    ).toBe("dev-switch");
    expect(
      (await ctx.office.read()).layouts[id]?.equipment["dev-server"]?.serial,
    ).toBe("dev-server");
    expect((await ctx.publisher.status(id))?.revision).toBe(4);
    expect(ctx.sent.at(-1)?.snapshot).toMatchObject({
      name: "Concurrent edit",
      equipment: {
        "dev-switch": { serial: "dev-switch" },
        "dev-server": { serial: "dev-server" },
      },
    });
  });

  test("refuses to move explicit asset links to another client, including after unassignment", async () => {
    const ctx = await setup();
    await ctx.publisher.mutateAssignment(id, (current) => ({
      ...current!,
      equipment: {
        "dev-switch": {
          serial: "",
          assetTag: "",
          hostname: "",
          managementIp: "",
          installed: "",
          warrantyExpires: "",
          notes: "",
          mcpAssetId: 123,
        },
      },
    }));
    await ctx.publisher.mutateAssignment(id, (current) => ({
      ...current!,
      clientId: "",
      siteId: "",
    }));
    await expect(
      ctx.publisher.mutateAssignment(id, (current) => ({
        ...current!,
        clientId: "mcp-2",
        siteId: "main-2",
      })),
    ).rejects.toThrow("Clear explicit MCPFlow asset links");
  });

  test("recovers a real process exit after journal persistence and before a source write", async () => {
    const ctx = await setup();
    await ctx.publisher.reconcile();
    const script = `
      import { McpflowPublisher } from ${JSON.stringify(new URL("./mcpflow-publisher.ts", import.meta.url).pathname)};
      import { OfficeStore } from ${JSON.stringify(new URL("./office.ts", import.meta.url).pathname)};
      const directory=process.env.CRASH_TEST_DIR;
      const source=process.env.CRASH_TEST_CONTENT;
      const storage={getLayout:async()=>({content:source,updatedAt:"2026-10-20T12:00:00Z"}),saveLayout:async()=>process.exit(23)};
      const publisher=new McpflowPublisher({directory,office:new OfficeStore(directory),storage,env:{}});
      await publisher.initialize();
      await publisher.mutate(${JSON.stringify(id)},{content:source.replace("Old Single-Rack Lab","Recovered process edit")});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        CRASH_TEST_DIR: ctx.directory,
        CRASH_TEST_CONTENT: ctx.content,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(23);
    const reopened = new McpflowPublisher({
      directory: ctx.directory,
      office: new OfficeStore(ctx.directory),
      storage: ctx.storage,
      env: {
        MCPFLOW_INTEGRATION_URL: "http://MCPFlow/api/integrations/rackula.php",
        MCPFLOW_INTEGRATION_TOKEN: "secret-token",
      },
      fetch: ctx.transport,
    });
    await reopened.initialize();
    await reopened.deliver();
    expect(ctx.data.get(id)?.content).toContain("Recovered process edit");
    expect(await reopened.status(id)).toMatchObject({
      revision: 2,
      status: "synced",
    });
  });
});
