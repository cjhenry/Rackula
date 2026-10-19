import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/svelte";
import OfficeHeader from "../lib/components/OfficeHeader.svelte";
import { dialogStore } from "$lib/stores/dialogs.svelte";

const catalog = {
  user: {
    id: "user",
    username: "alex",
    name: "Alex Smith",
    role: "admin" as const,
    clientIds: [],
    disabled: false,
  },
  clients: [
    { id: "a", name: "Client A" },
    { id: "b", name: "Client B" },
    { id: "empty", name: "Empty client" },
  ],
  layouts: [
    {
      id: "rack-a",
      name: "Server room A",
      assignment: { clientId: "a", siteId: "site-a", equipment: {} },
    },
    {
      id: "rack-b",
      name: "Server room B",
      assignment: { clientId: "b", siteId: "site-b", equipment: {} },
    },
    { id: "legacy", name: "Legacy rack", assignment: null },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  dialogStore.close();
});

describe("Office header", () => {
  it("requires a client and only offers that client's layouts", async () => {
    const onclientchange = vi.fn();
    const onlayoutchange = vi.fn();
    const { rerender } = render(OfficeHeader, {
      catalog,
      workspace: true,
      onclientchange,
      onlayoutchange,
    });
    expect(screen.getByLabelText("Rack layout")).toBeDisabled();
    await fireEvent.change(screen.getByLabelText("Client"), {
      target: { value: "a" },
    });
    expect(onclientchange).toHaveBeenCalledWith("a");
    await rerender({
      catalog,
      workspace: true,
      clientId: "a",
      onclientchange,
      onlayoutchange,
    });
    expect(
      screen.getByRole("option", { name: "Server room A" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Server room B" }),
    ).not.toBeInTheDocument();
    await fireEvent.change(screen.getByLabelText("Rack layout"), {
      target: { value: "rack-a" },
    });
    expect(onlayoutchange).toHaveBeenCalledWith("rack-a");
    await rerender({ catalog, workspace: true, clientId: "empty" });
    expect(screen.getByLabelText("Rack layout")).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "No layouts for this client" }),
    ).toBeInTheDocument();
  });

  it("keeps unassigned layouts available to administrators", () => {
    render(OfficeHeader, { catalog, workspace: true, clientId: "unassigned" });
    expect(
      screen.getByRole("option", { name: "Legacy rack" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Server room A" }),
    ).not.toBeInTheDocument();
  });

  it("shows account details and hides administration for viewers", async () => {
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, "showModal")
      .mockImplementation(() => {});
    render(OfficeHeader, {
      catalog: { ...catalog, user: { ...catalog.user, role: "viewer" } },
      workspace: true,
    });
    expect(
      screen.queryByRole("option", { name: "Unassigned layouts" }),
    ).not.toBeInTheDocument();
    await fireEvent.click(
      screen.getByText("Alex Smith", { selector: "summary span" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Account information" }),
    );
    expect(showModal).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Administration" }),
    ).not.toBeInTheDocument();
    showModal.mockRestore();
  });

  it("derives client context from a designer deep link and opens settings", async () => {
    history.replaceState({}, "", "/?layout=rack-b");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog))),
    );
    render(OfficeHeader);
    await waitFor(() =>
      expect(screen.getByLabelText("Client")).toHaveValue("b"),
    );
    expect(screen.getByLabelText("Rack layout")).toHaveValue("rack-b");
    await fireEvent.click(
      screen.getByText("Alex Smith", { selector: "summary span" }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(dialogStore.isOpen("settings")).toBe(true);
    history.replaceState({}, "", "/");
  });

  it("reports logout failure and keeps local data", async () => {
    localStorage.setItem("rackula-test-header", "keep");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(OfficeHeader, { catalog, workspace: true });
    await fireEvent.click(
      screen.getByText("Alex Smith", { selector: "summary span" }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Unable to sign out"),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(localStorage.getItem("rackula-test-header")).toBe("keep");
    localStorage.removeItem("rackula-test-header");
  });
});
