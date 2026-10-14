<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import { safeRemoveItem } from "$lib/utils/safe-storage";
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
  };
  type Detail = {
    id: string;
    layout: Layout;
    assignment: Assignment | null;
    client: Client | null;
    site: Site | null;
    updatedAt: string;
  };
  let catalog = $state<Catalog | null>(null);
  let detail = $state<Detail | null>(null);
  let clientId = $state("");
  let siteId = $state("");
  let search = $state("");
  let tab = $state("racks");
  let error = $state("");
  let message = $state("");
  let busy = $state(false);
  let assignmentClient = $state("");
  let assignmentSite = $state("");
  let newClientName = $state("");
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
        (!clientId || row.assignment?.clientId === clientId) &&
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
      message = success;
    } catch (err) {
      error = err instanceof Error ? err.message : "Request failed";
    } finally {
      busy = false;
    }
  }
  async function reload() {
    catalog = await api<Catalog>();
  }
  async function openLayout(id: string) {
    detail = await api<Detail>(`/layouts/${encodeURIComponent(id)}`);
    assignmentClient = detail.assignment?.clientId ?? clientId;
    assignmentSite = detail.assignment?.siteId ?? "";
    const query = new SvelteURLSearchParams(location.search);
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
  async function logout() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Unable to sign out");
    for (const key of Object.keys(localStorage))
      if (/^rackula/i.test(key)) safeRemoveItem(key);
    location.href = "/auth/login";
  }
  onMount(() => {
    void action(async () => {
      await reload();
      const params = new SvelteURLSearchParams(location.search);
      const mcpClient = params.get("client_id");
      clientId =
        clients.find((client) => String(client.mcpClientId) === mcpClient)
          ?.id ?? "";
      const layoutId = params.get("layout");
      if (layoutId) await openLayout(layoutId);
    }, "");
  });
</script>

<svelte:head><title>ICT365 | Rackula Workspace</title></svelte:head>
<header class="no-print">
  <a class="brand" href="/workspace.html"
    ><span class="brand-mark">ICT<span>365</span></span><span
      >Rackula Workspace</span
    ></a
  >
  <nav aria-label="Workspace">
    <button class:active={tab === "racks"} onclick={() => (tab = "racks")}
      >Clients and racks</button
    >
    {#if admin}<button
        class:active={tab === "admin"}
        onclick={() => (tab = "admin")}>Administration</button
      >{/if}
    <a href="/">Rack designer</a><button
      disabled={busy}
      onclick={() => action(logout, "")}>Sign out</button
    >
  </nav>
</header>
<main>
  {#if error}<p role="alert" class="error no-print">{error}</p>{/if}
  {#if message}<p role="status" class="message no-print">{message}</p>{/if}
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
                clientId,
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
            >Client<select required bind:value={clientId}
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
        <h1>Clients, sites, and racks</h1>
        <p>{catalog.user.name} · {catalog.user.role}</p>
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
        >Client<select
          bind:value={clientId}
          onchange={() => {
            siteId = "";
            detail = null;
          }}
          ><option value="">All permitted clients</option
          >{#each clients as client (client.id)}<option value={client.id}
              >{client.name}</option
            >{/each}</select
        ></label
      >
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
    {#if editor && clientId && siteId}<form
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
                        maxlength="5000">{record.notes}</textarea
                      ></label
                    >
                    <div class="actions no-print">
                      {#if editor}<button disabled={busy || !detail.assignment}
                          >Save equipment</button
                        >{/if}{#if record.mcpAssetId && detail.client?.mcpClientId}<a
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
              Select a layout to view its racks, equipment records, MCPFlow
              links, and client report.
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
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 18px 28px;
    background: #182234;
    border-bottom: 1px solid #334155;
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 16px;
    color: #e5e7eb;
    text-decoration: none;
  }
  .brand-mark {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -1px;
  }
  .brand-mark span {
    color: #f87171;
  }
  nav {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  nav a {
    padding: 9px;
  }
  nav .active {
    border-color: #f87171;
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
    grid-template-columns: 1fr 1fr 1fr;
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
    header {
      padding: 15px;
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
