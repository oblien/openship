// @vitest-environment happy-dom
/**
 * The server discovery card (docs/docker-service-discovery-plan.md, step 6).
 *
 * Under test here, against the REAL component and i18n copy with only the
 * network mocked:
 *   - the route chips reflect CONFIRMED routing state (a running container or
 *     a successful request must never read as an active route),
 *   - authorization failures from the API degrade to a readable state,
 *   - disruptive actions confirm first and cannot be double-submitted,
 *   - polling runs only while reconciliation is pending, and cleans up.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";
import { ToastProvider } from "@/components/toast";
import { ModalProvider } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import { DiscoveryCard, routePhase } from "./discovery-card";
import type { DiscoveryService, DiscoveryStatus } from "@/lib/api";
import { discoveryNeedsPolling } from "@/hooks/useServerDiscovery";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const discoveryApi = vi.hoisted(() => ({
  status: vi.fn(),
  configure: vi.fn(),
  rescan: vi.fn(),
  suppress: vi.fn(),
  unsuppress: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, discoveryApi };
});

function service(over: Partial<DiscoveryService> = {}): DiscoveryService {
  return {
    id: "dsb_1",
    serviceKey: "id:my-app",
    composeProject: "web",
    composeService: "app",
    hostname: "app.example.com",
    port: 3000,
    networkName: "web_default",
    observationStatus: "observed",
    containerName: "my-app",
    containerRunning: true,
    upstreamStrategy: "network-ip",
    ipAddress: "172.20.0.5",
    hostPort: null,
    applyState: "applied",
    applyError: null,
    applyAttempts: 0,
    nextApplyAt: null,
    withdrawalPending: false,
    suppressed: false,
    desiredGeneration: 2,
    appliedGeneration: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    tls: { hostname: "app.example.com", verified: true, sslStatus: "active", sslExpiresAt: null, sslIssuer: null },
    ...over,
  };
}

function status(over: Partial<DiscoveryStatus["settings"]> = {}, services: DiscoveryService[] = []): DiscoveryStatus {
  return {
    settings: {
      serverId: "srv_1",
      enabled: true,
      workspaceId: null,
      sweepIntervalSeconds: 60,
      lastScanAt: "2026-01-01T00:00:00.000Z",
      lastScanError: null,
      ...over,
    },
    services,
  };
}

function renderHtml(root: Root, ui: React.ReactElement) {
  let html = "";
  act(() => {
    root.render(ui);
  });
  html = document.body.textContent ?? "";
  return html;
}

const TEXT = (node: { textContent: string | null }) => (node.textContent ?? "").replace(/\s+/g, " ");

function mount(ui: React.ReactElement): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <ToastProvider>
          <ModalProvider>{ui}</ModalProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  });
  return { root, host };
}

beforeEach(() => {
  document.body.innerHTML = "";
  discoveryApi.status.mockResolvedValue(status());
  discoveryApi.configure.mockResolvedValue(status({ enabled: false }));
  discoveryApi.forget.mockResolvedValue({ forgotten: true });
  discoveryApi.suppress.mockResolvedValue(service({ suppressed: true }));
  discoveryApi.unsuppress.mockResolvedValue(service({ suppressed: false }));
  discoveryApi.rescan.mockResolvedValue({ serverId: "srv_1", failed: [], scan: { scanned: 1, ok: true }, reconcile: null, repair: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("routePhase derivation", () => {
  it("never reads 'active' from a running container alone", () => {
    // Container running + API-visible, but the first apply has not happened.
    expect(routePhase(service({ applyState: "pending", appliedGeneration: 0, tls: null }))).toBe("pending");
  });

  it("never reads 'active' for a STOPPED backend even when generations match", () => {
    // The reconciler records markApplied AFTER writing the unavailable (503)
    // vhost — matching generations + containerRunning:false is a retained
    // route, not a serving one.
    expect(routePhase(service({ containerRunning: false, applyState: "applied" }))).toBe("retained");
  });

  it("does not claim 'Unavailable' before the retained vhost write is confirmed", () => {
    // A stopped backend whose 503 write FAILED is a failed apply, not a
    // retained route.
    expect(routePhase(service({ containerRunning: false, applyState: "error", applyError: "edge down" }))).toBe("failed");
    // One whose write is still queued/in flight is reconciling.
    expect(routePhase(service({ containerRunning: false, applyState: "pending", desiredGeneration: 3, appliedGeneration: 2 }))).toBe("reconciling");
    // A conflict-blocked route never reads as retained either.
    expect(routePhase(service({ containerRunning: false, applyState: "blocked" }))).toBe("blocked");
    // Only the confirmed outcome (applied, generations matching — markApplied
    // runs after the edge write) reads as the retained unavailable form.
    expect(routePhase(service({ containerRunning: false, applyState: "applied" }))).toBe("retained");
  });

  it("a MISSING or INVALID BLOCKED backend reads blocked, never 'Unavailable'", () => {
    // The reconciler removes blocked routes outright (never 503-retained) and
    // only then clears withdrawalPending — the cleared flag confirms REMOVAL,
    // so the missing/invalid retained branch must not capture these rows.
    expect(routePhase(service({ observationStatus: "missing", applyState: "blocked" }))).toBe("blocked");
    expect(routePhase(service({ observationStatus: "invalid", applyState: "blocked" }))).toBe("blocked");
    // Unblocked missing rows keep the confirmed retained reading.
    expect(routePhase(service({ observationStatus: "missing", applyState: "applied" }))).toBe("retained");
  });

  it("reads retired rows when discovery is disabled, never active", () => {
    // Disable schedules withdrawals, the reconciler retires routes outright,
    // and markWithdrawn only clears the flag — the row keeps applied history,
    // so without the settings check it would render "Route active".
    expect(routePhase(service({ applyState: "applied" }), { discoveryEnabled: false })).toBe("retired");
    expect(routePhase(service({ applyState: "applied", withdrawalPending: true }), { discoveryEnabled: false })).toBe("withdrawing");
    // Nothing ever applied on a disabled server has no route truth to state.
    expect(routePhase(service({ applyState: "pending", appliedGeneration: 0, tls: null }), { discoveryEnabled: false })).toBe("unknown");
  });

  it("ranks confirmed truths: withdrawal > suppression > retired > retained > gap > applied", () => {
    expect(routePhase(service({ withdrawalPending: true, suppressed: true }))).toBe("withdrawing");
    expect(routePhase(service({ suppressed: true, observationStatus: "missing" }))).toBe("suppressed");
    expect(routePhase(service({ observationStatus: "missing", applyState: "applied" }))).toBe("retained");
    expect(routePhase(service({ desiredGeneration: 3, appliedGeneration: 2 }))).toBe("reconciling");
    expect(routePhase(service())).toBe("active");
    // A NEVER-applied missing backend is not "retained" — nothing existed to retain.
    expect(routePhase(service({ observationStatus: "missing", applyState: "pending", appliedGeneration: 0, tls: null }))).toBe("pending");
  });
});

describe("discoveryNeedsPolling", () => {
  it("polls while reconciliation, withdrawal, retry, or issuance is pending", () => {
    expect(discoveryNeedsPolling(status({}, [service({ desiredGeneration: 3, appliedGeneration: 2 })]))).toBe(true);
    expect(discoveryNeedsPolling(status({}, [service({ withdrawalPending: true })]))).toBe(true);
    expect(discoveryNeedsPolling(status({}, [service({ applyState: "error", applyError: "x" })]))).toBe(true);
    expect(discoveryNeedsPolling(status({}, [service({ tls: { hostname: "h", verified: false, sslStatus: "provisioning", sslExpiresAt: null, sslIssuer: null } })]))).toBe(true);
    expect(discoveryNeedsPolling(status({}, [service()]))).toBe(false);
  });

  it("a disabled server with nothing owed is settled", () => {
    expect(discoveryNeedsPolling(status({ enabled: false }, []))).toBe(false);
  });
});

describe("DiscoveryCard", () => {
  it("shows the disabled hint and an off switch when discovery is off", async () => {
    discoveryApi.status.mockResolvedValue(status({ enabled: false }, []));
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Discovery is off");
    expect(discoveryApi.configure).not.toHaveBeenCalled();
    root.unmount();
  });

  it("renders confirmed route phases as chips, never as 'active' from a running container", async () => {
    discoveryApi.status.mockResolvedValue(status({}, [
      service(),
      service({ serviceKey: "id:gap", id: "dsb_2", hostname: "gap.example.com", containerName: "gap", desiredGeneration: 3, appliedGeneration: 2 }),
      service({ serviceKey: "id:gone", id: "dsb_3", hostname: "gone.example.com", containerName: "gone", observationStatus: "missing", applyState: "applied" }),
      service({ serviceKey: "id:sup", id: "dsb_4", hostname: "sup.example.com", containerName: "sup", suppressed: true, containerRunning: true }),
      service({ serviceKey: "id:stopped", id: "dsb_5", hostname: "stopped.example.com", containerName: "stopped", containerRunning: false, applyState: "applied" }),
    ]));
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const text = TEXT(document.body);
    expect(text).toContain("Route active");
    expect(text).toContain("Reconciling");
    expect(text).toContain("Unavailable");
    expect(text).toContain("Suppressed");
    // Exactly ONE active chip: the stopped row must not read active.
    expect((text.match(/Route active/g) ?? []).length).toBe(1);
    root.unmount();
  });

  it("renders a 403 read as no-access, and other failures with retry", async () => {
    discoveryApi.status.mockRejectedValue(new ApiError(403, "Forbidden", { error: "no" }));
    const a = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    expect(TEXT(document.body)).toContain("You don't have permission");
    a.root.unmount();

    discoveryApi.status.mockRejectedValue(new ApiError(500, "boom", { error: "boom" }));
    const b = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    expect(TEXT(document.body)).toContain("Retry");
    b.root.unmount();
  });

  it("confirms before disabling, then configures enabled:false", async () => {
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const switches = Array.from(document.querySelectorAll('button[aria-label="Container discovery"]'));
    expect(switches.length).toBeGreaterThan(0);
    await act(async () => {
      (switches[0] as HTMLButtonElement).click();
    });
    // Confirmation modal first — no mutation yet.
    expect(discoveryApi.configure).not.toHaveBeenCalled();
    expect(TEXT(document.body)).toContain("Disable and remove routes");
    const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Disable and remove routes"));
    await act(async () => {
      (confirm as HTMLButtonElement).click();
    });
    expect(discoveryApi.configure).toHaveBeenCalledWith("srv_1", { enabled: false });
    root.unmount();
  });

  it("enabling needs no confirmation", async () => {
    discoveryApi.status.mockResolvedValue(status({ enabled: false }, []));
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const sw = Array.from(document.querySelectorAll('button[aria-label="Container discovery"]'));
    await act(async () => {
      (sw[0] as HTMLButtonElement).click();
    });
    expect(discoveryApi.configure).toHaveBeenCalledWith("srv_1", { enabled: true });
    root.unmount();
  });

  it("confirms forget, encodes nothing client-side (the api module encodes), and cannot double-submit", async () => {
    discoveryApi.status.mockResolvedValue(status({}, [service()]));
    let releaseForget: (() => void) | null = null;
    discoveryApi.forget.mockImplementation(
      () => new Promise<{ forgotten: boolean }>((resolve) => { releaseForget = () => resolve({ forgotten: true }); }),
    );
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const trigger = document.querySelector('button[aria-label="Service actions"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    const forgetItem = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Forget"));
    await act(async () => {
      (forgetItem as HTMLButtonElement).click();
    });
    // Modal first.
    expect(discoveryApi.forget).not.toHaveBeenCalled();
    const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Forget service"));
    await act(async () => {
      (confirm as HTMLButtonElement).click();
    });
    expect(discoveryApi.forget).toHaveBeenCalledTimes(1);
    expect(discoveryApi.forget).toHaveBeenCalledWith("srv_1", "id:my-app");

    // While the first forget is still in flight, a second attempt is a no-op.
    await act(async () => {
      trigger.click();
    });
    const forgetAgain = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Forget"));
    await act(async () => {
      if (forgetAgain) forgetAgain.click();
    });
    expect(discoveryApi.forget).toHaveBeenCalledTimes(1); // busy guard swallowed it
    await act(async () => {
      releaseForget!();
    });
    root.unmount();
  });

  it("an ENABLED settled list still refreshes on the slow idle cadence; a disabled one never polls", async () => {
    vi.useFakeTimers();
    discoveryApi.status.mockResolvedValue(status({ enabled: true }, [service()])); // settled
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const afterLoad = discoveryApi.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(discoveryApi.status.mock.calls.length).toBeGreaterThan(afterLoad); // idle poll fired
    root.unmount();

    // Disabled + settled: nothing server-side can change → no timers at all.
    discoveryApi.status.mockResolvedValue(status({ enabled: false }, []));
    const b = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const afterLoad2 = discoveryApi.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(discoveryApi.status.mock.calls.length).toBe(afterLoad2);
    b.root.unmount();
  });

  it("a rescan that returns 200 with stage failures shows a failure toast, not success", async () => {
    discoveryApi.rescan.mockResolvedValue({
      serverId: "srv_1",
      failed: [],
      scan: { scanned: 3, ok: true },
      reconcile: {
        applied: [], removed: [], retained: [], withdrawals: [],
        failed: [{ serviceKey: "id:my-app", reason: "edge down" }],
        ok: false,
      },
      repair: null,
    });
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const rescanButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Rescan"));
    await act(async () => {
      (rescanButton as HTMLButtonElement).click();
    });
    const text = TEXT(document.body);
    expect(text).toContain("Rescan finished with failures");
    expect(text).toContain("edge down");
    expect(text).not.toContain("Rescan complete");
    root.unmount();
  });

  it("a clean rescan still shows success", async () => {
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    const rescanButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Rescan"));
    await act(async () => {
      (rescanButton as HTMLButtonElement).click();
    });
    expect(TEXT(document.body)).toContain("Rescan complete");
    root.unmount();
  });

  it("polls only while reconciliation is pending, and stops after unmount", async () => {
    vi.useFakeTimers();
    discoveryApi.status.mockResolvedValueOnce(status({}, [service({ desiredGeneration: 3, appliedGeneration: 2 })]));
    discoveryApi.status.mockResolvedValue(status({}, [service()]));
    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {}); // flush the initial read so the pending state settles
    const callsAfterLoad = discoveryApi.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });
    expect(discoveryApi.status.mock.calls.length).toBeGreaterThan(callsAfterLoad); // pending → polled
    const callsWhilePending = discoveryApi.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(17_000);
    });
    expect(discoveryApi.status.mock.calls.length).toBe(callsWhilePending); // settled → no poll
    root.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(discoveryApi.status.mock.calls.length).toBe(callsWhilePending); // cleanup held
  });

  it("a superseded (stale) status response never overwrites a newer one", async () => {
    // Request 1 hangs; the enable-toggle triggers request 2, which lands while
    // request 1 is still outstanding. When the OLD response finally arrives it
    // must be discarded — a slow poll must never overwrite fresher data.
    discoveryApi.status.mockResolvedValue(status({ enabled: false }, []));
    let releaseSlow: ((v: DiscoveryStatus) => void) | null = null;
    const slow = new Promise<DiscoveryStatus>((resolve) => { releaseSlow = resolve; });
    discoveryApi.status.mockImplementationOnce(() => slow); // request 1 (the mount read)
    discoveryApi.status.mockResolvedValueOnce(status({ enabled: true }, [service({ hostname: "fresh.example.com" })])); // request 2

    const { root } = mount(<DiscoveryCard serverId="srv_1" />);
    await act(async () => {});
    expect(TEXT(document.body)).not.toContain("fresh.example.com"); // request 1 still outstanding

    const callsBeforeToggle = discoveryApi.status.mock.calls.length;
    const sw = Array.from(document.querySelectorAll('button[aria-label="Container discovery"]'));
    await act(async () => {
      (sw[0] as HTMLButtonElement).click(); // enable → refresh (request 2, resolves immediately)
    });
    expect(discoveryApi.status.mock.calls.length).toBe(callsBeforeToggle + 1); // request 2 fired behind the toggle

    // The slow OLD read lands last — it must lose.
    await act(async () => {
      releaseSlow!(status({}, [service({ hostname: "stale.example.com" })]));
    });
    expect(TEXT(document.body)).toContain("fresh.example.com");
    expect(TEXT(document.body)).not.toContain("stale.example.com");
    root.unmount();
  });
});
