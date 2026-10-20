import { mkdir, readFile, readdir, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OfficeStore, Assignment, OfficeState } from "./office";
import type { StorageDriver } from "./storage/driver";
import type { EnvMap } from "./security";
import type { SyncPayload } from "./mcpflow-contract";
import { normalizeLayout } from "./mcpflow-normalizer.js";
import { durableJson, syncDirectory } from "./durable-file";

export type SourcePatch = {
  content?: string | null;
  assignment?: Assignment | null;
  echoedUpdatedAt?: string;
  preCarrierMigration?: boolean;
};
export interface DeliveryState {
  version: 1;
  layoutId: string;
  revision: number;
  captureHash: string;
  payload: SyncPayload | null;
  status: "pending" | "synced" | "error" | "unassigned" | "reconcile_required";
  acknowledgedRevision: number;
  acknowledgedHash?: string;
  lastConfirmedAt?: string;
  attempts: number;
  nextAttemptAt: number | null;
  error?: string;
  receiverRevision?: number;
  receiverHash?: string;
}
type Journal = {
  version: 1;
  layoutId: string;
  patch: SourcePatch;
  state: DeliveryState;
};
export class McpflowInputError extends Error {}
type Options = {
  directory: string;
  office: OfficeStore;
  storage: StorageDriver;
  env: EnvMap;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
};

const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const utc = (time: number) =>
  new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/** One Bun API process owns the data directory, matching filesystem storage's write locks. */
export class McpflowPublisher {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private readonly directory: string;
  private readonly journals: string;
  private readonly now: () => number;
  private worker?: ReturnType<typeof setInterval>;
  private scanner?: ReturnType<typeof setInterval>;
  public scanError?: string;

