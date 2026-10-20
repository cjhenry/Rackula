import { test, expect } from "@playwright/test";

test("browser storage starts without the optional office API", async ({
  page,
}) => {
  await page.route("**/api/office", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unavailable" }),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Search or run a command" }),
  ).toBeVisible();
});
