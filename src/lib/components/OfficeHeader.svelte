<script lang="ts">
  import { onMount } from "svelte";
  import type { Client, Assignment, OfficeUser } from "$lib/types/office";
  import { safeRemoveItem } from "$lib/utils/safe-storage";
  import { dialogStore } from "$lib/stores/dialogs.svelte";

  type Catalog = {
    user: OfficeUser;
    clients: Client[];
    layouts: { id: string; name: string; assignment: Assignment | null }[];
  };
  let {
    catalog: suppliedCatalog,
    clientId = "",
    layoutId = "",
    workspace = false,
    busy = false,
    onclientchange,
    onlayoutchange,
    onadmin,
  }: {
    catalog?: Catalog | null;
    clientId?: string;
    layoutId?: string;
    workspace?: boolean;
    busy?: boolean;
    onclientchange?: (id: string) => void;
    onlayoutchange?: (id: string) => void;
    onadmin?: () => void;
  } = $props();
  let loadedCatalog = $state<Catalog | null>(null);
  const catalog = $derived(suppliedCatalog ?? loadedCatalog);
  let selectedClient = $state("");
  let selectedLayout = $state("");
  let menuOpen = $state(false);
  let error = $state("");
  let signingOut = $state(false);
  let accountDialog = $state<HTMLDialogElement>();
  let userMenu = $state<HTMLDetailsElement>();
  const currentClient = $derived(workspace ? clientId : selectedClient);
  const currentLayout = $derived(workspace ? layoutId : selectedLayout);
  const layouts = $derived(
    catalog?.layouts.filter((row) =>
      currentClient === "unassigned"
        ? !row.assignment
        : !!currentClient && row.assignment?.clientId === currentClient,
    ) ?? [],
  );
  onMount(() => {
    if (workspace) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/office", {
          credentials: "same-origin",
          cache: "no-store",
        });
        // The same designer also supports deployments without the office API.
        if (response.status === 404) return;
        if (response.status === 401) {
          location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
          return;
        }
        if (!response.ok)
          throw new Error(
            "Unable to load clients and account. Reload to retry.",
          );
        const result: Catalog = await response.json();
        if (cancelled) return;
        loadedCatalog = result;
        selectedLayout =
          new URLSearchParams(location.search).get("layout") ?? "";
        const row = result.layouts.find((item) => item.id === selectedLayout);
        selectedClient = row?.assignment?.clientId ?? (row ? "unassigned" : "");
      } catch (err) {
        if (!cancelled)
          error =
            err instanceof Error ? err.message : "Unable to load workspace";
      }
    })();
    return () => {
      cancelled = true;
    };
  });
  function chooseClient(id: string) {
    if (workspace) onclientchange?.(id);
    else {
      selectedClient = id;
      selectedLayout = "";
    }
  }
  function chooseLayout(id: string) {
    if (!id) return;
    if (workspace) onlayoutchange?.(id);
    else location.href = `/?layout=${encodeURIComponent(id)}`;
  }
  function closeMenu() {
    menuOpen = false;
  }
  async function logout() {
    if (signingOut) return;
    signingOut = true;
    error = "";
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error("Unable to sign out. Please try again.");
      for (const key of Object.keys(localStorage))
        if (/^rackula/i.test(key)) safeRemoveItem(key);
      location.href = "/auth/login";
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to sign out";
    } finally {
      signingOut = false;
    }
  }
</script>

<svelte:window
  onclick={(event) => {
    if (menuOpen && !userMenu?.contains(event.target as Node)) closeMenu();
  }}
  onkeydown={(event) => {
    if (event.key === "Escape" && menuOpen) {
      closeMenu();
      userMenu?.querySelector("summary")?.focus();
    }
  }}
