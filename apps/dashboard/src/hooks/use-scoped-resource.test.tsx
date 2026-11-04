// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useScopedResource } from "./use-scoped-resource";

const fixture = vi.hoisted(() => ({
  organizationId: "saved-workspace",
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user" }, session: { activeOrganizationId: "session-workspace" } },
  }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "cloud" }));
vi.mock("@/lib/api/client", () => ({
  getActiveOrganizationId: () => fixture.organizationId,
  subscribeActiveOrganization: (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => {
      fixture.listeners.delete(listener);
    };
  },
  getApiErrorMessage: (error: Error) => error.message,
}));

it("reloads under the actual workspace header and discards late results from the previous scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const pending = new Map<string, (value: string) => void>();
  const fetcher = vi.fn(
    () => new Promise<string>((resolve) => pending.set(fixture.organizationId, resolve)),
  );
  function Harness() {
    const resource = useScopedResource(fetcher);
    return <span>{resource.data ?? "loading"}</span>;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(pending.has("saved-workspace")).toBe(true);
    // The sidebar resolves the active workspace after the first request; session data is unchanged.
    await act(async () => {
      fixture.organizationId = "resolved-workspace";
      fixture.listeners.forEach((listener) => listener());
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("loading");
    await act(async () => pending.get("resolved-workspace")!("current assistant"));
    expect(container.textContent).toBe("current assistant");
    await act(async () => pending.get("saved-workspace")!("previous assistant"));
    expect(container.textContent).toBe("current assistant");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fixture.listeners.clear();
    vi.unstubAllGlobals();
  }
});
