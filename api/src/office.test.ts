import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeStore, canAccessClient, canEditClient } from "./office";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("ICT365 client isolation", () => {
  test("denies unassigned and other-client access, including editors", () => {
    const editor = {
      role: "editor",
      clientIds: ["10"],
      disabled: false,
    } as const;
    expect(canAccessClient(editor, "10")).toBe(true);
    expect(canEditClient(editor, "10")).toBe(true);
    expect(canAccessClient(editor, "11")).toBe(false);
    expect(canAccessClient(editor, undefined)).toBe(false);
    expect(canEditClient({ ...editor, role: "viewer" }, "10")).toBe(false);
    expect(canAccessClient({ ...editor, disabled: true }, "10")).toBe(false);
  });

  test("persists concurrent mutations without losing users or assignments", async () => {
    const path = await mkdtemp(join(tmpdir(), "rackula-office-"));
    directories.push(path);
    const store = new OfficeStore(path);
    await store.initialize({ username: "admin", passwordHash: "hash" });
    await Promise.all([
      store.update((state) => {
        state.clients.push({ id: "10", name: "Client A" });
      }),
      store.update((state) => {
        state.clients.push({ id: "11", name: "Client B" });
      }),
    ]);
    expect(
      (await store.read()).clients.map((client) => client.id).sort(),
    ).toEqual(["10", "11"]);
    const reopened = new OfficeStore(path);
    expect((await reopened.read()).users[0]?.username).toBe("admin");
  });

  test("password changes and disabling accounts invalidate existing identities", async () => {
    const path = await mkdtemp(join(tmpdir(), "rackula-office-"));
    directories.push(path);
    const store = new OfficeStore(path);
    await store.initialize({ username: "admin", passwordHash: "hash" });
    const user = (await store.read()).users[0]!;
    const subject = `office:${user.id}:${user.sessionVersion}`;
    expect(await store.resolveUser(subject)).toBeDefined();
    await store.update((state) => {
      state.users[0]!.sessionVersion++;
    });
    expect(await store.resolveUser(subject)).toBeUndefined();
    expect(await store.resolveUser("admin")).toBeUndefined();
  });
});