/>
{#if catalog}
  <header class="office-header" aria-label="Client workspace">
    <a class="brand" href="/workspace.html"
      ><strong>ICT<span>365</span></strong><small>Rackula</small></a
    >
    <div class="selectors">
      <label
        >Client
        <select
          aria-label="Client"
          value={currentClient}
          disabled={busy}
          onchange={(event) => chooseClient(event.currentTarget.value)}
        >
          <option value="">Select a client</option>
          {#each catalog.clients as client (client.id)}<option value={client.id}
              >{client.name}</option
            >{/each}
          {#if catalog.user.role === "admin"}<option value="unassigned"
              >Unassigned layouts</option
            >{/if}
        </select>
      </label>
      <label
        >Rack layout
        <select
          aria-label="Rack layout"
          value={layouts.some((row) => row.id === currentLayout)
            ? currentLayout
            : ""}
          disabled={busy || !currentClient || !layouts.length}
          onchange={(event) => chooseLayout(event.currentTarget.value)}
        >
          <option value=""
            >{!currentClient
              ? "Select a client first"
              : !layouts.length
                ? "No layouts for this client"
                : "Select a rack layout"}</option
          >
          {#each layouts as row (row.id)}<option value={row.id}
              >{row.name}</option
            >{/each}
        </select>
      </label>
    </div>
    <details class="user-menu" bind:this={userMenu} bind:open={menuOpen}>
      <summary
        ><span class="avatar" aria-hidden="true"
          >{catalog.user.name.slice(0, 1).toUpperCase()}</span
        ><span>{catalog.user.name}<small>{catalog.user.role}</small></span><span
          aria-hidden="true">▾</span
        ></summary
      >
      <nav aria-label="Account menu">
        <button
          type="button"
          onclick={() => {
            closeMenu();
            accountDialog?.showModal();
          }}>Account information</button
        >
        <button
          type="button"
          onclick={() => {
            closeMenu();
            if (workspace)
              location.href = `/?settings=1${currentLayout ? `&layout=${encodeURIComponent(currentLayout)}` : ""}`;
            else dialogStore.open("settings");
          }}>Settings</button
        >
        {#if catalog.user.role === "admin"}
          {#if workspace}<button
              type="button"
              onclick={() => {
                closeMenu();
                onadmin?.();
              }}>Administration</button
            >
          {:else}<a href="/workspace.html?tab=admin">Administration</a>{/if}
        {/if}
        <a
          href={workspace
            ? currentLayout
              ? `/?layout=${encodeURIComponent(currentLayout)}`
              : "/"
            : currentLayout
              ? `/workspace.html?layout=${encodeURIComponent(currentLayout)}`
              : "/workspace.html"}
          >{workspace ? "Rack designer" : "Workspace and reports"}</a
        >
        <button type="button" disabled={signingOut} onclick={logout}
          >{signingOut ? "Signing out…" : "Sign out"}</button
        >
      </nav>
    </details>
  </header>
  <dialog bind:this={accountDialog} aria-labelledby="account-title">
    <h2 id="account-title">Account information</h2>
    <dl>
      <dt>Name</dt>
      <dd>{catalog.user.name}</dd>
      <dt>Username</dt>
      <dd>{catalog.user.username}</dd>
      <dt>Role</dt>
      <dd>{catalog.user.role}</dd>
      <dt>Client access</dt>
      <dd>
        {catalog.user.role === "admin"
          ? "All clients"
          : catalog.clients.map((client) => client.name).join(", ") ||
            "No clients assigned"}
      </dd>
    </dl>
    <form method="dialog"><button type="submit">Close</button></form>
  </dialog>
{/if}
{#if error}<p class="header-error" role="alert">{error}</p>{/if}

<style>
  .office-header {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 12px 24px;
    background: #182234;
    color: #e5e7eb;
    border-bottom: 1px solid #334155;
    flex-shrink: 0;
    position: relative;
    z-index: calc(var(--z-sidebar, 60) + 2);
    font:
      14px/1.4 system-ui,
      sans-serif;
  }
  .brand {
    display: grid;
    text-decoration: none;
    color: inherit;
    flex-shrink: 0;
  }
  .brand strong {
    font-size: 23px;
    letter-spacing: -1px;
  }
  .brand strong span {
    color: #f87171;
  }
  small {
    display: block;
    color: #94a3b8;
    font-size: 12px;
  }
  .selectors {
    display: flex;
    gap: 16px;
    flex: 1;
    min-width: 0;
    max-width: 760px;
  }
  label {
    display: grid;
    gap: 4px;
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 12px;
    color: #b7c3d5;
  }
  select {
    box-sizing: border-box;
    font:
      14px system-ui,
      sans-serif;
    width: 100%;
    min-height: 38px;
    padding: 8px 30px 8px 10px;
    border: 1px solid #475569;
    border-radius: 7px;
    background: #111827;
    color: #e5e7eb;
  }
  select:disabled {
    opacity: 0.6;
  }
  .user-menu {
    margin-left: auto;
    position: relative;
    flex-shrink: 0;
  }
  summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px;
    border-radius: 7px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #334155;
    color: #93c5fd;
    font-weight: 700;
  }
  nav {
    position: absolute;
    right: 0;
    top: calc(100% + 10px);
    width: 240px;
    display: grid;
    padding: 6px;
    background: #182234;
    border: 1px solid #475569;
    border-radius: 10px;
    box-shadow: 0 12px 32px #0006;
  }
  nav button,
  nav a {
    display: block;
    border: 0;
    background: transparent;
    color: #e5e7eb;
    text-decoration: none;
    text-align: left;
    padding: 10px 12px;
    font:
      14px system-ui,
      sans-serif;
    cursor: pointer;
    border-radius: 5px;
  }
  nav button:hover,
  nav a:hover,
  summary:hover {
    background: #253247;
  }
  :is(a, button, select, summary):focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 3px;
  }
  dialog {
    box-sizing: border-box;
    width: min(480px, calc(100% - 32px));
    max-height: 80vh;
    overflow: auto;
    padding: 24px;
    background: #182234;
    color: #e5e7eb;
    border: 1px solid #475569;
    border-radius: 12px;
    font:
      15px/1.5 system-ui,
      sans-serif;
  }
  dialog::backdrop {
    background: #0009;
  }
  dialog h2 {
    margin: 0 0 20px;
    font-size: 22px;
  }
  dt {
    color: #94a3b8;
    font-size: 12px;
  }
  dd {
    margin: 2px 0 16px;
    overflow-wrap: anywhere;
  }
  dialog button {
    padding: 8px 16px;
    background: #253247;
    color: #e5e7eb;
    border: 1px solid #475569;
    border-radius: 6px;
    cursor: pointer;
  }
  dialog form {
    margin: 0;
    text-align: right;
  }
  .header-error {
    color: #fecaca;
    background: #450a0a;
    margin: 0;
    padding: 12px 24px;
  }
  @media (max-width: 760px) {
    .office-header {
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px 16px;
    }
    .selectors {
      order: 3;
      flex-basis: 100%;
      max-width: none;
      gap: 10px;
    }
    .user-menu {
      margin-left: auto;
    }
  }
  @media print {
    .office-header,
    dialog,
    .header-error {
      display: none;
    }
  }
</style>
