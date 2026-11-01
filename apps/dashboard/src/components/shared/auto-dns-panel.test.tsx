// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import type { DnsPlanResult, DnsProvisionResult } from "@/lib/api/dns";
import { useAutoDns, type UseAutoDns } from "./AutoDnsPanel";

const matched: DnsPlanResult = {
  status: "matched",
  provider: "cloudflare",
  zoneName: "example.com",
  records: [{ name: "app.example.com", type: "A", action: "create", desired: "192.0.2.5" }],
};
const applied: DnsProvisionResult = {
  provisioned: true,
  records: [{ name: "app.example.com", type: "A", outcome: "applied" }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
let state: UseAutoDns;
let plan: ReturnType<typeof vi.fn<() => Promise<DnsPlanResult>>>;
let apply: ReturnType<typeof vi.fn<() => Promise<DnsProvisionResult>>>;
function Harness({ target, revision }: { target: string; revision: number }) {
  state = useAutoDns(plan, apply, target, revision);
  return null;
}
async function render(target = "domain-one", revision = 0) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <Harness target={target} revision={revision} />
      </I18nProvider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  plan = vi.fn<() => Promise<DnsPlanResult>>().mockResolvedValue(matched);
  apply = vi.fn<() => Promise<DnsProvisionResult>>().mockResolvedValue(applied);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("automatic DNS async state", () => {
  it("admits one write for repeated presses and keeps it pending across a credential refresh", async () => {
    const writing = deferred<DnsProvisionResult>();
    apply.mockReturnValue(writing.promise);
    await render();
    await act(async () => {
      for (let i = 0; i < 5; i++) state.apply();
    });
    expect(apply).toHaveBeenCalledOnce();
    await render("domain-one", 1);
    expect(state.applying).toBe(true);
    await act(async () => state.apply());
    expect(apply).toHaveBeenCalledOnce();
    await act(async () => writing.resolve(applied));
    expect(state.applying).toBe(false);
    expect(state.result?.provisioned).toBe(true);
  });

  it("ignores a late write result for a different domain without unlocking the new domain's write", async () => {
    const oldWrite = deferred<DnsProvisionResult>();
    const newWrite = deferred<DnsProvisionResult>();
    apply.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    await render();
    await act(async () => state.apply());
    await render("domain-two");
    expect(state.result).toBeNull();
    await act(async () => state.apply());
    await act(async () => oldWrite.resolve(applied));
    expect(state.result).toBeNull();
    expect(state.applying).toBe(true);
    await act(async () =>
      newWrite.resolve({ provisioned: false, records: [], reason: "Token rejected" }),
    );
    expect(state.result?.reason).toBe("Token rejected");
    expect(state.applying).toBe(false);
  });

  it("discards stale plans when refresh fails and recovers on retry", async () => {
    await render();
    plan.mockRejectedValueOnce(new Error("DNS provider is unavailable"));
    await act(async () => state.reload());
    expect(state.plan).toBeNull();
    expect(state.loadError).toBe("DNS provider is unavailable");
    await act(async () => state.apply());
    expect(apply).not.toHaveBeenCalled();
    await act(async () => state.reload());
    expect(state.plan).toEqual(matched);
    expect(state.loadError).toBeNull();
  });

  it("does not allow a write while its refreshed preview is unresolved", async () => {
    await render();
    const reading = deferred<DnsPlanResult>();
    plan.mockReturnValueOnce(reading.promise);
    await act(async () => state.reload());
    expect(state.loading).toBe(true);
    await act(async () => state.apply());
    expect(apply).not.toHaveBeenCalled();
    await act(async () => reading.resolve(matched));
    await act(async () => state.apply());
    expect(apply).toHaveBeenCalledOnce();
  });
});
