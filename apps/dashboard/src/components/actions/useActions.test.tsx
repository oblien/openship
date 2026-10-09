// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActionResource } from "./useActions";

const state = vi.hoisted(() => ({ org: "a", user: "alice", cloud: "local" }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: state.user }, session: { activeOrganizationId: state.org } },
  }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => state.cloud }));
let root: Root;
let host: HTMLDivElement;
let view: ReturnType<typeof useActionResource<string>>;
function View({ load, interval = 0 }: { load: () => Promise<string>; interval?: number }) {
  view = useActionResource(load, interval);
  return <output>{view.data ?? "loading"}</output>;
}
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.org = "a";
  state.user = "alice";
  state.cloud = "local";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("Actions scope and refresh", () => {
  it.each(["org", "user", "cloud"] as const)(
    "ignores an old account response after changing %s",
    async (key) => {
      const old = deferred();
      const current = deferred();
      const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      await act(async () => root.render(<View load={load} />));
      state[key] = "other";
      await act(async () => root.render(<View load={load} />));
      await act(async () => current.resolve("current-scope"));
      await act(async () => old.resolve("private-old-scope"));
      expect(host.textContent).toBe("current-scope");
    },
  );

  it("hides the previous job immediately when the resource identity changes", async () => {
    const pending = deferred();
    const first = async () => "first-job";
    const second = () => pending.promise;
    await act(async () => root.render(<View load={first} />));
    expect(host.textContent).toBe("first-job");
    await act(async () => root.render(<View load={second} />));
    expect(host.textContent).toBe("loading");
    await act(async () => pending.resolve("second-job"));
    expect(host.textContent).toBe("second-job");
  });

  it("keeps visible logs while retrying and never overlaps polling requests", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce("saved-logs").mockReturnValue(pending.promise);
    await act(async () => root.render(<View load={load} interval={1000} />));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("saved-logs");
    await act(async () => pending.resolve("new-logs"));
    expect(host.textContent).toBe("new-logs");
  });
});
