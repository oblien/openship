// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainDnsChallenge } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import DnsChallengePanel from "./DnsChallengePanel";

const api = vi.hoisted(() => ({
  dnsChallenge: vi.fn(),
  startDnsChallenge: vi.fn(),
  checkDnsChallenge: vi.fn(),
  cancelDnsChallenge: vi.fn(),
  records: vi.fn(),
  dnsPlan: vi.fn(),
  dnsApply: vi.fn(),
  changed: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  domainsApi: api,
  getApiErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

const c = baseDictionary.projectSettings.domains.wildcard;
const attempt = (
  status: DomainDnsChallenge["status"],
  patch: Partial<DomainDnsChallenge> = {},
): DomainDnsChallenge => ({
  id: "dns_attempt",
  domainId: "domain",
  mode: "manual",
  status,
  record: { type: "TXT", name: "_acme-challenge.example.com", value: "actual-ACME-proof" },
  expiresAt: "2030-01-02T00:00:00Z",
  logs: "Prepared the TXT record.\n",
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  updatedAt: "2030-01-01T00:00:00Z",
  ...patch,
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.dnsChallenge.mockResolvedValue({ data: null });
  api.records.mockResolvedValue({
    data: {
      mode: "selfhosted",
      records: [{ type: "A", host: "*", name: "*.example.com", value: "192.0.2.5" }],
    },
  });
  api.dnsPlan.mockResolvedValue({ data: { status: "none", records: [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(domainId = "domain", renew = false) {
  await act(async () =>
    root.render(
      <StrictMode>
        <I18nProvider>
          <DnsChallengePanel
            domainId={domainId}
            hostname="*.example.com"
            mode="manual"
            renew={renew}
            onChanged={api.changed}
            onClose={() => {}}
          />
        </I18nProvider>
      </StrictMode>,
    ),
  );
}
function button(label: string) {
  const match = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(match, label).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function tick() {
  await act(async () => vi.advanceTimersByTimeAsync(2500));
}

describe("inline DNS certificate setup", () => {
  it("recovers the saved TXT on reopen without starting an order or polling while waiting", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    await render();
    expect(host.textContent).toContain("actual-ACME-proof");
    expect(host.textContent).toContain(c.manualHint);
    expect(button(c.automatic).disabled).toBe(true);
    expect(api.startDnsChallenge).not.toHaveBeenCalled();
    const reads = api.dnsChallenge.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.dnsChallenge).toHaveBeenCalledTimes(reads);
  });

  it("keeps the saved TXT visible when the routing preview is unavailable", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    api.records.mockRejectedValue(new Error("Cannot reach the deployment server"));
    await render();
    expect(host.textContent).toContain("actual-ACME-proof");
    expect(host.textContent).toContain("Cannot reach the deployment server");
    expect(button(c.check).disabled).toBe(false);
  });

  it("shows saved TXT and allows checking while the server address is still loading", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    let failRecords!: (error: Error) => void;
    api.records.mockImplementation(
      () =>
        new Promise((_, reject) => {
          failRecords = reject;
        }),
    );
    await render();
    expect(host.textContent).toContain("actual-ACME-proof");
    api.checkDnsChallenge.mockResolvedValue({ data: attempt("checking") });
    await click(c.check);
    expect(api.checkDnsChallenge).toHaveBeenCalledExactlyOnceWith("domain", "dns_attempt");
    await act(async () => failRecords(new Error("Server is unavailable")));
    expect(host.textContent).toContain("Server is unavailable");
    expect(host.textContent).toContain(c.states.checking);
  });

  it("runs start → TXT → check → completed and stops polling after the result", async () => {
    await render();
    api.startDnsChallenge.mockResolvedValue({ data: attempt("preparing", { record: null }) });
    await click(c.startManual);
    expect(api.startDnsChallenge).toHaveBeenCalledExactlyOnceWith("domain", {
      mode: "manual",
      force: false,
    });
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    await tick();
    expect(host.textContent).toContain("actual-ACME-proof");
    api.checkDnsChallenge.mockResolvedValue({ data: attempt("checking") });
    await click(c.check);
    expect(api.checkDnsChallenge).toHaveBeenCalledExactlyOnceWith("domain", "dns_attempt");
    api.dnsChallenge.mockResolvedValue({ data: attempt("completed") });
    await tick();
    expect(host.textContent).toContain(c.states.completed);
    expect(host.textContent).toContain(c.cleanup);
    expect(api.changed).toHaveBeenCalled();
    const reads = api.dnsChallenge.mock.calls.length;
    await tick();
    expect(api.dnsChallenge).toHaveBeenCalledTimes(reads);
  });

  it("refreshes after a lost response and follows the existing worker instead of starting again", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    await render();
    api.checkDnsChallenge.mockRejectedValue(new Error("Connection was interrupted"));
    await click(c.check);
    expect(host.textContent).toContain("Connection was interrupted");
    api.dnsChallenge.mockResolvedValue({ data: attempt("installing") });
    await click(c.refresh);
    expect(host.textContent).toContain(c.states.installing);
    api.dnsChallenge.mockResolvedValue({ data: attempt("completed") });
    await tick();
    expect(host.textContent).toContain(c.states.completed);
    expect(api.startDnsChallenge).not.toHaveBeenCalled();
  });

  it("cancels the current attempt before enabling a different setup method", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    await render();
    api.cancelDnsChallenge.mockResolvedValue({ data: attempt("cancelled") });
    await click(c.cancel);
    expect(api.cancelDnsChallenge).toHaveBeenCalledExactlyOnceWith("domain", "dns_attempt");
    expect(button(c.automatic).disabled).toBe(false);
    await click(c.automatic);
    api.startDnsChallenge.mockResolvedValue({
      data: attempt("installing", { mode: "automatic", record: null }),
    });
    await click(c.startAutomatic);
    expect(api.startDnsChallenge).toHaveBeenCalledWith("domain", {
      mode: "automatic",
      force: false,
    });
  });

  it("explicit renewal requests a fresh challenge, while ordinary setup does not force issuance", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("completed") });
    await render("domain", true);
    api.startDnsChallenge.mockResolvedValue({
      data: attempt("preparing", { id: "renewal", record: null }),
    });
    await click(c.renew);
    expect(api.startDnsChallenge).toHaveBeenCalledWith("domain", { mode: "manual", force: true });
  });

  it("discards a late action from another domain and releases the new domain's controls", async () => {
    api.dnsChallenge.mockResolvedValue({ data: attempt("waiting") });
    await render();
    let finish!: (value: { data: DomainDnsChallenge }) => void;
    api.checkDnsChallenge.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await click(c.check);
    expect(button(c.check).disabled).toBe(true);
    api.dnsChallenge.mockResolvedValue({
      data: attempt("waiting", { id: "different", domainId: "new-domain" }),
    });
    await render("new-domain");
    await act(async () => finish({ data: attempt("completed") }));
    expect(host.textContent).not.toContain(c.states.completed);
    expect(button(c.check).disabled).toBe(false);
  });
});