describe("ICT365 API authorization", () => {
  test("queues real create/save/equipment/move/unassign/delete routes without publishing Documents", async () => {
    const { createApp } = await import("./app");
    const { createSignedAuthSessionToken } = await import("./security");
    const { createFilesystemDriver } =
      await import("./storage/filesystem-driver");
    const { readFile } = await import("node:fs/promises");
    const path = await mkdtemp(join(tmpdir(), "rackula-office-routes-"));
    directories.push(path);
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = path;
    try {
      const secret = "office-route-secret-at-least-32-characters";
      const app = await createApp(
        {
          NODE_ENV: "test",
          DATA_DIR: path,
          RACKULA_OFFICE_ENABLED: "true",
          RACKULA_AUTH_MODE: "local",
          RACKULA_LOCAL_USERNAME: "admin",
          RACKULA_LOCAL_PASSWORD: "route-password-long-enough",
          RACKULA_AUTH_SESSION_SECRET: secret,
          CORS_ORIGIN: "https://rack.example.com",
          RACKULA_TRUST_PROXY: "true",
        },
        { storage: createFilesystemDriver() },
      );
      const store = new OfficeStore(path);
      await store.update((state) => {
        state.clients = [
          { id: "a", name: "A", mcpClientId: 1 },
          { id: "b", name: "B", mcpClientId: 2 },
        ];
        state.sites = [
          { id: "sa", clientId: "a", name: "A site" },
          { id: "sb", clientId: "b", name: "B site" },
        ];
      });
      const user = (await store.read()).users[0]!;
      const headers = {
        Cookie: `rackula_auth_session=${createSignedAuthSessionToken({ sub: `office:${user.id}:1`, role: "admin" }, secret)}`,
        Origin: "https://rack.example.com",
        "Content-Type": "application/json",
        "x-real-ip": "10.0.0.12",
      };
      const created = await app.request("/api/office/layouts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Route test",
          clientId: "a",
          siteId: "sa",
        }),
      });
      expect(created.status).toBe(201);
      const { id } = await created.json();
      const content = await readFile(
        new URL(
          "../../src/tests/fixtures/upgrade-corpus/v0.6.0-single-rack.rackula.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      const saved = await app.request(`/api/layouts/${id}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/yaml" },
        body: `${content}\nmetadata:\n  id: ${id}\n  name: Route test\n  schema_version: '1.1'\n`,
      });
      expect(saved.status).toBe(200);
      const equipment = {
        serial: "EXPLICIT",
        assetTag: "",
        hostname: "",
        managementIp: "",
        installed: "",
        warrantyExpires: "",
        notes: "Retained annotation",
      };
      expect(
        (
          await app.request(`/api/office/layouts/${id}/equipment/dev-switch`, {
            method: "PUT",
            headers,
            body: JSON.stringify(equipment),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/office/layouts/${id}/assignment`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ clientId: "b", siteId: "sb" }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/office/layouts/${id}/assignment`, {
            method: "DELETE",
            headers,
          })
        ).status,
      ).toBe(200);
      const unassigned = await app.request(`/api/office/layouts/${id}`, {
        headers,
      });
      expect((await unassigned.json()).synchronization).toMatchObject({
        revision: 5,
        status: "pending",
      });
      expect(
        (await store.read()).layouts[id]?.equipment["dev-switch"]?.notes,
      ).toBe("Retained annotation");
      expect(
        (
          await app.request(`/api/office/layouts/${id}/assignment`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ clientId: "a", siteId: "sa" }),
          })
        ).status,
      ).toBe(200);
      expect(
        (await app.request(`/api/layouts/${id}`, { method: "DELETE", headers }))
          .status,
      ).toBe(200);
      const journal = JSON.parse(
        await readFile(
          join(path, "office", "mcpflow-sync", `${id}.json`),
          "utf8",
        ),
      );
      expect(journal).toMatchObject({
        revision: 7,
        payload: { operation: "delete" },
      });
      expect((await store.read()).layouts[id]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
    }
  });

  test("enforces client boundaries on both route aliases, images, snapshots, and reports", async () => {
    const { createApp } = await import("./app");
    const { createSignedAuthSessionToken } = await import("./security");
    const path = await mkdtemp(join(tmpdir(), "rackula-office-api-"));
    directories.push(path);
    const layoutA = "11111111-1111-4111-8111-111111111111";
    const layoutB = "22222222-2222-4222-8222-222222222222";
    const { createFilesystemDriver } =
      await import("./storage/filesystem-driver");
    const storage = {
      ...createFilesystemDriver(),
      listLayouts: async () =>
        [layoutA, layoutB].map((id) => ({
          id,
          name: id,
          version: "1",
          updatedAt: new Date().toISOString(),
          rackCount: 1,
          deviceCount: 0,
          valid: true,
        })),
      getLayout: async () => ({
        content: 'version: "1"\nname: Test\nracks: []\n',
        updatedAt: new Date().toISOString(),
      }),
    };
    const secret = "office-test-session-secret-at-least-32-characters";
    const app = await createApp(
      {
        NODE_ENV: "test",
        DATA_DIR: path,
        RACKULA_OFFICE_ENABLED: "true",
        RACKULA_AUTH_MODE: "local",
        RACKULA_LOCAL_USERNAME: "admin",
        RACKULA_LOCAL_PASSWORD: "test-password-long-enough",
        RACKULA_AUTH_SESSION_SECRET: secret,
        CORS_ORIGIN: "https://rack.example.com",
        RACKULA_TRUST_PROXY: "true",
      },
      { storage },
    );
    const store = new OfficeStore(path);
    await store.update((state) => {
      state.clients.push({ id: "a", name: "A" }, { id: "b", name: "B" });
      state.sites.push({ id: "sa", clientId: "a", name: "Site A" });
      state.layouts[layoutA] = { clientId: "a", siteId: "sa", equipment: {} };
      state.layouts[layoutB] = { clientId: "b", siteId: "sb", equipment: {} };
      const root = state.users[0]!;
      state.users.push({
        ...root,
        id: "editor",
        username: "editor",
        role: "editor",
        clientIds: ["a"],
      });
      state.users.push({
        ...root,
        id: "viewer",
        username: "viewer",
        role: "viewer",
        clientIds: ["a"],
      });
    });
    const headers = (subject: string) => ({
      Cookie: `rackula_auth_session=${createSignedAuthSessionToken({ sub: subject, role: "admin" }, secret)}`,
      Origin: "https://rack.example.com",
      "Content-Type": "application/json",
      "x-real-ip": "10.0.0.10",
    });
    const editor = headers("office:editor:1");
    for (const prefix of ["", "/api"]) {
      const list = await app.request(`${prefix}/layouts`, { headers: editor });
      expect(list.status).toBe(200);
      expect(
        (await list.json()).layouts.map((item: { id: string }) => item.id),
      ).toEqual([layoutA]);
      for (const route of [
        `/layouts/${layoutB}`,
        `/layouts/${layoutB}/snapshots`,
        `/layouts/${layoutB}/pre-carrier-backup`,
        `/assets/${layoutB}/device/front`,
        `/office/layouts/${layoutB}`,
      ]) {
        expect(
          (await app.request(prefix + route, { headers: editor })).status,
        ).toBe(403);
      }
    }
    expect(
      (
        await app.request(`/api/layouts/${layoutA}`, {
          method: "DELETE",
          headers: headers("office:viewer:1"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/office/users/new", {
          method: "PUT",
          headers: editor,
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/office/layouts/${layoutA}/assignment`, {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ clientId: "b", siteId: "sb" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/office/layouts/${layoutB}/push`, {
          method: "POST",
          headers: editor,
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const response = await app.request("/api/office", { headers: editor });
    const data = await response.json();
    expect(data.clients.map((item: { id: string }) => item.id)).toEqual(["a"]);
    expect(data.users).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("passwordHash");
    for (const route of [
      "/api/office/sync-backfill",
      `/api/office/layouts/${layoutB}/sync-retry`,
      `/api/office/layouts/${layoutA}/sync-reconcile`,
    ]) {
      expect(
        (
          await app.request(route, {
            method: "POST",
            headers: editor,
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await app.request(`/api/office/layouts/${layoutA}/sync-retry`, {
          method: "POST",
          headers: headers("office:viewer:1"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const deliveryStatus = await app.request("/api/office/sync-status", {
      headers: editor,
    });
    expect(deliveryStatus.status).toBe(200);
    expect(JSON.stringify(await deliveryStatus.json())).not.toContain(
      "passwordHash",
    );
    await store.update((state) => {
      state.users.find((user) => user.id === "editor")!.disabled = true;
    });
    expect((await app.request("/api/office", { headers: editor })).status).toBe(
      401,
    );
    expect(
      (await app.request(`/api/layouts/${layoutA}`, { headers: editor }))
        .status,
    ).toBe(401);
  });
});
