import { test, expect } from "@playwright/test";

const clients = [
  { id: "a", name: "Client A", mcpClientId: 1 },
  { id: "b", name: "Client B", mcpClientId: 2 },
];
const sites = [
  { id: "site-a", clientId: "a", name: "Main" },
  { id: "site-b", clientId: "b", name: "Main" },
];
const layouts = clients.map((client) => ({
  id: `rack-${client.id}`,
  name: `Server room ${client.id.toUpperCase()}`,
  rackCount: 0,
  deviceCount: 0,
  assignment: {
    clientId: client.id,
    siteId: `site-${client.id}`,
    equipment: {},
  },
  updatedAt: "2026-10-19T00:00:00Z",
}));

test("shows delivery errors and retries or backfills snapshots without publishing reports", async ({
  page,
}) => {
  let deliveryStatus = "error";
  const mutations: string[] = [];
  await page.route("**/api/office", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "user",
          username: "alex",
          name: "Alex Smith",
          role: "admin",
          clientIds: [],
          disabled: false,
        },
        clients,
        sites,
        layouts,
        users: [],
        mcpflowUrl: "",
        integrationEnabled: true,
        synchronization: {
          enabled: true,
          sourceInstance: "ict365-rackula",
          scanError: null,
        },
      },
    }),
  );
  await page.route("**/api/office/sync-status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        layouts: [
          {
            layoutId: "rack-a",
            status: deliveryStatus,
            revision: 2,
            acknowledgedRevision: 1,
            error:
              deliveryStatus === "error"
                ? "Linked asset belongs to another client"
                : undefined,
          },
        ],
      },
    }),
  );
  await page.route("**/api/office/layouts/rack-a/sync-retry", (route) => {
    mutations.push(route.request().url());
    deliveryStatus = "pending";
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/office/sync-backfill", (route) => {
    mutations.push(route.request().url());
    return route.fulfill({ json: { queued: 1, skipped: 1, errors: 0 } });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/push")) mutations.push(request.url());
  });
  await page.goto("/workspace.html");
  await page
    .getByText("MCPFlow synchronization: automatic delivery enabled")
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Linked asset belongs to another client",
  );
  await page
    .getByRole("button", { name: "Retry delivery", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Delivery queued for retry",
  );
  await page
    .getByRole("button", { name: "Backfill linked saved layouts" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "1 queued, 1 unassigned, 0 needing attention",
  );
  expect(mutations.some((url) => url.endsWith("/sync-retry"))).toBe(true);
  expect(mutations.some((url) => url.endsWith("/sync-backfill"))).toBe(true);
  expect(mutations.some((url) => url.endsWith("/push"))).toBe(false);
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/office", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "user",
          username: "alex",
          name: "Alex Smith",
          role: "admin",
          clientIds: [],
          disabled: false,
        },
        clients,
        sites,
        layouts,
        users: [],
        mcpflowUrl: "",
        integrationEnabled: false,
      },
    }),
  );
  await page.route("**/api/office/layouts/*", (route) => {
    const row = layouts.find((item) =>
      route.request().url().endsWith(item.id),
    )!;
    return route.fulfill({
      json: {
        ...row,
        layout: { name: row.name, racks: [], device_types: [] },
        client: clients.find((item) => item.id === row.assignment.clientId),
        site: sites.find((item) => item.id === row.assignment.siteId),
      },
    });
  });
});

test("selects clients and layouts, clears stale context, and opens account menu", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/workspace.html");
  const header = page.getByRole("banner", { name: "Client workspace" });
  await header.getByLabel("Client", { exact: true }).selectOption("a");
  await expect(header.getByLabel("Rack layout").locator("option")).toHaveText([
    "Select a rack layout",
    "Server room A",
  ]);
  await header.getByLabel("Rack layout").selectOption("rack-a");
  await expect(
    page.getByRole("heading", { name: "Server room A" }),
  ).toBeVisible();
  await header.getByLabel("Client", { exact: true }).selectOption("b");
  await expect(
    page.getByRole("heading", { name: "Server room A" }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/layout=/);
  await expect(header.getByLabel("Rack layout").locator("option")).toHaveText([
    "Select a rack layout",
    "Server room B",
  ]);
  await header.locator("summary").click();
  await header.getByRole("button", { name: "Account information" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("alex");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await header.locator("summary").click();
  await header.getByRole("button", { name: "Administration" }).click();
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to racks" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(header.getByLabel("Client", { exact: true })).toBeVisible();
  await expect(header.getByLabel("Rack layout")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/rackula-header-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await header.getByLabel("Rack layout").selectOption("rack-b");
  await page.screenshot({
    path: "/tmp/rackula-header-desktop.png",
    fullPage: true,
  });
  await header.locator("summary").click();
  await header.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/settings=1&layout=rack-b/);
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test("shows the same client header in the designer and opens settings", async ({
  page,
}) => {
  await page.goto("/?layout=rack-b");
  const header = page.getByRole("banner", { name: "Client workspace" });
  await expect(header.getByLabel("Client", { exact: true })).toHaveValue("b");
  await expect(header.getByLabel("Rack layout")).toHaveValue("rack-b");
  await header.locator("summary").click();
  await header.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
});
