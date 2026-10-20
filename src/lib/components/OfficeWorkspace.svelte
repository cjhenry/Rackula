<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import OfficeHeader from "./OfficeHeader.svelte";
  import type {
    Client,
    Site,
    Equipment,
    Assignment,
    OfficeUser,
  } from "$lib/types/office";
  import type { Layout } from "$lib/types";
  import { parseLayoutObject } from "$lib/utils/yaml";
  import { renderLayoutPreviewSvg } from "./layout-preview-render";
  type User = Omit<OfficeUser, "passwordHash" | "sessionVersion">;
  type Row = {
    id: string;
    name: string;
    rackCount: number;
    deviceCount: number;
    assignment: Assignment | null;
    updatedAt: string;
  };
  type Catalog = {
    user: User;
    clients: Client[];
    sites: Site[];
    layouts: Row[];
    users: User[];
    mcpflowUrl: string;
    integrationEnabled: boolean;
    synchronization?: {
      enabled: boolean;
      sourceInstance: string;
      scanError: string | null;
    };
  };
  type DeliveryStatus = {
    layoutId: string;
    status: string;
    revision: number;
    acknowledgedRevision: number;
    lastConfirmedAt?: string;
    error?: string;
    receiverRevision?: number;
  };
  type Detail = {
    id: string;
    layout: Layout;
    assignment: Assignment | null;
    client: Client | null;
    site: Site | null;
    updatedAt: string;
    synchronization?: Omit<DeliveryStatus, "layoutId"> | null;
  };
  let catalog = $state<Catalog | null>(null);
  let detail = $state<Detail | null>(null);
  let clientId = $state("");
  let siteId = $state("");
  let search = $state("");
  let tab = $state("racks");
  let error = $state("");
  let message = $state("");
  let deliveries = $state<DeliveryStatus[]>([]);
  let busy = $state(false);
  let assignmentClient = $state("");
  let assignmentSite = $state("");
  let newClientName = $state("");
  let newSiteClient = $state("");
  let newSiteName = $state("");
  let newSiteAddress = $state("");
  let newLayoutName = $state("");
  let editedUserId = $state("new");
  let userName = $state("");
  let displayName = $state("");
  let userRole = $state<OfficeUser["role"]>("viewer");
  let userClients = $state<string[]>([]);
  let userDisabled = $state(false);
  let userPassword = $state("");
  const admin = $derived(catalog?.user.role === "admin");
  const editor = $derived(
    catalog?.user.role === "admin" || catalog?.user.role === "editor",
  );
  const clients = $derived(catalog?.clients ?? []);
  const sites = $derived(
    (catalog?.sites ?? []).filter(
      (site) => !clientId || site.clientId === clientId,
    ),
  );
  const layouts = $derived(
    (catalog?.layouts ?? []).filter(
      (row) =>
        (clientId === "unassigned"
          ? !row.assignment?.clientId
          : !!clientId && row.assignment?.clientId === clientId) &&
        (!siteId || row.assignment?.siteId === siteId) &&
        row.name.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  const assignmentSites = $derived(
    (catalog?.sites ?? []).filter((site) => site.clientId === assignmentClient),
  );
  const preview = $derived.by(() => {
    if (!detail) return "";
    try {
      const layout = parseLayoutObject(detail.layout);
      return layout ? (renderLayoutPreviewSvg(layout) ?? "") : "";
    } catch {
      return "";
    }
  });
  async function api<T>(path = "", method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`/api/office${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error("Please sign in");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Request failed");
    return result;
  }
  async function action(run: () => Promise<unknown>, success: string) {
    if (busy) return;
    busy = true;
    error = "";
    message = "";
    try {
      await run();
      if (success) message = success;
    } catch (err) {
      error = err instanceof Error ? err.message : "Request failed";
    } finally {
      busy = false;
    }
  }
  async function reload() {
    catalog = await api<Catalog>();
    if (catalog.synchronization) await refreshDelivery();
  }
  async function refreshDelivery() {
    const result = await api<{ layouts: DeliveryStatus[] }>("/sync-status");
    deliveries = result.layouts;
    if (detail)
      detail.synchronization =
        deliveries.find((row) => row.layoutId === detail?.id) ??
        detail.synchronization;
  }
  async function openLayout(id: string) {
    detail = await api<Detail>(`/layouts/${encodeURIComponent(id)}`);
    clientId = detail.assignment?.clientId || "unassigned";
    assignmentClient = detail.assignment?.clientId ?? "";
    assignmentSite = detail.assignment?.siteId ?? "";
    const query = new SvelteURLSearchParams(location.search);
    query.delete("client_id");
    query.set("layout", id);
    history.replaceState(null, "", `?${query}`);
  }
  function blankEquipment(): Equipment {
    return {
      serial: "",
      assetTag: "",
      hostname: "",
      managementIp: "",
      installed: "",
      warrantyExpires: "",
      notes: "",
    };
  }
  function equipment(
    device: Layout["racks"][number]["devices"][number],
  ): Equipment {
    const type = detail?.layout.device_types.find(
      (item) => item.slug === device.device_type,
    );
    return (
      detail?.assignment?.equipment[device.id] ?? {
        ...blankEquipment(),
        serial: type?.serial_number ?? "",
        assetTag: type?.asset_tag ?? "",
      }
    );
  }
  async function saveEquipment(event: SubmitEvent, deviceId: string) {
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const input = Object.fromEntries(values.entries());
    if (!input.mcpAssetId) delete input.mcpAssetId;
    else
      (input as Record<string, unknown>).mcpAssetId = Number(input.mcpAssetId);
    await api(
      `/layouts/${detail!.id}/equipment/${encodeURIComponent(deviceId)}`,
      "PUT",
      input,
    );
    await openLayout(detail!.id);
  }
  function editUser(user?: User) {
    editedUserId = user?.id ?? "new";
    userName = user?.username ?? "";
    displayName = user?.name ?? "";
    userRole = user?.role ?? "viewer";
    userClients = [...(user?.clientIds ?? [])];
    userDisabled = user?.disabled ?? false;
    userPassword = "";
  }
  async function saveUser() {
    await api(`/users/${editedUserId}`, "PUT", {
      username: userName,
      name: displayName,
      role: userRole,
      clientIds: userClients,
      disabled: userDisabled,
      ...(userPassword ? { password: userPassword } : {}),
    });
    editUser();
    await reload();
  }
  function selectClient(id: string) {
    clientId = id;
    siteId = "";
    detail = null;
    search = "";
    tab = "racks";
    const query = new SvelteURLSearchParams(location.search);
    query.delete("layout");
    query.delete("client_id");
    query.delete("tab");
    const client = clients.find((item) => item.id === id);
    if (client?.mcpClientId) query.set("client_id", String(client.mcpClientId));
    history.replaceState(
      null,
      "",
      `${location.pathname}${query.size ? `?${query}` : ""}`,
    );
  }
  onMount(() => {
    void action(async () => {
      await reload();
      const params = new SvelteURLSearchParams(location.search);
      const mcpClient = params.get("client_id");
      clientId =
        clients.find((client) => String(client.mcpClientId) === mcpClient)
          ?.id ?? "";
      if (params.get("tab") === "admin" && admin) tab = "admin";
      const layoutId = params.get("layout");
      if (layoutId) await openLayout(layoutId);
    }, "");
    const timer = setInterval(() => {
      if (catalog?.synchronization && !busy)
        void refreshDelivery().catch(() => undefined);
    }, 10000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>ICT365 | Rackula Workspace</title></svelte:head>
<OfficeHeader
  {catalog}
  {clientId}
  layoutId={detail?.id ?? ""}
  workspace
  {busy}
  onclientchange={selectClient}
  onlayoutchange={(id) => {
    siteId = "";
    tab = "racks";
    void action(() => openLayout(id), "");
  }}
  onadmin={() => (tab = "admin")}
/>
{#if tab === "admin"}<div class="workspace-navigation no-print">
    <button onclick={() => (tab = "racks")}>← Back to racks</button>
  </div>{/if}
<main>
  {#if error}<p role="alert" class="error no-print">{error}</p>{/if}
  {#if message}<p role="status" class="message no-print">{message}</p>{/if}
  {#if catalog?.synchronization && admin}
    <details class="no-print">
      <summary
        >MCPFlow synchronization: {catalog.synchronization.enabled
          ? "automatic delivery enabled"
          : "automatic delivery disabled"}</summary
      >
      <p>
        Saved layouts synchronize separately from published Documents. Last
        confirmed delivery and any rejected asset links are shown below.
      </p>
      {#if catalog.synchronization.scanError}<p role="alert">
          {catalog.synchronization.scanError}
        </p>{/if}
      <button
        disabled={busy || !catalog.integrationEnabled}
        onclick={() =>
          action(async () => {
            const result = await api<{
              queued: number;
              skipped: number;
              errors: number;
            }>("/sync-backfill", "POST", {});
            await refreshDelivery();
            message = `Backfill: ${result.queued} queued, ${result.skipped} unassigned, ${result.errors} needing attention.`;
          }, "")}>Backfill linked saved layouts</button
      >
      {#each deliveries as delivery (delivery.layoutId)}
        <div class="equipment">
          <strong
            >{catalog.layouts.find((row) => row.id === delivery.layoutId)
              ?.name ?? delivery.layoutId}</strong
          >
          <p>
            {delivery.status.replaceAll("_", " ")} · revision {delivery.revision}
            · accepted {delivery.acknowledgedRevision}
          </p>
          {#if delivery.lastConfirmedAt}<p>
              Last confirmed: {new Date(
                delivery.lastConfirmedAt,
              ).toLocaleString()}
            </p>{/if}
          {#if delivery.error}<p role="alert">{delivery.error}</p>{/if}
          {#if delivery.status === "reconcile_required"}
            <button
              disabled={busy}
              onclick={() => {
                const floor = delivery.receiverRevision ?? delivery.revision;
                if (
                  window.confirm(
                    `Review the saved layout, client assignment and asset links first. Publish that current state above receiver revision ${floor}?`,
                  )
                )
                  void action(async () => {
                    await api(
                      `/layouts/${delivery.layoutId}/sync-reconcile`,
                      "POST",
                      { receiverRevision: floor, confirmCurrentSource: true },
                    );
                    await refreshDelivery();
                  }, "Current saved state queued above the reviewed revision floor.");
              }}>Review and reconcile revision</button
            >
          {:else if delivery.status !== "unassigned"}
            <button
              disabled={busy}
              onclick={() =>
                action(async () => {
                  await api(
                    `/layouts/${delivery.layoutId}/sync-retry`,
                    "POST",
                    {},
                  );
                  await refreshDelivery();
                }, "Delivery queued for retry.")}>Retry delivery</button
            >
          {/if}
        </div>
      {/each}
    </details>
  {/if}
  {#if !catalog}<p>Loading workspace...</p>
  {:else if tab === "admin" && admin}
    <section class="no-print">
      <h1>Administration</h1>
      <p>
        Manage users, roles, and access to individual clients. Administrators
        can access every client. Editors can update assigned clients; viewers
        can read and export.
      </p>
    </section>
    <div class="admin-grid no-print">
      <section>
        <h2>Users</h2>
        <button onclick={() => editUser()}>New user</button>
        {#each catalog.users as user (user.id)}<button
            class="user-row"
            onclick={() => editUser(user)}
            >{user.name}
            <small
              >{user.username} · {user.role}{user.disabled
                ? " · disabled"
                : ""}</small
            ></button
          >{/each}
      </section>
      <section>
        <h2>{editedUserId === "new" ? "Create user" : "Edit user"}</h2>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void action(
              saveUser,
              "User saved. Password resets invalidate existing sessions.",
            );
          }}
        >
          <label
            >Display name<input
              required
              bind:value={displayName}
              maxlength="200"
            /></label
          >
          <label
            >Username<input
              required
              bind:value={userName}
              autocomplete="off"
              pattern="[a-zA-Z0-9@._\-]+"
            /></label
          >
          <label
            >Role<select bind:value={userRole}
              ><option value="viewer">Viewer</option><option value="editor"
                >Editor</option
              ><option value="admin">Administrator</option></select
            ></label
          >
          <label
            >{editedUserId === "new"
              ? "Password"
              : "New password (leave blank to keep)"}<input
              type="password"
              bind:value={userPassword}
              required={editedUserId === "new"}
              minlength="12"
              maxlength="1024"
              autocomplete="new-password"
            /></label
          >
          <label class="check"
            ><input type="checkbox" bind:checked={userDisabled} /> Disable account</label
          >
          <fieldset>
            <legend>Permitted clients</legend>{#if userRole === "admin"}<p>
                Administrators have access to all clients.
              </p>{:else}{#each clients as client (client.id)}<label
                  class="check"
                  ><input
                    type="checkbox"
                    bind:group={userClients}
                    value={client.id}
                  />
                  {client.name}</label
                >{/each}{/if}
          </fieldset>
          <button class="primary" disabled={busy}>Save user</button>
        </form>
      </section>
      <section>
        <h2>Client directory</h2>
        <p>
          Import clients and locations from MCPFlow, or create local records.
        </p>
        <button
          disabled={busy || !catalog.integrationEnabled}
          onclick={() =>
            action(async () => {
              await api("/sync-catalog", "POST", {});
              await reload();
            }, "MCPFlow clients and sites imported.")}
          >Refresh from MCPFlow</button
        >
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api("/clients", "POST", { name: newClientName });
              newClientName = "";
              await reload();
            }, "Client created.");
          }}
        >
          <label
            >New client name<input
              required
              bind:value={newClientName}
              maxlength="200"
            /></label
          ><button disabled={busy}>Add client</button>
        </form>
        <h3>New site</h3>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api("/sites", "POST", {
                clientId: newSiteClient,
                name: newSiteName,
                address: newSiteAddress,
              });
              newSiteName = "";
              newSiteAddress = "";
              await reload();
            }, "Site created.");
          }}
        >
          <label
            >Client<select required bind:value={newSiteClient}
              ><option value="">Select a client</option
              >{#each clients as client (client.id)}<option value={client.id}
                  >{client.name}</option
                >{/each}</select
            ></label
          >
          <label
            >Site name<input
              required
              bind:value={newSiteName}
              maxlength="200"
            /></label
          ><label
            >Address<textarea bind:value={newSiteAddress} maxlength="1000"
            ></textarea></label
          ><button disabled={busy}>Add site</button>
        </form>
      </section>
    </div>
  {:else}
    <div class="page-title no-print">
      <div>
        <p class="eyebrow">Infrastructure documentation</p>
        <h1>
          {clients.find((client) => client.id === clientId)?.name ??
            (clientId === "unassigned"
              ? "Unassigned layouts"
              : "Your rack workspace")}
        </h1>
        <p>Select a client and rack layout in the header to get started.</p>
      </div>
      {#if admin}<button
          disabled={busy || !catalog.integrationEnabled}
          onclick={() =>
            action(async () => {
              await api("/sync-catalog", "POST", {});
              await reload();
            }, "Client directory refreshed.")}>Refresh from MCPFlow</button
        >{/if}
    </div>
    <section class="filters no-print">
      <label
        >Site<select bind:value={siteId} onchange={() => (detail = null)}
          ><option value="">All sites</option
          >{#each sites as site (site.id)}<option value={site.id}
              >{site.name}</option
            >{/each}</select
        ></label
      >
      <label
        >Find a layout<input
          type="search"
          bind:value={search}
          placeholder="Search layouts"
        /></label
      >
    </section>
    {#if editor && clientId && clientId !== "unassigned" && siteId}<form
        class="inline-form no-print"
        onsubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            const result = await api<{ id: string }>("/layouts", "POST", {
              name: newLayoutName,
              clientId,
              siteId,
            });
            newLayoutName = "";
            await reload();
            await openLayout(result.id);
          }, "Layout created. Open the designer to add racks and devices.");
        }}
      >
        <label
          >New layout<input
            required
            bind:value={newLayoutName}
            maxlength="100"
            placeholder="Server room"
          /></label
        ><button class="primary" disabled={busy}>Create layout</button>
      </form>{/if}
    <div class="workspace-grid">
      <aside class="no-print" aria-label="Saved layouts">
        <h2>Layouts <small>{layouts.length}</small></h2>
        {#each layouts as row (row.id)}<button
            class="layout-row"
            class:selected={detail?.id === row.id}
            onclick={() => action(() => openLayout(row.id), "")}
            ><strong>{row.name}</strong><small
              >{clients.find((item) => item.id === row.assignment?.clientId)
                ?.name ?? "Unassigned: administrator only"}</small
            ><small
              >{catalog.sites.find((item) => item.id === row.assignment?.siteId)
                ?.name ?? "No site"} · {row.rackCount} racks · {row.deviceCount} devices</small
            ></button
          >{:else}<p>
            No layouts match. {admin
              ? "Import clients, create sites, and assign existing layouts to get started."
              : "Ask an administrator to assign your clients and layouts."}
          </p>{/each}
      </aside>
      <article>
        {#if detail}
          <div class="report-heading">
            <p class="eyebrow">ICT365 · Infrastructure report</p>
            <h2>{detail.layout.name}</h2>
            <p>
              {detail.client?.name ?? "Unassigned client"} / {detail.site
                ?.name ?? "Unassigned site"}
            </p>
            {#if detail.site?.address}<p>{detail.site.address}</p>{/if}
            <p class="report-date">
              Layout updated {new Date(detail.updatedAt).toLocaleString()} · Report
              generated {new Date().toLocaleDateString()}
            </p>
          </div>
          <div class="actions no-print">
            <a class="button primary" href={`/?layout=${detail.id}`}
              >Open rack designer</a
            ><button onclick={() => window.print()}
              >Print / save PDF report</button
            >
            {#if detail.client?.mcpClientId}<a
                class="button"
                href={`${catalog.mcpflowUrl}/agent/client_overview.php?client_id=${detail.client.mcpClientId}`}
                target="_blank"
                rel="noreferrer">Open client in MCPFlow</a
              >{/if}
            {#if editor}<button
                disabled={busy ||
                  !catalog.integrationEnabled ||
                  !detail.client?.mcpClientId}
                onclick={() =>
                  action(async () => {
                    await api(`/layouts/${detail!.id}/push`, "POST", {});
                    await openLayout(detail!.id);
                  }, "Inventory report pushed to the client's MCPFlow documents.")}
                >Push report to MCPFlow</button
              >{/if}
          </div>
          {#if detail.assignment?.lastPushedAt}<p class="no-print">
              Last pushed to MCPFlow: {new Date(
                detail.assignment.lastPushedAt,
              ).toLocaleString()}
            </p>{/if}
          {#if detail.synchronization}<div class="no-print">
              <p>
                Snapshot delivery: {detail.synchronization.status.replaceAll(
                  "_",
                  " ",
                )} · revision {detail.synchronization.revision} · accepted {detail
                  .synchronization.acknowledgedRevision}
              </p>
              {#if detail.synchronization.lastConfirmedAt}<p>
                  Last confirmed: {new Date(
                    detail.synchronization.lastConfirmedAt,
                  ).toLocaleString()}
                </p>{/if}
              {#if detail.synchronization.error}<p role="alert">
                  {detail.synchronization.error}
                </p>{/if}
              {#if editor && detail.synchronization.status !== "reconcile_required"}<button
                  disabled={busy}
                  onclick={() =>
                    action(async () => {
                      await api(
                        `/layouts/${detail!.id}/sync-retry`,
                        "POST",
                        {},
                      );
                      await openLayout(detail!.id);
                    }, "Snapshot delivery queued for retry.")}
                  >Retry snapshot delivery</button
                >{/if}
            </div>{/if}
          {#if admin}<form
              class="assignment no-print"
              onsubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  await api(`/layouts/${detail!.id}/assignment`, "PUT", {
                    clientId: assignmentClient,
                    siteId: assignmentSite,
                  });
                  await reload();
                  await openLayout(detail!.id);
                }, "Client and site assignment saved.");
              }}
            >
              <label
                >Client<select
                  required
                  bind:value={assignmentClient}
                  onchange={() => (assignmentSite = "")}
                  ><option value="">Select client</option
                  >{#each clients as client (client.id)}<option
                      value={client.id}>{client.name}</option
                    >{/each}</select
                ></label
              ><label
                >Site<select required bind:value={assignmentSite}
                  ><option value="">Select site</option
                  >{#each assignmentSites as site (site.id)}<option
                      value={site.id}>{site.name}</option
                    >{/each}</select
                ></label
              ><button disabled={busy}>Save assignment</button>
              {#if detail.assignment?.clientId}<button
                  type="button"
                  disabled={busy}
                  onclick={() =>
                    action(async () => {
                      await api(`/layouts/${detail!.id}/assignment`, "DELETE");
                      await reload();
                      await openLayout(detail!.id);
                    }, "Layout unassigned. A removal is queued for MCPFlow; equipment annotations are retained.")}
                  >Unassign layout</button
                >{/if}
            </form>{/if}
          {#if preview}<div class="rack-preview">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- Export renderer builds SVG using DOM APIs and escapes user text. -->
              {@html preview}
            </div>{/if}
          <div class="print-only">
            {#each detail.layout.racks as rack (rack.id)}
              <h3>{rack.name} ({rack.height}U)</h3>
              <table>
                <thead
                  ><tr
                    ><th>Device / position</th><th>Serial / asset tag</th><th
                      >Hostname / IP</th
                    ><th>Installed / warranty</th><th>Notes</th></tr
                  ></thead
                ><tbody>
                  {#each rack.devices as device (device.id)}
                    {@const record = equipment(device)}
                    {@const type = detail.layout.device_types.find(
                      (item) => item.slug === device.device_type,
                    )}
                    <tr
                      ><td
                        >{device.name ??
                          device.label ??
                          type?.model ??
                          device.device_type}<br />U{device.position / 6}, {device.face}</td
                      ><td>{record.serial}<br />{record.assetTag}</td><td
                        >{record.hostname}<br />{record.managementIp}</td
                      ><td>{record.installed}<br />{record.warrantyExpires}</td
                      ><td class="report-notes">{record.notes}</td></tr
                    >
                  {/each}
                </tbody>
              </table>
            {/each}
          </div>
          {#each detail.layout.racks as rack (rack.id)}<section
              class="rack-section"
            >
              <h3>{rack.name} <small>{rack.height}U</small></h3>
              {#each rack.devices as device (device.id)}
                {@const record = equipment(device)}
                {@const type = detail.layout.device_types.find(
                  (item) => item.slug === device.device_type,
                )}
                <details class="equipment">
                  <summary
                    ><strong
                      >{device.name ??
                        device.label ??
                        type?.model ??
                        device.device_type}</strong
                    ><span
                      >{type?.manufacturer ?? ""} · {device.face} · U{device.position /
                        6}</span
                    ></summary
                  >
                  <form
                    onsubmit={(event) => {
                      event.preventDefault();
                      void action(
                        () => saveEquipment(event, device.id),
                        "Equipment record saved.",
                      );
                    }}
                  >
                    <div class="equipment-grid">
                      <label
                        >Serial number<input
                          name="serial"
                          value={record.serial}
                          readonly={!editor}
                          maxlength="255"
                        /></label
                      ><label
                        >Asset tag<input
                          name="assetTag"
                          value={record.assetTag}
                          readonly={!editor}
                          maxlength="255"
                        /></label
                      ><label
                        >Hostname<input
                          name="hostname"
                          value={record.hostname}
                          readonly={!editor}
                          maxlength="255"
                        /></label
                      ><label
                        >Management IP<input
                          name="managementIp"
                          value={record.managementIp}
                          readonly={!editor}
                          maxlength="255"
                        /></label
                      ><label
                        >Installation date<input
                          name="installed"
                          type="date"
                          value={record.installed}
                          readonly={!editor}
                        /></label
                      ><label
                        >Warranty expires<input
                          name="warrantyExpires"
                          type="date"
                          value={record.warrantyExpires}
                          readonly={!editor}
                        /></label
                      ><label
                        >MCPFlow asset ID<input
                          name="mcpAssetId"
                          type="number"
                          min="1"
                          value={record.mcpAssetId ?? ""}
                          readonly={!editor}
                        /></label
                      >
                    </div>
                    <label
                      >Notes<textarea
                        name="notes"
                        readonly={!editor}
                        maxlength="4000">{record.notes}</textarea
                      ></label
                    >
                    <div class="actions no-print">
                      {#if editor}<button disabled={busy || !detail.assignment}
                          >Save equipment</button
                        >{/if}{#if record.mcpAssetId && detail.client?.mcpClientId && detail.synchronization?.status === "synced"}<a
                          href={`${catalog.mcpflowUrl}/agent/asset_details.php?client_id=${detail.client.mcpClientId}&asset_id=${record.mcpAssetId}`}
                          target="_blank"
                          rel="noreferrer">Open MCPFlow asset</a
                        >{/if}
                    </div>
                  </form>
                </details>
              {:else}<p>No equipment in this rack.</p>{/each}
            </section>{:else}<p>
              No racks yet. Open the rack designer to add your first rack.
            </p>{/each}
          <footer>
            Prepared by ICT365 · Rackula infrastructure documentation
          </footer>
        {:else}<div class="empty">
            <h2>Your infrastructure, organized</h2>
            <p>
              Select a client and rack layout above to view racks, equipment
              records, MCPFlow links, and client report.
            </p>
          </div>{/if}
      </article>
    </div>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: #111827;
    color: #e5e7eb;
    font:
      15px/1.5 system-ui,
      sans-serif;
  }
  :global(a) {
    color: #60a5fa;
  }
  :global(button),
  .button {
    font: inherit;
    cursor: pointer;
    color: inherit;
    background: #253247;
    border: 1px solid #475569;
    border-radius: 7px;
    padding: 9px 13px;
    text-decoration: none;
  }
  :global(button:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(button:hover:not(:disabled)),
  .button:hover {
    border-color: #60a5fa;
  }
  :global(button:focus-visible),
  :global(a:focus-visible),
  :global(input:focus-visible),
  :global(select:focus-visible),
  :global(textarea:focus-visible) {
    outline: 3px solid #60a5fa;
    outline-offset: 2px;
  }
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
    width: 100%;
    padding: 9px;
    color: inherit;
    background: #111827;
    border: 1px solid #475569;
    border-radius: 6px;
  }
  :global(textarea) {
    min-height: 75px;
    resize: vertical;
  }
  :global(input[type="checkbox"]) {
    width: auto;
  }
  :global(label) {
    display: grid;
    gap: 5px;
    margin: 10px 0;
  }
  :global(h1) {
    font-size: 30px;
    margin: 0 0 10px;
  }
  :global(h2) {
    margin-top: 0;
    font-size: 22px;
  }
  :global(h3) {
    font-size: 18px;
  }
  :global(small) {
    color: #94a3b8;
    font-weight: 400;
  }
  :global(form) {
    margin-top: 14px;
  }
  :global(fieldset) {
    border: 1px solid #475569;
    border-radius: 7px;
    margin: 15px 0;
  }
  :global(p) {
    color: #b7c3d5;
  }
  .workspace-navigation {
    padding: 16px 28px 0;
  }
  main {
    max-width: 1600px;
    margin: auto;
    padding: 28px;
  }
  .page-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }
  .eyebrow {
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 2px;
    color: #fca5a5;
  }
  section,
  article,
  aside {
    background: #192335;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 22px;
  }
  .filters {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin: 20px 0;
  }
  .workspace-grid {
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
    gap: 22px;
  }
  aside {
    align-self: start;
  }
  .layout-row,
  .user-row {
    display: flex;
    flex-direction: column;
    align-items: start;
    text-align: left;
    width: 100%;
    margin: 10px 0;
    gap: 5px;
  }
  .selected {
    border-color: #f87171;
    background: #352a38;
  }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin: 18px 0;
  }
  .primary {
    background: #b91c1c;
    color: white;
    border-color: #dc2626;
  }
  .assignment,
  .inline-form {
    display: flex;
    align-items: end;
    gap: 14px;
    flex-wrap: wrap;
    padding: 15px;
    background: #111827;
    border-radius: 8px;
  }
  .assignment label,
  .inline-form label {
    flex: 1;
    min-width: 160px;
    margin: 0;
  }
  .assignment button,
  .inline-form button {
    margin-bottom: 0;
  }
  .inline-form {
    margin-bottom: 20px;
  }
  .equipment-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 14px;
  }
  .equipment {
    border-top: 1px solid #475569;
    padding: 15px 0;
  }
  .equipment summary {
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    gap: 15px;
  }
  .equipment summary span {
    font-size: 13px;
    color: #94a3b8;
  }
  .rack-section {
    margin-top: 20px;
    padding: 18px;
    background: #152030;
  }
  .rack-preview {
    background: #21222c;
    border-radius: 8px;
    overflow: auto;
    padding: 15px;
    margin-top: 20px;
  }
  .rack-preview :global(svg) {
    width: 100%;
    height: auto;
    max-height: 650px;
  }
  .admin-grid {
    display: grid;
    grid-template-columns: 1fr 1.4fr 1fr;
    gap: 22px;
    margin-top: 22px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .error {
    background: #7f1d1d;
    color: #fee2e2;
    padding: 15px;
    border-radius: 8px;
  }
  .message {
    background: #14532d;
    color: #dcfce7;
    padding: 15px;
    border-radius: 8px;
  }
  .empty {
    min-height: 300px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
  }
  .report-date {
    font-size: 12px;
  }
  footer {
    margin-top: 25px;
    padding-top: 15px;
    border-top: 1px solid #475569;
    color: #94a3b8;
    font-size: 12px;
  }
  @media (max-width: 900px) {
    .workspace-grid,
    .admin-grid {
      grid-template-columns: 1fr;
    }
    .equipment-grid {
      grid-template-columns: 1fr 1fr;
    }
    main {
      padding: 15px;
    }
    .filters {
      grid-template-columns: 1fr;
    }
    .page-title {
      align-items: start;
      flex-direction: column;
    }
    .equipment summary {
      flex-direction: column;
    }
  }
  .print-only {
    display: none;
  }
  @media print {
    .print-only {
      display: block;
    }
    .print-only table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
      margin-bottom: 20px;
    }
    .print-only th,
    .print-only td {
      border: 1px solid #bbb;
      padding: 5px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .print-only tr {
      break-inside: avoid;
    }
    .report-notes {
      white-space: pre-wrap;
    }
    .rack-section {
      display: none;
    }
    :global(body) {
      background: white;
      color: #111;
      font-size: 10pt;
    }
    :global(p),
    :global(small) {
      color: #333;
    }
    .no-print {
      display: none !important;
    }
    main {
      max-width: none;
      padding: 0;
    }
    .workspace-grid {
      display: block;
    }
    article,
    section {
      border: 0;
      background: white;
      padding: 0;
    }
    .rack-section {
      background: white;
      padding: 0;
      break-inside: avoid;
    }
    .equipment {
      break-inside: avoid;
    }
    :global(input),
    :global(textarea) {
      background: white;
      color: #111;
      border: 0;
      padding: 0;
      min-height: 0;
      resize: none;
    }
    :global(label) {
      font-size: 9pt;
      margin: 4px 0;
    }
    .equipment-grid {
      grid-template-columns: repeat(3, 1fr);
    }
    .rack-preview {
      print-color-adjust: exact;
      max-height: none;
    }
    .rack-preview :global(svg) {
      max-height: none;
    }
    .eyebrow {
      color: #b91c1c;
    }
    .equipment summary span {
      color: #333;
    }
    footer {
      color: #333;
    }
    .report-heading {
      border-bottom: 2px solid #b91c1c;
      margin-bottom: 15px;
    }
  }
</style>
