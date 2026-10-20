import { test, expect } from "@playwright/test";

test("operators see per-face diagram errors and can backfill/retry without publishing Documents", async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.route("**/api/office", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "admin",
          username: "admin",
          name: "Operator",
          role: "admin",
          clientIds: [],
          disabled: false,
        },
        clients: [],
        sites: [],
        layouts: [
          {
            id: "layout-a",
            name: "Server room",
            assignment: null,
            rackCount: 1,
            deviceCount: 2,
            updatedAt: "2026-10-20T00:00:00Z",
          },
        ],
        users: [],
        mcpflowUrl: "",
        integrationEnabled: true,
        synchronization: {
          enabled: true,
          previewsEnabled: false,
          sourceInstance: "ict365-rackula",
          scanError: null,
        },
      },
    }),
  );
  await page.route("**/api/office/sync-status", (route) =>
    route.fulfill({ json: { layouts: [] } }),
  );
  await page.route("**/api/office/preview-status", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        error: null,
        layouts: [
          {
            layoutId: "layout-a",
            revision: 42,
            current: true,
            jobs: [
              {
                rackId: "rack-1",
                face: "front",
                status: "error",
                error: "MCPFlow does not accept previews yet",
                warnings: ["Missing device image; label used"],
              },
            ],
          },
        ],
      },
    }),
  );
  for (const path of ["preview-backfill", "layouts/layout-a/preview-retry"])
    await page.route(`**/api/office/${path}`, (route) => {
      mutations.push(route.request().url());
      return route.fulfill({ json: { ok: true, queued: 1, errors: 0 } });
    });
  page.on("request", (request) => {
    if (request.url().endsWith("/push")) mutations.push(request.url());
  });
  await page.goto("/workspace.html");
  await expect(
    page.getByRole("heading", { name: "Rack diagrams: disabled" }),
  ).toBeVisible();
  await page.getByText("Server room: revision 42").click();
  await expect(page.getByRole("alert")).toContainText(
    "does not accept previews",
  );
  await expect(
    page.getByText("Missing device image; label used"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry diagrams" }).click();
  await expect(page.getByRole("status")).toContainText("Diagram retry queued");
  await page.getByRole("button", { name: "Backfill diagrams" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Diagram backfill queued",
  );
  expect(mutations.some((url) => url.endsWith("/preview-retry"))).toBe(true);
  expect(mutations.some((url) => url.endsWith("/preview-backfill"))).toBe(true);
  expect(mutations.some((url) => url.endsWith("/push"))).toBe(false);
});
