// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import { UNKNOWN_OUTCOME_MESSAGE } from "@/hooks/prepare-stream-outcome";
import { DomainSettings } from "./DomainSettings";

const mocks = vi.hoisted(() => ({
  settings: {} as any,
  invalidate: vi.fn(),
  toast: vi.fn(),
  fetch: vi.fn(),
  listDomains: vi.fn(),
  verifySsl: vi.fn(),
  checkPorts: vi.fn(),
  edgeStatus: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: () => mocks.settings }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ baseDomain: "opsh.io", selfHosted: true }),
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ requireCloud: vi.fn(), connected: false }),
}));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: mocks.invalidate }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    getApiBaseUrl: () => "http://localhost:4000/api/",
    projectsApi: {
      ...actual.projectsApi,
      getEdgeStatus: mocks.edgeStatus,
      listRouteProtection: async () => ({ data: [] }),
    },
    domainsApi: { ...actual.domainsApi, list: mocks.listDomains, verifySsl: mocks.verifySsl },
    deployApi: {
      ...actual.deployApi,
      checkPorts: mocks.checkPorts,
      checkOutput: async () => ({ data: [] }),
    },
  };
});
vi.mock("./RoutingConfigCard", () => ({ RoutingConfigCard: () => null }));
vi.mock("./RouteRules", () => ({ RouteRules: () => null }));

let host: HTMLDivElement;
let root: Root;
let stream: ReadableStreamDefaultController<Uint8Array>;
const retryCopy = baseDictionary.projects.routingRetry;
const retryStartUrl =
  /^http:\/\/localhost:4000\/api\/projects\/project-a\/routing\/retry\/stream\?idempotencyKey=[\da-f-]+$/;
