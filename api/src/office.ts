import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import yaml from "js-yaml";
import type { StorageDriver, StorageVariables } from "./storage/driver";
import type { AuthSessionClaims, EnvMap } from "./security";
import {
  hashPassword,
  verifyPasswordHash,
  type LocalCredentials,
} from "./local-auth";

const roleSchema = z.enum(["admin", "editor", "viewer"]);
const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const text = (max = 255) => z.string().trim().max(max);
const clientSchema = z.object({
  id: idSchema,
  name: text(200).min(1),
  mcpClientId: z.number().int().positive().optional(),
});
const siteSchema = z.object({
  id: idSchema,
  clientId: idSchema,
  name: text(200).min(1),
  address: text(1000).optional(),
  mcpLocationId: z.number().int().positive().optional(),
});
const equipmentSchema = z.object({
  serial: text(),
  assetTag: text(),
  hostname: text(),
  managementIp: text(),
  installed: z.union([z.literal(""), z.iso.date()]),
  warrantyExpires: z.union([z.literal(""), z.iso.date()]),
  notes: text(5000),
  mcpAssetId: z.number().int().positive().optional(),
});
const userInputSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9@._-]+$/),
  name: text(200).min(1),
  role: roleSchema,
  clientIds: z.array(idSchema).max(1000),
  disabled: z.boolean(),
  password: z.string().min(12).max(1024).optional(),
});
export type Client = z.infer<typeof clientSchema>;
export type Site = z.infer<typeof siteSchema>;
export type Equipment = z.infer<typeof equipmentSchema>;
export interface OfficeUser {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
  role: z.infer<typeof roleSchema>;
  clientIds: string[];
  disabled: boolean;
  sessionVersion: number;
}
export interface Assignment {
  clientId: string;
  siteId: string;
  equipment: Record<string, Equipment>;
  lastPushedAt?: string;
  mcpDocumentId?: number;
}
export interface OfficeState {
  version: 1;
  users: OfficeUser[];
  clients: Client[];
  sites: Site[];
  layouts: Record<string, Assignment>;
}
type Principal = {
  role: string;
  clientIds: readonly string[];
  disabled: boolean;
};
export function canAccessClient(user: Principal, clientId?: string): boolean {
  return (
    !user.disabled &&
    (user.role === "admin" || (!!clientId && user.clientIds.includes(clientId)))
  );
}
export function canEditClient(user: Principal, clientId?: string): boolean {
  return (
    canAccessClient(user, clientId) &&
    (user.role === "admin" || user.role === "editor")
  );
}
function publicUser(user: OfficeUser) {
  const { passwordHash: _hash, sessionVersion: _version, ...safe } = user;
  return safe;
}
export class OfficeStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly filename: string;
  constructor(private directory: string) {
    this.filename = join(directory, "office", "registry.json");
  }
  async read(): Promise<OfficeState> {
    await this.tail;
    const value = JSON.parse(
      await readFile(this.filename, "utf8"),
    ) as OfficeState;
    if (value.version !== 1 || !Array.isArray(value.users))
      throw new Error("Unsupported ICT365 registry");
    return value;
  }
  async initialize(credentials: LocalCredentials) {
    await mkdir(join(this.directory, "office"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state: OfficeState = {
        version: 1,
        clients: [],
        sites: [],
        layouts: {},
        users: [
          {
            id: randomUUID(),
            username: credentials.username,
            name: credentials.username,
            passwordHash: credentials.passwordHash,
            role: "admin",
            clientIds: [],
            disabled: false,
            sessionVersion: 1,
          },
        ],
      };
      await writeFile(this.filename, JSON.stringify(state, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    }
  }
  update<T>(mutate: (state: OfficeState) => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      const state = JSON.parse(
        await readFile(this.filename, "utf8"),
      ) as OfficeState;
      const result = await mutate(state);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      await rename(temporary, this.filename);
      return result;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  async resolveUser(subject: string): Promise<OfficeUser | undefined> {
    const state = await this.read();
    return state.users.find(
      (user) =>
        !user.disabled &&
        (subject === `office:${user.id}:${user.sessionVersion}` ||
          (user.sessionVersion === 1 && subject === user.username)),
    );
  }
  async authenticate(username: string, password: string) {
    const state = await this.read();
    const user = state.users.find(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    const fallbackHash = state.users[0]!.passwordHash;
    const valid = await verifyPasswordHash(
      user?.passwordHash ?? fallbackHash,
      password,
    );
    return valid && user && !user.disabled ? user : undefined;
  }
}
type OfficeEnv = {
  Variables: StorageVariables & {
    authClaims: AuthSessionClaims | undefined;
    officeUser: OfficeUser;
  };
};
function requireAdmin(user: OfficeUser) {
  if (user.role !== "admin")
    throw new HTTPException(403, { message: "Administrator access required" });
}
function requireClient(user: OfficeUser, clientId?: string, write = false) {
  if (
    !(write ? canEditClient(user, clientId) : canAccessClient(user, clientId))
  )
    throw new HTTPException(403, {
      message: "Access to this client is not permitted",
    });
}
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HTTPException(400, {
      message: result.error.issues.map((issue) => issue.message).join("; "),
    });
  return result.data;
}
function parseLayout(content: string): Record<string, unknown> {
  return yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<
    string,
    unknown
  >;
}

export async function createOffice(
  env: EnvMap,
  credentials: LocalCredentials,
  storage: StorageDriver,
) {
  const store = new OfficeStore(env.DATA_DIR ?? "./data");
  await store.initialize(credentials);
  const middleware: MiddlewareHandler<OfficeEnv> = async (c, next) => {
    const claims = c.get("authClaims");
    const user = claims ? await store.resolveUser(claims.sub) : undefined;
    if (!user)
      return c.json(
        { error: "Session expired or account disabled. Sign in again." },
        401,
      );
    c.set("officeUser", user);
    c.header("Cache-Control", "private, no-store");
    const path = c.req.path.replace(/^\/api(?=\/)/, "");
    const resource = /^\/(layouts|assets)(?:\/([^/]+))?/.exec(path);
    if (resource) {
      const state = await store.read();
      const layoutId = resource[2];
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (layoutId)
        requireClient(user, state.layouts[layoutId]?.clientId, write);
      else if (write) requireAdmin(user);
      c.set(
        "storage",
        new Proxy(storage, {
          get(target, key) {
            if (key === "listLayouts")
              return async () =>
                (await target.listLayouts()).filter((layout) =>
                  canAccessClient(user, state.layouts[layout.id]?.clientId),
                );
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
    }
    await next();
    c.header("Cache-Control", "private, no-store");
    return;
  };

  const routes = new Hono<OfficeEnv>();
  routes.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );
  routes.get("/", async (c) => {
    const state = await store.read();
    const user = c.get("officeUser");
    const layouts = (await storage.listLayouts()).filter((item) =>
      canAccessClient(user, state.layouts[item.id]?.clientId),
    );
    return c.json({
      user: publicUser(user),
      clients: state.clients.filter((item) => canAccessClient(user, item.id)),
      sites: state.sites.filter((item) => canAccessClient(user, item.clientId)),
      layouts: layouts.map((item) => ({
        ...item,
        assignment: state.layouts[item.id] ?? null,
      })),
      users: user.role === "admin" ? state.users.map(publicUser) : [],
      mcpflowUrl: env.MCPFLOW_PUBLIC_URL ?? "https://mcpflow.ict365.ky",
      integrationEnabled:
        !!env.MCPFLOW_INTEGRATION_TOKEN && !!env.MCPFLOW_INTEGRATION_URL,
    });
  });
  routes.post("/clients", async (c) => {
    requireAdmin(c.get("officeUser"));
    const input = valid(clientSchema.omit({ id: true }), await c.req.json());
    const client = { ...input, id: randomUUID() };
    await store.update((state) => {
      state.clients.push(client);
    });
    return c.json(client, 201);
  });
  routes.post("/sites", async (c) => {
    requireAdmin(c.get("officeUser"));
    const input = valid(siteSchema.omit({ id: true }), await c.req.json());
    const site = { ...input, id: randomUUID() };
    await store.update((state) => {
      if (!state.clients.some((item) => item.id === site.clientId))
        throw new HTTPException(400, { message: "Client does not exist" });
      state.sites.push(site);
    });
    return c.json(site, 201);
  });
  routes.put("/users/:id", async (c) => {
    const current = c.get("officeUser");
    requireAdmin(current);
    const input = valid(userInputSchema, await c.req.json());
    const id = c.req.param("id");
    const passwordHash = input.password
      ? await hashPassword(input.password)
      : undefined;
    const result = await store.update((state) => {
      const existing = state.users.find((item) => item.id === id);
      if (!existing && id !== "new")
        throw new HTTPException(404, { message: "User not found" });
      if (!existing && !passwordHash)
        throw new HTTPException(400, {
          message: "Password is required for a new user",
        });
      if (
        state.users.some(
          (item) =>
            item.id !== id &&
            item.username.toLowerCase() === input.username.toLowerCase(),
        )
      )
        throw new HTTPException(409, { message: "Username already exists" });
      if (
        input.clientIds.some(
          (clientId) => !state.clients.some((item) => item.id === clientId),
        )
      )
        throw new HTTPException(400, { message: "Unknown client assignment" });
      if (
        existing?.role === "admin" &&
        !existing.disabled &&
        (input.role !== "admin" || input.disabled) &&
        !state.users.some(
          (item) => item.id !== id && item.role === "admin" && !item.disabled,
        )
      )
        throw new HTTPException(409, {
          message: "Keep at least one active administrator",
        });
      const user: OfficeUser = {
        id: existing?.id ?? randomUUID(),
        username: input.username,
        name: input.name,
        role: input.role,
        clientIds: [...new Set(input.clientIds)],
        disabled: input.disabled,
        passwordHash: passwordHash ?? existing!.passwordHash,
        sessionVersion:
          (existing?.sessionVersion ?? 1) + (existing && passwordHash ? 1 : 0),
      };
      if (existing) state.users[state.users.indexOf(existing)] = user;
      else state.users.push(user);
      return publicUser(user);
    });
    return c.json(result);
  });
  routes.post("/layouts", async (c) => {
    const input = valid(
      z.object({
        name: text(100).min(1),
        clientId: idSchema,
        siteId: idSchema,
      }),
      await c.req.json(),
    );
    requireClient(c.get("officeUser"), input.clientId, true);
    const id = randomUUID();
    await store.update((state) => {
      if (
        !state.sites.some(
          (site) =>
            site.id === input.siteId && site.clientId === input.clientId,
        )
      )
        throw new HTTPException(400, {
          message: "Site must belong to selected client",
        });
      state.layouts[id] = {
        clientId: input.clientId,
        siteId: input.siteId,
        equipment: {},
      };
    });
    await storage.saveLayout(
      yaml.dump({
        version: "26.10.1",
        name: input.name,
        metadata: { id, name: input.name, schema_version: "1.1" },
        racks: [],
        device_types: [],
        settings: { display_mode: "label", show_labels_on_images: false },
      }),
      id,
    );
    return c.json({ id }, 201);
  });
  routes.put("/layouts/:id/assignment", async (c) => {
    requireAdmin(c.get("officeUser"));
    const id = valid(z.uuid(), c.req.param("id"));
    const input = valid(
      z.object({ clientId: idSchema, siteId: idSchema }),
      await c.req.json(),
    );
    if (!(await storage.layoutExists(id)))
      throw new HTTPException(404, { message: "Layout not found" });
    await store.update((state) => {
      if (
        !state.sites.some(
          (item) =>
            item.id === input.siteId && item.clientId === input.clientId,
        )
      )
        throw new HTTPException(400, {
          message: "Site must belong to selected client",
        });
      const old = state.layouts[id];
      state.layouts[id] = { ...input, equipment: old?.equipment ?? {} };
    });
    return c.json({ ok: true });
  });
  async function layoutData(id: string, user: OfficeUser) {
    valid(z.uuid(), id);
    const state = await store.read();
    const assignment = state.layouts[id];
    requireClient(user, assignment?.clientId);
    const layout = await storage.getLayout(id);
    if (!layout) throw new HTTPException(404, { message: "Layout not found" });
    return {
      id,
      layout: parseLayout(layout.content),
      updatedAt: layout.updatedAt,
      assignment: assignment ?? null,
      client:
        state.clients.find((item) => item.id === assignment?.clientId) ?? null,
      site: state.sites.find((item) => item.id === assignment?.siteId) ?? null,
    };
  }
  routes.get("/layouts/:id", async (c) =>
    c.json(await layoutData(c.req.param("id"), c.get("officeUser"))),
  );
  routes.put("/layouts/:id/equipment/:deviceId", async (c) => {
    const id = c.req.param("id");
    const deviceId = valid(idSchema, c.req.param("deviceId"));
    const data = await layoutData(id, c.get("officeUser"));
    requireClient(c.get("officeUser"), data.assignment?.clientId, true);
    const racks = data.layout.racks as { devices: { id: string }[] }[];
    if (
      !racks.some((rack) => rack.devices.some((item) => item.id === deviceId))
    )
      throw new HTTPException(404, { message: "Device not found in layout" });
    const input = valid(equipmentSchema, await c.req.json());
    await store.update((state) => {
      const assignment = state.layouts[id];
      if (!assignment)
        throw new HTTPException(400, {
          message: "Assign this layout to a client and site first",
        });
      requireClient(c.get("officeUser"), assignment.clientId, true);
      assignment.equipment[deviceId] = input;
    });
    return c.json({ ok: true });
  });
  async function mcpRequest(payload: unknown) {
    if (!env.MCPFLOW_INTEGRATION_URL || !env.MCPFLOW_INTEGRATION_TOKEN)
      throw new HTTPException(503, {
        message: "MCPFlow integration is not configured",
      });
    const response = await fetch(env.MCPFLOW_INTEGRATION_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MCPFLOW_INTEGRATION_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new HTTPException(502, {
        message: `MCPFlow returned HTTP ${response.status}`,
      });
    return (await response.json()) as {
      clients?: Client[];
      sites?: Site[];
      documentId?: number;
    };
  }
  routes.post("/sync-catalog", async (c) => {
    requireAdmin(c.get("officeUser"));
    const result = await mcpRequest({ action: "catalog" });
    const clients = valid(z.array(clientSchema), result.clients);
    const sites = valid(z.array(siteSchema), result.sites);
    await store.update((state) => {
      for (const client of clients) {
        const existing = state.clients.findIndex(
          (item) => item.id === client.id,
        );
        if (existing >= 0) state.clients[existing] = client;
        else state.clients.push(client);
      }
      for (const site of sites) {
        const existing = state.sites.findIndex((item) => item.id === site.id);
        if (existing >= 0) state.sites[existing] = site;
        else state.sites.push(site);
      }
    });
    return c.json({ ok: true, clients: clients.length, sites: sites.length });
  });
  routes.post("/layouts/:id/push", async (c) => {
    const data = await layoutData(c.req.param("id"), c.get("officeUser"));
    requireClient(c.get("officeUser"), data.assignment?.clientId, true);
    if (!data.client?.mcpClientId)
      throw new HTTPException(400, {
        message: "Select an MCPFlow-linked client first",
      });
    const result = await mcpRequest({
      action: "push",
      ...data,
      actor: c.get("officeUser").username,
    });
    await store.update((state) => {
      const assignment = state.layouts[data.id];
      if (assignment && assignment.clientId === data.assignment?.clientId) {
        assignment.lastPushedAt = new Date().toISOString();
        assignment.mcpDocumentId = result.documentId;
      }
    });
    return c.json({ ok: true, documentId: result.documentId });
  });
  routes.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON" }, 400);
    console.error("ICT365 request failed", error);
    return c.json({ error: "Unable to complete request" }, 500);
  });
  return { store, middleware, routes };
}
