import "./app.css";
import {
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
} from "$lib/utils/safe-storage";
import { mount } from "svelte";

async function start() {
  const response = await fetch("/api/office", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  if (response.ok) {
    const catalog = await response.json();
    const identity = JSON.stringify([
      catalog.user.id,
      catalog.user.role,
      catalog.user.clientIds.slice().sort(),
      catalog.layouts.map((layout: { id: string }) => layout.id).sort(),
    ]);
    if (safeGetItem("ict365-rackula-identity") !== identity) {
      for (const key of Object.keys(localStorage))
        if (/^rackula/i.test(key)) safeRemoveItem(key);
      for (const key of Object.keys(sessionStorage))
        if (/^rackula/i.test(key)) safeRemoveItem(key, "session");
      safeSetItem("ict365-rackula-identity", identity);
    }
  } else if (response.status !== 404) {
    throw new Error("Unable to verify workspace access. Reload to retry.");
  }
  const { default: App } = await import("./App.svelte");
  return mount(App, { target: document.getElementById("app")! });
}
const app = start().catch(() => {
  document.getElementById("app")!.textContent =
    "Unable to verify workspace access. Reload to retry.";
});
export default app;