const names = ["api", "app", "web"];
const ports = [4010, 3021, 3022];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkPorts.mockResolvedValue({ data: [] });
  mocks.edgeStatus.mockResolvedValue({ ready: true });
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  mocks.settings = {
    id: "project-a",
    projectData: {
      id: "project-a",
      name: "Stack",
      activeDeploymentId: "deploy-a",
      serviceCount: 3,
      routingUnsynced: false,
      awaitingDecision: false,
      publicEndpoints: [],
      options: { hasServer: true },
    },
    domainsData: { domains: [], isLoading: false },
    buildData: {},
    servicesData: {
      isLoading: false,
      services: names.map((name, index) => ({
        id: `svc-${name}`,
        name,
        kind: "compose",
        enabled: true,
        exposed: true,
        ports: [String(ports[index])],
        exposedPort: String(ports[index]),
        domainType: "custom",
        customDomain: `${name}.example.com`,
        publicEndpoints: [],
      })),
    },
    setProjectData: vi.fn(),
    updateDomains: vi.fn(),
    refreshServices: vi.fn(),
    setPendingDomainAction: vi.fn(),
    access: { kind: "none", host: null, url: null },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(strict = false, serviceScope?: { serviceId: string }) {
  const content = (
    <I18nProvider>
      <ModalProvider>
        <DomainSettings serviceScope={serviceScope} />
      </ModalProvider>
    </I18nProvider>
  );
  await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content));
}
function retryButtons() {
  return [...host.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === retryCopy.retry,
  );
}
async function emit(type: string, data: Record<string, unknown>, close = false) {
  await act(async () => {
    stream.enqueue(
      new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`),
    );
    if (close) stream.close();
  });
}
async function startRetry(strict = false) {
  await render(strict);
  await act(async () => retryButtons().at(-1)!.click());
  await emit("session", { sessionId: "routing-a" });
}

describe("routing retry on the Domains page", () => {
  it("does not infer HTTPS success from a ready edge after its stream disconnects", async () => {
    mocks.edgeStatus.mockResolvedValue({ ready: false });
    await render();
    const setup = [...host.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.trim() ===
        baseDictionary.projectSettings.domains.edge.setUp,
    )!;
    await act(async () => setup.click());
    await emit("log", {
      message: "Edge ready, checking HTTPS…",
      level: "info",
    });
    mocks.edgeStatus.mockResolvedValue({ ready: true });
    await act(async () => stream.close());
    const log = host.querySelector('section[aria-label="Routing log"]')!;
    expect(log.textContent).toContain(UNKNOWN_OUTCOME_MESSAGE);
    expect(log.textContent).not.toContain(retryCopy.success);
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
    expect(mocks.edgeStatus).toHaveBeenCalledTimes(2);
  });

  it.each(["completed", "failed"])(
    "keeps edge setup inline, preserves takeover consent, and refreshes state after %s",
    async (status) => {
      mocks.edgeStatus.mockResolvedValue({ ready: false });
      mocks.fetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/respond")) return Response.json({ success: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      });
      await render();
      const setup = [...host.querySelectorAll("button")].find(
        (button) =>
          button.textContent?.trim() ===
          baseDictionary.projectSettings.domains.edge.setUp,
      )!;
      expect(setup).toBeDefined();
      await act(async () => setup.click());
      expect(mocks.fetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/projects/project-a/routing/ensure-edge/stream",
        expect.objectContaining({ method: "POST" }),
      );
      const log = host.querySelector('section[aria-label="Routing log"]')!;
      expect(log).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await emit("session", { sessionId: "edge-a" });
      await emit("prompt", {
        promptId: "takeover",
        title: "Use the OpenShip edge?",
        message: "Another proxy owns these ports.",
        actions: [
          { id: "cancel", label: "Leave it" },
          { id: "takeover", label: "Use OpenShip" },
        ],
      });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const confirm = [...log.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Use OpenShip",
      )!;
      expect(confirm).toBeDefined();
      await act(async () => confirm.click());
      expect(mocks.fetch).toHaveBeenLastCalledWith(
        "http://localhost:4000/api/projects/project-a/routing/ensure-edge/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sessionId: "edge-a", action: "takeover" }),
        }),
      );
      await emit("log", {
        message: "Checking domain verification and HTTPS…",
        level: "info",
      });
      await emit("complete", { status }, true);
      expect(log.textContent).toContain(
        "Checking domain verification and HTTPS…",
      );
      expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
      expect(mocks.edgeStatus).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("shows the binding issue on its domain without suggesting a routing repair", async () => {
    mocks.settings.domainsData.domains = names.map((name) =>
      savedDomain({
        id: `dom-${name}`,
        hostname: `${name}.example.com`,
        serviceId: `svc-${name}`,
        verified: true,
        status: "active",
        sslStatus: "active",
        diagnostics: null,
      }),
    );
    mocks.checkPorts.mockResolvedValue({
      data: [
        {
          port: 4010,
          serviceId: "svc-api",
          serviceName: "api",
          listening: true,
          checked: true,
          loopbackOnly: true,
        },
        {
          port: 3021,
          serviceId: "svc-app",
          serviceName: "app",
          listening: true,
          checked: false,
          loopbackOnly: true,
        },
      ],
    });
    await render();
    expect(host.textContent).toContain(
      'Service "api" only listens inside the container on port 4010.',
    );
    expect(host.textContent).not.toContain('Service "app" only listens');
    expect(host.textContent).toContain("0.0.0.0");
    expect(retryButtons()).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps routing retry in the domain menu when routing is healthy (service view: %s)",
    async (serviceView) => {
      mocks.settings.domainsData.domains = names.map((name) =>
        savedDomain({
          id: `dom-${name}`,
          hostname: `${name}.example.com`,
          serviceId: `svc-${name}`,
          verified: true,
          status: "active",
          sslStatus: "active",
          diagnostics: null,
        }),
      );
      await render(false, serviceView ? { serviceId: "svc-api" } : undefined);
      expect(retryButtons()).toHaveLength(0);
      expect(host.textContent).not.toContain(retryCopy.title);

      const menu = host.querySelector<HTMLButtonElement>(
        `button[aria-label="${baseDictionary.projectDetail.services.detail.networking.manage} api.example.com"]`,
      )!;
      await act(async () => menu.click());
      expect(retryButtons()).toHaveLength(1);
      await act(async () => retryButtons()[0]!.click());
      await emit("session", {});
      expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(retryStartUrl),
        expect.objectContaining({ method: "POST" }),
      );
      expect(host.querySelector('section[aria-label="Routing log"]')?.textContent).toContain(
        retryCopy.retrying,
      );

      await act(async () => menu.click());
      expect(retryButtons()).toHaveLength(1);
      expect(retryButtons()[0].disabled).toBe(true);
      await act(async () => retryButtons()[0].click());
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      await emit("complete", { status: "completed" }, true);
      expect(retryButtons()[0].disabled).toBe(false);
    },
  );

  it.each([false, true])(
    "disables repair controls and replaces stale warning content while routing runs (warning: %s)",
    async (routingUnsynced) => {
      mocks.settings.projectData.routingUnsynced = routingUnsynced;
      mocks.settings.projectData.routingWarning = "Previous cleanup failure";
      await startRetry();
      expect(host.textContent).not.toContain("Previous cleanup failure");
      for (const button of retryButtons()) expect(button.disabled).toBe(true);
      expect(host.querySelector('section[aria-label="Routing log"]')?.textContent).toContain(
        retryCopy.retrying,
      );
      const close = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Close operation log"]',
      );
      expect(close?.disabled).toBe(true);
      const requests = mocks.fetch.mock.calls.length;
      await act(async () => close?.click());
      expect(host.querySelector('section[aria-label="Routing log"]')).not.toBeNull();
      expect(mocks.fetch).toHaveBeenCalledTimes(requests);
      await emit("complete", { status: "failed" }, true);
      expect(retryButtons().every((button) => !button.disabled)).toBe(true);
      expect(close?.disabled).toBe(false);
      if (routingUnsynced) expect(host.textContent).toContain("Previous cleanup failure");
    },
  );

  it("refreshes the warning and domain cards together instead of clearing only the banner", async () => {
    mocks.settings.projectData.routingUnsynced = true;
    mocks.settings.projectData.routingWarning = "Previous cleanup failure";
    mocks.settings.setProjectData.mockImplementation(
      (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
        mocks.settings.projectData = update(mocks.settings.projectData);
      },
    );
    await startRetry();
    mocks.settings.projectData.name = "Edited during repair";
    await emit("complete", { status: "completed" }, true);
    expect(mocks.settings.projectData.name).toBe("Edited during repair");
    expect(mocks.settings.projectData.routingUnsynced).toBe(true);
    expect(mocks.settings.setProjectData).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
    // The canonical project read carries both the saved warning and domain state.
    mocks.settings.projectData.routingUnsynced = false;
    mocks.settings.projectData.routingWarning = null;
    mocks.settings.domainsData.domains = names.map((name) =>
      savedDomain({
        id: `dom-${name}`,
        hostname: `${name}.example.com`,
        serviceId: `svc-${name}`,
        verified: true,
        sslStatus: "active",
        status: "active",
        diagnostics: null,
      }),
    );
    await render();
    expect(host.textContent).not.toContain(retryCopy.title);
    expect(host.textContent).not.toContain("Previous cleanup failure");
    expect(host.textContent).not.toContain(baseDictionary.projectSettings.domains.status.failed);
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.status.verified);
    expect(retryButtons().every((button) => !button.disabled)).toBe(true);
  });

  it.each(["running", "completed"])(
    "reconnects after refresh without another repair POST (server is %s)",
    async (status) => {
      await startRetry();
      await emit("log", { message: "Checking the existing certificate", level: "info" });
      await act(async () => root.unmount());
      mocks.fetch.mockClear();
      mocks.settings.projectData.routingRetry = {
        sessionId: "routing-a",
        status,
        startedAt: Date.now(),
      };
      root = createRoot(host);
      await render();
      expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
        "http://localhost:4000/api/projects/project-a/routing/retry/stream?sessionId=routing-a",
        expect.objectContaining({ method: "GET" }),
      );
      await emit("session", { sessionId: "routing-a" });
      await emit("log", { message: "Checking the existing certificate", level: "info" });
      await emit("log", { message: "Certificate reused", level: "info" });
      await emit("complete", { status: "completed" }, true);
      expect(host.textContent).toContain("Checking the existing certificate");
      expect(host.textContent).toContain("Certificate reused");
      expect(host.textContent).toContain(retryCopy.success);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);

      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label="Close operation log"]')!.click(),
      );
      await act(async () => root.unmount());
      root = createRoot(host);
      mocks.fetch.mockClear();
      await render();
      expect(host.querySelector('section[aria-label="Routing log"]')).toBeNull();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("reconnects a dropped stream to its server session instead of starting another repair", async () => {
    await startRetry();
    await emit("log", { message: "Checking HTTPS", level: "info" });
    await act(async () => stream.error(new Error("Connection reset")));
    const reconnect = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect",
    )!;
    await act(async () => reconnect.click());
    expect(mocks.fetch).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/projects/project-a/routing/retry/stream?sessionId=routing-a",
      expect.objectContaining({ method: "GET" }),
    );
    await emit("session", { sessionId: "routing-a" });
    await emit("log", { message: "Checking HTTPS", level: "info" });
    await emit("complete", { status: "completed" }, true);
    expect(host.textContent?.match(/Checking HTTPS/g)).toHaveLength(1);
    expect(host.textContent).toContain(retryCopy.success);
  });

  it("reuses the start request key when the connection drops before receiving a session ID", async () => {
    await render();
    await act(async () => retryButtons()[0].click());
    const firstUrl = mocks.fetch.mock.calls[0][0];
    await act(async () => stream.error(new Error("Lost first response")));
    const reconnect = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect",
    )!;
    await act(async () => reconnect.click());
    expect(mocks.fetch).toHaveBeenLastCalledWith(
      firstUrl,
      expect.objectContaining({ method: "POST" }),
    );
    expect(firstUrl).toMatch(retryStartUrl);
  });

  it.each([false, true])(
    "offers repair on missing records and a project action only for a routing warning (warning: %s)",
    async (routingUnsynced) => {
      mocks.settings.projectData.routingUnsynced = routingUnsynced;
      await render();
      expect(host.textContent?.includes(retryCopy.title)).toBe(routingUnsynced);
      for (const name of names) expect(host.textContent).toContain(`${name}.example.com`);
      // The warning adds a project action; missing records have their own repair controls.
      expect(retryButtons()).toHaveLength(routingUnsynced ? 4 : 3);
      await act(async () => retryButtons()[1]!.click());
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.stringMatching(retryStartUrl),
        expect.objectContaining({ method: "POST" }),
      );
      await emit("log", { message: "api.example.com: route restored", level: "info" });
      const log = host.querySelector('section[aria-label="Routing log"]');
      expect(log?.textContent).toContain("api.example.com: route restored");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("keeps a slow repair open beyond the ordinary request timeout, with live logs", async () => {
    vi.useFakeTimers();
    await startRetry();
    await emit("log", { message: "Connecting to the deployment server…", level: "info" });
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    const request = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect(request.signal?.aborted).toBe(false);
    expect(document.body.textContent).toContain(retryCopy.retrying);
    expect(document.body.textContent).not.toContain("Request timed out");
    await emit("log", { message: "web.example.com: existing certificate reused", level: "info" });
    await emit("complete", { status: "completed" }, true);
    expect(document.body.textContent).toContain(retryCopy.success);
    expect(document.body.textContent).toContain("existing certificate reused");
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
  });

  it.each([false, true])(
    "keeps one active repair across domain actions and allows a fresh retry after completion (StrictMode: %s)",
    async (strict) => {
      await startRetry(strict);
      const requests = mocks.fetch.mock.calls.length;
      const firstUrl = mocks.fetch.mock.calls[0][0];
      expect(mocks.fetch.mock.calls.every(([url]) => url === firstUrl)).toBe(true);
      await emit("log", { message: "Still checking the current routes", level: "info" });
      await act(async () => {
        for (const button of retryButtons()) button.click();
      });
      expect(mocks.fetch).toHaveBeenCalledTimes(requests);
      expect(host.querySelector('section[aria-label="Routing log"]')?.textContent).toContain(
        "Still checking the current routes",
      );
      expect((mocks.fetch.mock.calls.at(-1)![1] as RequestInit).signal?.aborted).toBe(false);

      await emit("complete", { status: "completed" }, true);
      await act(async () => retryButtons()[0]!.click());
      expect(mocks.fetch.mock.calls.length).toBeGreaterThan(requests);
      expect(mocks.fetch.mock.calls.at(-1)![0]).not.toBe(firstUrl);
      expect(host.textContent).not.toContain("Still checking the current routes");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("retains the real partial-failure log and refreshes the cards without claiming success", async () => {
    await startRetry();
    await emit("log", { message: "api.example.com: route restored", level: "info" });
    await emit("log", { message: "web.example.com: HTTP challenge returned 404", level: "error" });
    await emit("complete", { status: "failed" }, true);
    expect(document.body.textContent).toContain("HTTP challenge returned 404");
    expect(document.body.textContent).toContain("api.example.com: route restored");
    expect(document.body.textContent).toContain(retryCopy.failed);
    expect(document.body.textContent).not.toContain(retryCopy.success);
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
    expect(mocks.settings.setProjectData).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("keeps logs and an honest unknown outcome when the connection drops before completion", async () => {
    await startRetry();
    await emit("log", { message: "Checking HTTPS on the remote server…", level: "info" });
    await act(async () => stream.error(new Error("Connection reset")));
    expect(document.body.textContent).toContain("Checking HTTPS on the remote server");
    expect(document.body.textContent).toContain(UNKNOWN_OUTCOME_MESSAGE);
    expect(document.body.textContent).not.toContain(retryCopy.success);
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
  });

  it("shows Verify once repair has created a pending domain record", async () => {
    mocks.settings.domainsData.domains = names.map((name) => ({
      id: `dom-${name}`,
      hostname: `${name}.example.com`,
      domainType: "custom",
      verified: false,
      status: "pending",
      sslStatus: "none",
      serviceId: `svc-${name}`,
    }));
    await render();
    const verifyButtons = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === baseDictionary.projectSettings.domains.menu.verify,
    );
    expect(verifyButtons).toHaveLength(3);
    expect(retryButtons()).toHaveLength(0);
    // Repair is also available from a persisted row's menu, independent of
    // whether it is still pending, has an SSL error, or was previously verified.
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(retryButtons()).toHaveLength(1);
    await act(async () => retryButtons().at(-1)!.click());
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.stringMatching(retryStartUrl),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

const detailsCopy = baseDictionary.projectSettings.domains.diagnosis;
function savedDomain(patch: Record<string, unknown> = {}) {
  return {
    id: "dom-api",
    hostname: "api.example.com",
    serviceId: "svc-api",
    domainType: "custom",
    verified: false,
    status: "pending",
    sslStatus: "none",
    verifyAttempts: 0,
    lastVerifyError: null,
    lastCheckedAt: null,
    diagnostics: {
      state: "pending",
      reason: "verification",
      retryAction: "verify",
      automaticRetry: "scheduled",
      nextRetryAt: "2026-09-23T01:13:00.000Z",
    },
    ...patch,
  };
}
async function openDomainDetails() {
  const pill = host.querySelector<HTMLButtonElement>(`button[title="${detailsCopy.pillHint}"]`)!;
  await act(async () => pill.click());
  return host.querySelector<HTMLElement>(
    `[role="region"][aria-label="${detailsCopy.title}: api.example.com"]`,
  )!;
}

describe("domain status details", () => {
  it("shows one repair action when the missing-route explanation is expanded", async () => {
    await render(false, { serviceId: "svc-api" });
    await openDomainDetails();
    const actions = [...host.querySelectorAll("button")].filter((button) =>
      [retryCopy.retry, detailsCopy.retryNow].includes(button.textContent?.trim() ?? ""),
    );
    expect(actions).toHaveLength(1);
    await act(async () => actions[0].click());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses an authorized subsystem's certificate state without inventing a missing project domain", async () => {
    mocks.settings.projectData.routingClaims = [
      {
        hostname: "api.example.com",
        ownerType: "mail",
        verified: true,
        sslStatus: "active",
        sslExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    ];
    await render(false, { serviceId: "svc-api" });
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.status.verified);
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.ssl.active);
    expect(host.textContent).not.toContain(baseDictionary.projectSettings.domains.status.failed);
    expect(retryButtons()).toHaveLength(0);
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(host.textContent).not.toContain(baseDictionary.projectSettings.domains.menu.renewSsl);
    expect(host.textContent).not.toContain(baseDictionary.projectSettings.domains.menu.uploadCert);
  });

  it("does not invent verification or certificate success for an authorized hostname with no certificate record", async () => {
    mocks.settings.projectData.routingClaims = [
      { hostname: "api.example.com", ownerType: null, verified: null, sslStatus: null },
    ];
    await render(false, { serviceId: "svc-api" });
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.ssl.unknown);
    expect(host.textContent).not.toContain(baseDictionary.projectSettings.domains.status.verified);
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.reasons.managed_owner);
    expect(retryButtons()).toHaveLength(0);
  });

  it("explains a genuinely pending check and its scheduled time", async () => {
    mocks.settings.domainsData.domains = [savedDomain()];
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.reasons.verification);
    expect(details.querySelector("time")?.dateTime).toBe("2026-09-23T01:13:00.000Z");
    expect(details.textContent).toContain(detailsCopy.nextCheck);
    expect(details.querySelector("button")).toBeNull();
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.menu.verify);
  });

  it("shows the failed attempt and retries that domain inline, without starting a project routing repair", async () => {
    mocks.settings.domainsData.domains = [
      savedDomain({
        status: "failed",
        verifyAttempts: 1,
        lastVerifyError: "The server refused the SSH connection",
        lastCheckedAt: "2026-09-23T01:00:00.000Z",
        diagnostics: { ...savedDomain().diagnostics, state: "failed" },
      }),
    ];
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain("The server refused the SSH connection");
    expect([...details.querySelectorAll("time")].map((time) => time.dateTime)).toEqual([
      "2026-09-23T01:00:00.000Z",
      "2026-09-23T01:13:00.000Z",
    ]);
    const verify = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === baseDictionary.projectSettings.domains.menu.verify,
    )!;
    await act(async () => verify.click());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/domains/dom-api/verify/stream",
      expect.objectContaining({ method: "POST" }),
    );
    expect(verify.disabled).toBe(true);
    await emit("log", { message: "SSH authentication failed", level: "error" });
    await emit("complete", { status: "failed" }, true);
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
    expect(host.querySelector('section[aria-label="Routing log"]')?.textContent).toContain(
      "SSH authentication failed",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(verify.disabled).toBe(false);
  });

  it("does not offer a retry for routes waiting for their first deployment", async () => {
    mocks.settings.projectData.activeDeploymentId = null;
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.reasons.deployment);
    expect(details.querySelector("button")).toBeNull();
    expect(retryButtons()).toHaveLength(0);
  });

  it("does not offer a routing retry for a paused service's missing record", async () => {
    mocks.settings.servicesData.services[0].enabled = false;
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.reasons.disabled);
    expect(details.querySelector("button")).toBeNull();
    // The other two live services can still repair their routes.
    expect(retryButtons()).toHaveLength(2);
  });

  it("explains disabled scheduling and keeps an explicit manual action", async () => {
    mocks.settings.domainsData.domains = [
      savedDomain({
        diagnostics: {
          ...savedDomain().diagnostics,
          state: "waiting",
          nextRetryAt: null,
          automaticRetry: "disabled",
        },
      }),
    ];
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.automaticDisabled);
    expect(details.querySelector("time")).toBeNull();
    expect(details.querySelector("button")).toBeNull();
    expect(host.textContent).toContain(baseDictionary.projectSettings.domains.menu.verify);
  });

  it("offers a certificate recheck instead of ACME issuance for uploaded certificates", async () => {
    mocks.settings.domainsData.domains = [
      savedDomain({
        verified: true,
        sslStatus: "expired",
        manualSsl: true,
        diagnostics: {
          state: "failed",
          reason: "manual_certificate",
          retryAction: "verify_ssl",
          nextRetryAt: null,
          automaticRetry: "not_applicable",
        },
      }),
    ];
    await render();
    const details = await openDomainDetails();
    expect(details.textContent).toContain(detailsCopy.reasons.manual_certificate);
    expect(details.querySelector("button")?.textContent).toContain(
      baseDictionary.projectSettings.domains.menu.recheckSsl,
    );
    expect(details.textContent).not.toContain(detailsCopy.retryNow);
  });

  it("does not claim a failed SSL recheck succeeded because its last known certificate is active", async () => {
    mocks.settings.domainsData.domains = [
      savedDomain({
        verified: true,
        sslStatus: "active",
        manualSsl: true,
        lastVerifyError: "Cannot reach the server",
        diagnostics: {
          state: "failed",
          reason: "manual_certificate",
          retryAction: "verify_ssl",
          nextRetryAt: null,
          automaticRetry: "not_applicable",
        },
      }),
    ];
    mocks.verifySsl.mockResolvedValue({
      data: {
        verified: false,
        sslStatus: "active",
        message: "Cannot read the certificate over SSH",
      },
    });
    await render();
    const details = await openDomainDetails();
    await act(async () => details.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.toast).toHaveBeenCalledWith(
      "Cannot read the certificate over SSH",
      "error",
      expect.any(String),
    );
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success")).toBe(false);
    expect(mocks.invalidate).toHaveBeenCalledWith("project-a");
  });

  it("refreshes scheduled checks without a page reload and keeps the last state on a failed read", async () => {
    vi.useFakeTimers();
    mocks.settings.domainsData.domains = [savedDomain()];
    mocks.listDomains.mockRejectedValueOnce(new Error("offline"));
    const active = savedDomain({
      verified: true,
      status: "active",
      sslStatus: "active",
      diagnostics: null,
    });
    mocks.listDomains.mockResolvedValueOnce({ data: [active] });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.settings.updateDomains).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.listDomains).toHaveBeenCalledWith("project-a");
    expect(mocks.settings.updateDomains).toHaveBeenCalledWith([
      expect.objectContaining({ id: "dom-api", verified: true, sslStatus: "active" }),
    ]);
  });
});