  constructor(private readonly options: Options) {
    this.directory = join(options.directory, "office", "mcpflow-sync");
    this.journals = join(options.directory, "office", "mcpflow-journal");
    this.now = options.now ?? Date.now;
  }
  private key(id: string): string {
    if (!uuidPattern.test(id))
      throw new Error("Synchronization requires a layout UUID");
    return id.toLowerCase();
  }
  private lock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    this.queues.set(id, operation);
    void operation
      .finally(() => {
        if (this.queues.get(id) === operation) this.queues.delete(id);
      })
      .catch(() => undefined);
    return operation;
  }
  private clean(message: string): string {
    const token = this.options.env.MCPFLOW_INTEGRATION_TOKEN;
    return (
      (token ? message.split(token).join("[redacted]") : message)
        // eslint-disable-next-line no-control-regex -- sanitize untrusted receiver errors before exposing them
        .replace(/[\r\n\x00-\x1f]/g, " ")
        .slice(0, 500)
    );
  }
  private async load(id: string): Promise<DeliveryState | null> {
    try {
      const state = JSON.parse(
        await readFile(join(this.directory, `${id}.json`), "utf8"),
      ) as DeliveryState;
      if (
        state.version !== 1 ||
        state.layoutId !== id ||
        !Number.isSafeInteger(state.revision) ||
        state.revision < 0
      )
        throw new Error(
          "Invalid publisher revision state; restore or reconcile before publishing",
        );
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async persist(state: DeliveryState) {
    await durableJson(join(this.directory, `${state.layoutId}.json`), state);
  }
  async status(id: string): Promise<DeliveryState | null> {
    return this.lock(this.key(id), () => this.load(this.key(id)));
  }
  async states(): Promise<DeliveryState[]> {
    const result: DeliveryState[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const state = await this.status(name.slice(0, -5));
      if (state) result.push(state);
    }
    return result;
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.journals, { recursive: true, mode: 0o700 });
    await syncDirectory(join(this.options.directory, "office"));
    for (const name of await readdir(this.journals)) {
      if (!name.endsWith(".json")) continue;
      const id = this.key(name.slice(0, -5));
      await this.lock(id, () => this.recoverPending(id));
    }
  }
  private async recoverPending(id: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(this.journals, `${id}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const journal = JSON.parse(content) as Journal;
    if (
      journal.version !== 1 ||
      journal.layoutId !== id ||
      journal.state.layoutId !== id
    )
      throw new Error(
        "Invalid synchronization journal; operator recovery required",
      );
    await this.commitJournal(journal);
  }
  private async applySource(id: string, patch: SourcePatch): Promise<void> {
    if (patch.content === null) await this.options.storage.deleteLayout(id);
    else if (patch.content !== undefined) {
      const current = await this.options.storage.getLayout(id);
      if (current?.content !== patch.content)
        await this.options.storage.saveLayout(
          patch.content,
          id,
          patch.echoedUpdatedAt,
          { preCarrierMigration: patch.preCarrierMigration },
        );
    }
    if (Object.hasOwn(patch, "assignment")) {
      await this.options.office.update((state) => {
        if (patch.assignment === null) delete state.layouts[id];
        else if (patch.assignment) {
          const current = state.layouts[id];
          state.layouts[id] = {
            ...patch.assignment,
            ...(current?.clientId === patch.assignment.clientId
              ? {
                  lastPushedAt: current.lastPushedAt,
                  mcpDocumentId: current.mcpDocumentId,
                }
              : {}),
          };
        }
      });
    }
    // The local filesystem driver writes source files separately from the queue.
    // Flush source YAML and directory entries before retiring the recovery journal.
    for (const folder of await readdir(this.options.directory, {
      withFileTypes: true,
    })) {
      if (!folder.isDirectory() || !folder.name.endsWith(`-${id}`)) continue;
      const path = join(this.options.directory, folder.name);
      for (const file of await readdir(path)) {
        if (!/\.ya?ml$/i.test(file)) continue;
        const handle = await open(join(path, file), "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(path);
    }
    await syncDirectory(this.options.directory);
  }
  private async commitJournal(journal: Journal): Promise<void> {
    await this.applySource(journal.layoutId, journal.patch);
    await this.persist(journal.state);
    await rm(join(this.journals, `${journal.layoutId}.json`));
    await syncDirectory(this.journals);
  }
  private build(
    id: string,
    content: string | null,
    assignment: Assignment | undefined,
    office: OfficeState,
    previous: DeliveryState | null,
    forceFloor?: number,
    forceRemoval = false,
  ): DeliveryState {
    const client = office.clients.find(
      (item) => item.id === assignment?.clientId,
    );
    const site = office.sites.find((item) => item.id === assignment?.siteId);
    const linked = content !== null && !!client?.mcpClientId;
    let payload: SyncPayload | null = null;
    let error: string | undefined;
    let captureHash = hash({
      content,
      assignment: assignment
        ? {
            clientId: assignment.clientId,
            siteId: assignment.siteId,
            equipment: assignment.equipment,
          }
        : null,
      mcpClientId: client?.mcpClientId,
      mcpLocationId: site?.mcpLocationId,
    });
    try {
      if (linked) {
        if (!site || site.clientId !== client.id)
          throw new Error("Assign a site belonging to the MCPFlow client");
        const snapshot = normalizeLayout(content!, id);
        const deviceIds = new Set(
          snapshot.racks.flatMap((rack) =>
            rack.devices.map((device) => device.id),
          ),
        );
        for (const [deviceId, record] of Object.entries(
          assignment?.equipment ?? {},
        )) {
          // Removed device annotations remain in office history but cannot refer to absent placements.
          if (deviceIds.has(deviceId))
            snapshot.equipment[deviceId] = {
              ...snapshot.equipment[deviceId],
              ...record,
              mcpAssetId: record.mcpAssetId ?? null,
            };
        }
        payload = {
          action: "sync_layout",
          schemaVersion: 2,
          sourceInstance:
            this.options.env.MCPFLOW_SOURCE_INSTANCE ?? "ict365-rackula",
          layoutId: id,
          revision: 0,
          operation: "upsert",
          sourceUpdatedAt: utc(this.now()),
          clientId: client.mcpClientId,
          locationId: site.mcpLocationId ?? null,
          siteName: site.name,
          snapshot,
        };
        const { source: _source, ...businessSnapshot } = snapshot;
        void _source;
        captureHash = hash({
          clientId: payload.clientId,
          locationId: payload.locationId,
          siteName: payload.siteName,
          snapshot: businessSnapshot,
        });
      } else if (
        forceRemoval ||
        previous?.payload ||
        previous?.acknowledgedRevision
      ) {
        payload = {
          action: "sync_layout",
          schemaVersion: 2,
          sourceInstance:
            this.options.env.MCPFLOW_SOURCE_INSTANCE ?? "ict365-rackula",
          layoutId: id,
          revision: 0,
          operation: "delete",
          sourceUpdatedAt: utc(this.now()),
        };
        captureHash = hash({ operation: "delete" });
      }
    } catch (cause) {
      error = this.clean(
        cause instanceof Error
          ? cause.message
          : "Unable to normalize saved layout",
      );
    }
    if (previous?.captureHash === captureHash && forceFloor === undefined)
      return previous;
    const revision =
      Math.max(previous?.revision ?? 0, forceFloor ?? 0) +
      (payload || error ? 1 : 0);
    if (!Number.isSafeInteger(revision))
      throw new Error(
        "Revision counter exhausted; operator reconciliation required",
      );
    if (payload) payload.revision = revision;
    const next: DeliveryState = {
      version: 1,
      layoutId: id,
      revision,
      captureHash,
      payload,
      status: error ? "error" : payload ? "pending" : "unassigned",
      attempts: 0,
      nextAttemptAt: payload && !error ? this.now() : null,
      acknowledgedRevision: previous?.acknowledgedRevision ?? 0,
      acknowledgedHash: previous?.acknowledgedHash,
      lastConfirmedAt: previous?.lastConfirmedAt,
      error,
    };
    if (payload && Buffer.byteLength(JSON.stringify(payload)) > 1048576) {
      next.status = "error";
      next.error =
        "Snapshot exceeds MCPFlow's 1 MiB limit. Reduce layout size; no content was truncated.";
      next.nextAttemptAt = null;
    }
    if (previous?.status === "reconcile_required" && forceFloor === undefined) {
      next.status = "reconcile_required";
      next.error = previous.error;
      next.receiverRevision = previous.receiverRevision;
      next.receiverHash = previous.receiverHash;
      next.nextAttemptAt = null;
    }
    return next;
  }
  async mutate(id: string, patch: SourcePatch): Promise<void> {
    id = this.key(id);
    await this.lock(id, () => this.mutateLocked(id, patch));
  }
  private async mutateLocked(id: string, patch: SourcePatch): Promise<void> {
    const outstanding = join(this.journals, `${id}.json`);
    await this.recoverPending(id);
    const office = await this.options.office.read();
    const previousAssignment = office.layouts[id];
    if (
      patch.assignment?.clientId &&
      previousAssignment &&
      patch.assignment.clientId !== previousAssignment.clientId &&
      Object.values(patch.assignment.equipment).some(
        (item) => item.mcpAssetId !== undefined,
      )
    ) {
      throw new McpflowInputError(
        "Clear explicit MCPFlow asset links before moving this layout to another client",
      );
    }
    const content =
      patch.content === undefined
        ? ((await this.options.storage.getLayout(id))?.content ?? null)
        : patch.content;
    const assignment = Object.hasOwn(patch, "assignment")
      ? (patch.assignment ?? undefined)
      : previousAssignment;
    const previousLinked = office.clients.some(
      (client) =>
        client.id === previousAssignment?.clientId && client.mcpClientId,
    );
    const nextLinked = office.clients.some(
      (client) => client.id === assignment?.clientId && client.mcpClientId,
    );
    const removing =
      patch.content === null ||
      (Object.hasOwn(patch, "assignment") &&
        (!assignment?.clientId || (previousLinked && !nextLinked)));
    const state = this.build(
      id,
      content,
      assignment,
      office,
      await this.load(id),
      undefined,
      removing,
    );
    const journal: Journal = { version: 1, layoutId: id, patch, state };
    await durableJson(outstanding, journal);
    await this.commitJournal(journal);
  }
  async mutateAssignment(
    id: string,
    update: (current: Assignment | undefined) => Assignment,
  ): Promise<void> {
    // Prepare assignment and source under the same lock as all other mutation paths.
    await this.change(id, async () => ({
      assignment: update((await this.options.office.read()).layouts[id]),
    }));
  }
  async change(id: string, prepare: () => Promise<SourcePatch>): Promise<void> {
    id = this.key(id);
    await this.lock(id, async () => {
      await this.recoverPending(id);
      await this.mutateLocked(id, await prepare());
    });
  }
  async reconcile(): Promise<{
    queued: number;
    skipped: number;
    errors: number;
  }> {
    const layouts = await this.options.storage.listLayouts(); // A failed scan never produces removals.
    const summary = { queued: 0, skipped: 0, errors: 0 };
    for (const layout of layouts) {
      if (!uuidPattern.test(layout.id)) {
        summary.skipped++;
        continue;
      }
      await this.lock(this.key(layout.id), async () => {
        await this.recoverPending(this.key(layout.id));
        const current = await this.options.storage.getLayout(layout.id);
        if (!current) {
          summary.errors++;
          return;
        } // Disappearance during a scan is not a deletion event.
        const office = await this.options.office.read();
        const previous = await this.load(layout.id);
        const next = this.build(
          layout.id,
          current.content,
          office.layouts[layout.id],
          office,
          previous,
        );
        if (next === previous && next.status === "synced") {
          next.status = "pending";
          next.nextAttemptAt = this.now();
        }
        await this.persist(next);
        if (next.status === "unassigned") summary.skipped++;
        else if (
          next.status === "error" ||
          next.status === "reconcile_required"
        )
          summary.errors++;
        else summary.queued++;
      });
    }
    this.scanError = undefined;
    return summary;
  }
  async retry(id: string): Promise<void> {
    await this.lock(this.key(id), async () => {
      const state = await this.load(this.key(id));
      if (!state || state.status === "reconcile_required" || !state.payload)
        return;
      if (Buffer.byteLength(JSON.stringify(state.payload)) > 1048576) return;
      state.status = "pending";
      state.nextAttemptAt = this.now();
      state.error = undefined;
      await this.persist(state);
    });
  }
  async reconcileFloor(id: string, floor: number): Promise<void> {
    id = this.key(id);
    await this.lock(id, async () => {
      await this.recoverPending(id);
      const previous = await this.load(id);
      if (
        !previous ||
        previous.status !== "reconcile_required" ||
        !Number.isSafeInteger(floor) ||
        floor < (previous.receiverRevision ?? previous.revision)
      )
        throw new McpflowInputError(
          "Confirm the receiver revision floor shown in delivery status",
        );
      const office = await this.options.office.read();
      const content =
        (await this.options.storage.getLayout(id))?.content ?? null;
      const next = this.build(
        id,
        content,
        office.layouts[id],
        office,
        previous,
        floor,
      );
      await this.persist(next);
    });
  }
  async deliver(): Promise<void> {
    if (
      !this.options.env.MCPFLOW_INTEGRATION_URL ||
      !this.options.env.MCPFLOW_INTEGRATION_TOKEN
    )
      return;
    await this.initialize(); // Finish recoverable source commits before publishing durable jobs.
    for (const state of await this.states()) {
      if (
        state.status !== "pending" ||
        state.nextAttemptAt === null ||
        state.nextAttemptAt > this.now() ||
        !state.payload ||
        this.inFlight.has(state.layoutId)
      )
        continue;
      this.inFlight.add(state.layoutId);
      try {
        await this.send(state);
      } finally {
        this.inFlight.delete(state.layoutId);
      }
    }
  }
  private async send(sent: DeliveryState): Promise<void> {
    let status = 0;
    let body: Record<string, unknown> = {};
    let retryAfter = 0;
    let transportError = "Delivery failed or timed out; retry scheduled";
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.options.env.MCPFLOW_INTEGRATION_URL!,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.env.MCPFLOW_INTEGRATION_TOKEN}`,
          },
          body: JSON.stringify(sent.payload),
        },
      );
      status = response.status;
      const after = response.headers.get("Retry-After");
      if (after)
        retryAfter = /^\d+$/.test(after)
          ? Number(after) * 1000
          : Math.max(0, Date.parse(after) - this.now());
      const reader = response.body?.getReader();
      let text = "";
      let size = 0;
      if (reader) {
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) throw new Error("Oversized receiver response");
            text += decoder.decode(chunk.value, { stream: true });
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      body = JSON.parse(text) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid receiver response");
    } catch {
      if (status === 200) status = 0;
      transportError =
        "Delivery failed or returned invalid data; retry scheduled";
    }
    await this.lock(sent.layoutId, async () => {
      const state = await this.load(sent.layoutId);
      if (
        !state ||
        state.revision !== sent.revision ||
        state.captureHash !== sent.captureHash
      )
        return;
      const validAck =
        status === 200 &&
        body.ok === true &&
        body.layoutId === sent.layoutId &&
        Number.isSafeInteger(body.acceptedRevision) &&
        typeof body.contentHash === "string" &&
        /^[a-f0-9]{64}$/.test(body.contentHash);
      if (
        validAck &&
        body.result === "superseded" &&
        (body.acceptedRevision as number) > state.revision
      ) {
        state.status = "reconcile_required";
        state.receiverRevision = body.acceptedRevision as number;
        state.receiverHash = body.contentHash as string;
        state.error =
          "Receiver is ahead of the source counter. Review source/receiver state and explicitly reconcile the revision floor.";
        state.nextAttemptAt = null;
      } else if (
        validAck &&
        ["applied", "unchanged"].includes(body.result as string) &&
        body.acceptedRevision === sent.revision
      ) {
        if (
          state.acknowledgedRevision === sent.revision &&
          state.acknowledgedHash &&
          state.acknowledgedHash !== body.contentHash
        ) {
          state.status = "reconcile_required";
          state.error =
            "Receiver hash changed for an acknowledged revision; review and reconcile";
          state.nextAttemptAt = null;
        } else {
          state.status = "synced";
          state.acknowledgedRevision = sent.revision;
          state.acknowledgedHash = body.contentHash as string;
          state.lastConfirmedAt = utc(this.now());
          state.attempts = 0;
          state.nextAttemptAt = null;
          state.error = undefined;
        }
      } else {
        const transient =
          status === 0 ||
          status === 429 ||
          status >= 500 ||
          (status === 200 && !validAck);
        state.attempts++;
        state.status =
          status === 409
            ? "reconcile_required"
            : transient
              ? "pending"
              : "error";
        state.error = this.clean(
          status
            ? `MCPFlow HTTP ${status}: ${typeof body.error === "string" ? body.error : "Check receiver configuration and payload"}`
            : transportError,
        );
        state.nextAttemptAt = transient
          ? this.now() +
            Math.max(
              retryAfter || 0,
              Math.min(300000, 1000 * 2 ** Math.min(state.attempts, 9)) *
                (0.75 + (this.options.random ?? Math.random)() * 0.5),
            )
          : null;
      }
      await this.persist(state);
    });
  }
  async start(): Promise<void> {
    if (this.worker || this.options.env.MCPFLOW_SYNC_ENABLED !== "true") return;
    const scan = async () => {
      try {
        await this.reconcile();
      } catch {
        this.scanError =
          "Source scan failed; existing deliveries retained. Check saved layouts and storage permissions.";
      }
    };
    await scan();
    const tick = () => {
      void this.deliver().catch(() => {
        this.scanError =
          "Publisher storage failure; check data-directory permissions and disk space";
      });
    };
    tick();
    this.worker = setInterval(tick, 5000);
    this.scanner = setInterval(
      () => {
        void scan();
      },
      15 * 60 * 1000,
    );
    this.worker.unref();
    this.scanner.unref();
  }
  stop(): void {
    clearInterval(this.worker);
    clearInterval(this.scanner);
    this.worker = undefined;
    this.scanner = undefined;
  }
}
