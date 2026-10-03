// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerMigrationWizard } from "./ServerMigrationWizard";
import type { DiscoveredService, DiscoveredStack } from "@/lib/api/server-migration";

const h = vi.hoisted(() => ({
  listServers: vi.fn(),
  listSources: vi.fn(),
  scanStream: vi.fn(),
  cloudPricing: vi.fn(),
  preview: vi.fn(),
  migrate: vi.fn(),
  reimport: vi.fn(),
  getMigration: vi.fn(),
  getActive: vi.fn(),
  confirmCutover: vi.fn(),
  streamMigration: vi.fn(),
  selfHosted: true,
  organizationId: "org-a",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api/system", () => ({
  systemApi: { listServerDestinations: async () => ({ servers: await h.listServers() }) },
}));
vi.mock("@/lib/api/domains", () => ({
  domainsApi: {
    previewRecords: vi.fn(async () => ({ data: { records: [], mode: "selfhosted" } })),
  },
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.selfHosted, deployMode: "docker", baseDomain: "opsh.test" }),
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ connected: true }),
  useDefaultDomainType: () => "free",
}));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user" }, session: { activeOrganizationId: h.organizationId } },
  }),
}));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => h.cloudPricing }));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => vi.fn() }));
vi.mock("@/lib/api/server-migration", () => ({
  dockerMigrationApi: {
    scanStream: h.scanStream,
    listSources: h.listSources,
    preview: h.preview,
    migrate: h.migrate,
    reimport: h.reimport,
    getMigration: h.getMigration,
    getActive: h.getActive,
    confirmCutover: h.confirmCutover,
    streamMigration: h.streamMigration,
  },
  isScanStreamStalled: () => false,
}));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ connected: false }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  h.selfHosted = true;
  h.organizationId = "org-a";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  h.listServers.mockResolvedValue([
    {
      id: "source-a",
      name: "First server",
      sshHost: "192.0.2.1",
      sshPort: 22,
      sshUser: "root",
      capabilities: { ssh: true },
    },
    {
      id: "source-b",
      name: "Second server",
      sshHost: "192.0.2.2",
      sshPort: 22,
      sshUser: "root",
      capabilities: { ssh: true },
    },
  ]);
  h.scanStream.mockImplementation(() => new Promise(() => {}));
  h.getMigration.mockImplementation(() => new Promise(() => {}));
  h.getActive.mockResolvedValue({ run: null });
  h.reimport.mockResolvedValue({ success: true, projectId: "recovered", reattached: true });
  h.streamMigration.mockReturnValue(vi.fn());
  h.confirmCutover.mockResolvedValue({ success: true });
  h.listSources.mockResolvedValue({
    sources: [
      {
        id: "external",
        name: "Migration source",
        sshHost: "203.0.113.12",
        sshPort: 22,
        sshUser: "root",
        purpose: "migration_source",
      },
    ],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
async function pickSource(name: string) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-haspopup]")!.click(),
  );
  const choice = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(name),
  )!;
  expect(choice).toBeDefined();
  await act(async () => choice.click());
}
function useCloud() {
  h.selfHosted = false;
  h.listServers.mockResolvedValue([
    {
      id: "managed",
      name: "Managed server",
      connection: "cloud",
      projectCount: 0,
      managed: {
        id: "workspace",
        state: "ready",
        resources: { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
      },
      capabilities: { ssh: false, exec: true },
    },
  ]);
}
function scannedStack(): DiscoveredStack {
  const service: DiscoveredService = {
    name: "redis",
    containerId: "redis-container",
    source: "container",
    image: "redis:7",
    running: true,
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
    warnings: [],
  };
  return {
    serverId: "external",
    composeProjects: [],
    groups: [{ project: null, services: [service] }],
    services: [service],
    volumes: [],
    networks: [],
    warnings: [],
    adoptable: true,
    alreadyManaged: 0,
    openshipProjects: [],
  };
}

it("Cloud uses the restricted source inventory and the same scanner", async () => {
  useCloud();
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  expect(h.listSources).toHaveBeenCalledOnce();
  expect(button("Scan server").disabled).toBe(true);
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  expect(h.scanStream).toHaveBeenCalledExactlyOnceWith(
    "external",
    expect.objectContaining({ flatDocker: true }),
  );
});

it("changes scan coverage through the shared menu and re-scans the selected server", async () => {
  h.scanStream.mockResolvedValue({ ...scannedStack(), serverId: "source-a" });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("First server");
  const openOptions = () =>
    act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Scan options"]')!.click(),
    );

  await openOptions();
  await act(async () => button("Include managed containers").click());
  expect(h.scanStream).not.toHaveBeenCalled();
  await act(async () => button("Scan server").click());
  expect(h.scanStream).toHaveBeenCalledExactlyOnceWith(
    "source-a",
    expect.objectContaining({ flatDocker: true }),
  );

  await openOptions();
  await act(async () => button("Detect projects").click());
  expect(h.scanStream).toHaveBeenCalledTimes(2);
  expect(h.scanStream).toHaveBeenLastCalledWith(
    "source-a",
    expect.objectContaining({ flatDocker: false }),
  );
  expect(button("Detect projects")).toBeUndefined();
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Cards");
  expect(h.migrate).not.toHaveBeenCalled();
  expect(h.reimport).not.toHaveBeenCalled();
});

it("discards scan results and progress after the active organization changes", async () => {
  useCloud();
  let complete!: (stack: ReturnType<typeof scannedStack>) => void;
  h.scanStream.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  const options = h.scanStream.mock.calls[0]![1];
  h.organizationId = "org-b";
  h.listSources.mockResolvedValue({ sources: [] });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await act(async () => {
    options.onProgress("private progress from org-a");
    complete(scannedStack());
  });
  expect(container.textContent).not.toContain("private progress from org-a");
  expect(container.textContent).not.toContain("redis");
  expect(button("Scan server").disabled).toBe(true);
});

it("opens shared billing recovery and retries the same import after admission fails", async () => {
  useCloud();
  h.scanStream.mockResolvedValue(scannedStack());
  h.preview.mockResolvedValue({
    preview: {
      sameServer: false,
      services: [],
      volumesToMove: [],
      hasBlocked: false,
      downtimeWarning: true,
      droppedProxies: [],
      warnings: [],
      plan: { totalBytes: 0, partial: false, items: [] },
    },
  });
  const restriction = new Error("Choose a server plan before importing");
  h.migrate
    .mockRejectedValueOnce(restriction)
    .mockResolvedValueOnce({ migrationId: "run", confirmationToken: "token" });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[role="checkbox"][aria-label="Select all services in Standalone containers"]',
      )!
      .click(),
  );
  for (let step = 0; step < 3; step++) {
    expect(button("Next")?.disabled).toBe(false);
    await act(async () => button("Next").click());
  }
  expect(button("Migrate")?.disabled).toBe(false);
  await act(async () => button("Migrate").click());
  expect(h.cloudPricing).toHaveBeenCalledWith(restriction, expect.any(Function));
  expect(button("Retry")?.disabled).toBe(false);
  await act(async () => button("Retry").click());
  expect(h.migrate).toHaveBeenCalledTimes(2);
  expect(h.migrate.mock.calls[1]![0]).toEqual(h.migrate.mock.calls[0]![0]);
  expect(h.migrate.mock.calls[0]![0]).toMatchObject({
    sourceServerId: "external",
    targetServerId: "managed",
    serviceContainerIds: ["redis-container"],
    flatDocker: true,
  });
});

it("uses the reopened run's cutover token without a server prop or a second active-run lookup", async () => {
  useCloud();
  h.getMigration.mockResolvedValue({
    run: {
      id: "run",
      status: "awaiting_cutover",
      mode: "cross_server",
      projectName: "Imported Redis",
      confirmationToken: "this-run-only",
      sourceServerId: "external",
      targetServerId: "managed",
    },
  });
  await act(async () =>
    root.render(<ServerMigrationWizard variant="tab" initialRunId="run" onClose={vi.fn()} />),
  );
  const keep = Array.from(container.querySelectorAll("button")).find((b) =>
    /keep.*original/i.test(b.textContent ?? ""),
  );
  expect(keep).toBeDefined();
  await act(async () => keep!.click());
  expect(h.confirmCutover).toHaveBeenCalledExactlyOnceWith("run", "this-run-only", false);
});

it.each([undefined, "unavailable-run"])(
  "keeps project migrations out of the scan flow when the run is %s",
  async (initialRunId) => {
    h.getMigration.mockResolvedValue({ run: null });
    const onBack = vi.fn();
    await act(async () =>
      root.render(
        <ServerMigrationWizard
          variant="tab"
          origin="project"
          initialRunId={initialRunId}
          onClose={vi.fn()}
          onBack={onBack}
        />,
      ),
    );

    expect(button("Scan server")).toBeUndefined();
    expect(container.querySelector('[aria-label="Import details"]')).toBeNull();
    expect(container.querySelector('[aria-label="Scan options"]')).toBeNull();
    expect(h.scanStream).not.toHaveBeenCalled();
    const back = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Back"),
    );
    expect(back).toBeDefined();
    await act(async () => back!.click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.reimport).not.toHaveBeenCalled();
  },
);

it("waits for the selected destination's storage review before enabling migration", async () => {
  useCloud();
  const server = {
    connection: "cloud",
    projectCount: 0,
    managed: { state: "ready" },
    capabilities: { exec: true },
  };
  h.listServers.mockResolvedValue([
    { ...server, id: "managed", name: "First managed server" },
    { ...server, id: "second-managed", name: "Second managed server" },
  ]);
  h.scanStream.mockResolvedValue(scannedStack());
  let finishPreview!: (result: unknown) => void;
  const preview = {
    sameServer: false,
    services: [],
    volumesToMove: [],
    hasBlocked: false,
    downtimeWarning: true,
    droppedProxies: [],
    warnings: [],
    plan: { totalBytes: 0, partial: false, items: [] },
  };
  h.preview.mockResolvedValueOnce({ preview }).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPreview = resolve;
      }),
  );
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[role="checkbox"][aria-label="Select all services in Standalone containers"]',
      )!
      .click(),
  );
  for (let step = 0; step < 3; step++) await act(async () => button("Next").click());
  expect(button("Migrate").disabled).toBe(false);
  await pickSource("Second managed server");
  expect(h.preview.mock.lastCall?.[0]).toMatchObject({ targetServerId: "second-managed" });
  expect(button("Migrate").disabled).toBe(true);
  await act(async () => finishPreview({ preview: { ...preview } }));
  expect(button("Migrate").disabled).toBe(false);
});

it("defaults to cards and keeps container selection, view and automatic naming across steps", async () => {
  useCloud();
  const base = scannedStack();
  const first = {
    ...base.services[0]!,
    containerId: "first-redis",
    env: { PASSWORD: "masked-first" },
  };
  const second = {
    ...base.services[0]!,
    containerId: "second-redis",
    env: { PASSWORD: "masked-second" },
  };
  h.scanStream.mockResolvedValue({
    ...base,
    services: [first, second],
    groups: [
      { project: "first", services: [first] },
      { project: "second", services: [second] },
    ],
  });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  const tab = (name: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent === name,
    )!;
  const pickGroup = (name: string) =>
    container.querySelector<HTMLButtonElement>(
      `[role="checkbox"][aria-label="Select all services in ${name}"]`,
    )!;
  expect(tab("Cards").getAttribute("aria-selected")).toBe("true");
  expect(button("Next").disabled).toBe(true);
  expect(button("Add project")).toBeUndefined();
  await act(async () => pickGroup("first").click());
  expect(button("Add project")).toBeDefined();
  expect(container.querySelector<HTMLInputElement>('input[id^="import-name-"]')!.value).toBe(
    "first",
  );
  await act(async () => tab("Topology").click());
  expect(
    container
      .querySelector('section[aria-label="first"] [aria-label="Select redis"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Services in second"]')!.click(),
  );
  expect(
    container
      .querySelector('section[aria-label="second"] [aria-label="Select redis"]')
      ?.getAttribute("aria-checked"),
  ).toBe("false");
  await act(async () => pickGroup("second").click());
  expect(button("Add project")).toBeUndefined();
  await act(async () => pickGroup("first").click());
  expect(button("Add project")).toBeDefined();
  expect(container.querySelector<HTMLInputElement>('input[id^="import-name-"]')!.value).toBe(
    "second",
  );
  await act(async () => button("Next").click());
  expect(button("Add project")).toBeUndefined();
  await act(async () => button("Back").click());
  expect(tab("Topology").getAttribute("aria-selected")).toBe("true");
  expect(pickGroup("second").getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).not.toContain("masked-first");
  expect(container.textContent).not.toContain("masked-second");
  expect(h.migrate).not.toHaveBeenCalled();
});

it("keeps routing compact and prevents incomplete public routes from being silently omitted", async () => {
  useCloud();
  h.scanStream.mockResolvedValue(scannedStack());
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Select all services in Standalone containers"]',
      )!
      .click(),
  );
  await act(async () => button("Next").click());
  await act(async () => button("Next").click());
  const configure = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Configure redis"]')!;
  expect(configure().getAttribute("aria-expanded")).toBe("false");
  expect(button("Custom")).toBeUndefined();
  expect(button("Next").disabled).toBe(false);
  await act(async () => configure().click());
  await act(async () => button("Custom").click());
  expect(button("Next").disabled).toBe(true);
  await act(async () => configure().click());
  expect(container.textContent).toContain("Complete route setup");
  expect(button("Next").disabled).toBe(true);
  await act(async () => button("Back").click());
  await act(async () => button("Next").click());
  expect(button("Next").disabled).toBe(true);
  await act(async () => configure().click());
  await act(async () => button("Internal only").click());
  expect(button("Next").disabled).toBe(false);
  expect(h.migrate).not.toHaveBeenCalled();
});

it.each(["detected", "edited", "free", "internal"] as const)(
  "shows three routing choices and imports the %s route selection",
  async (choice) => {
    const stack = scannedStack();
    stack.services[0]!.ports = ["18080:8080"];
    stack.services[0]!.existingRoute = [
      {
        domains: ["api.example.com", "www.example.com"],
        port: 18080,
        containerPort: 8080,
        path: "/v1",
        exact: true,
        ssl: { enabled: true },
      },
    ];
    h.scanStream.mockResolvedValue({ ...stack, serverId: "source-a" });
    h.migrate.mockResolvedValue({ migrationId: "run", confirmationToken: "token" });
    await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
    await pickSource("First server");
    await act(async () => button("Scan server").click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Select all services in Standalone containers"]',
        )!
        .click(),
    );
    for (let step = 0; step < 2; step++) await act(async () => button("Next").click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Configure redis"]')!.click(),
    );
    const routeChoices = container.querySelector('[role="group"][aria-label="Route"]')!;
    expect(Array.from(routeChoices.querySelectorAll("button"), (item) => item.textContent)).toEqual(
      ["Custom", "Free", "Internal only"],
    );
    expect(button("Custom").getAttribute("aria-pressed")).toBe("true");
    expect(button("Next").disabled).toBe(false);
    const expandDomain = async (label: string) => {
      const toggle = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
      ).find((item) => item.textContent?.startsWith(label))!;
      if (toggle.getAttribute("aria-expanded") !== "true") await act(async () => toggle.click());
    };
    const fill = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    if (choice === "edited") {
      await expandDomain("Primary domain");
      await fill(
        container.querySelector<HTMLInputElement>('input[placeholder="app.example.com"]')!,
        "edited.example.com",
      );
      await fill(
        container.querySelector<HTMLInputElement>('input[aria-label="Exposed port"]')!,
        "9090",
      );
      await act(async () => button("Free").click());
      expect(button("Next").disabled).toBe(true);
      await act(async () => button("Custom").click());
      expect(
        container.querySelector<HTMLInputElement>('input[placeholder="app.example.com"]')!.value,
      ).toBe("edited.example.com");
    } else if (choice === "free") {
      await act(async () => button("Free").click());
      expect(button("Next").disabled).toBe(true);
      await expandDomain("Primary domain");
      await fill(
        container.querySelector<HTMLInputElement>('input[placeholder="redis"]')!,
        "api-preview",
      );
      expect(button("Next").disabled).toBe(true);
      await expandDomain("Domain 2");
      await fill(
        container.querySelectorAll<HTMLInputElement>('input[placeholder="redis"]')[1]!,
        "www-preview",
      );
    } else if (choice === "internal") {
      await act(async () => button("Internal only").click());
      expect(container.querySelector('input[placeholder="app.example.com"]')).toBeNull();
    } else {
      await act(async () => button("Custom").click());
    }

    expect(button("Next").disabled).toBe(false);
    await act(async () => button("Next").click());
    await act(async () => button("Migrate").click());
    const routes = h.migrate.mock.lastCall?.[0].routesByServiceName;
    if (choice === "internal") {
      expect(routes).toBeUndefined();
    } else {
      expect(routes).toEqual({
        "redis-container": [
          {
            ...(choice === "free"
              ? { domainType: "free", domain: "api-preview" }
              : {
                  domainType: "custom",
                  customDomain: choice === "edited" ? "edited.example.com" : "api.example.com",
                }),
            exposedPort: choice === "edited" ? "9090" : "8080",
            targetPath: "/v1",
            exact: true,
          },
          {
            ...(choice === "free"
              ? { domainType: "free", domain: "www-preview" }
              : { domainType: "custom", customDomain: "www.example.com" }),
            exposedPort: "8080",
            targetPath: "/v1",
            exact: true,
          },
        ],
      });
    }
  },
);

it("expands service reviews individually or together without losing configuration across steps", async () => {
  useCloud();
  const stack = scannedStack();
  const redis = stack.services[0]!;
  const worker = { ...redis, name: "worker", containerId: "worker-container" };
  stack.services = [redis, worker];
  stack.groups = [{ project: null, services: stack.services }];
  h.scanStream.mockResolvedValue(stack);
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  const selectServices = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Select all services in Standalone containers"]',
    )!;
  await act(async () => selectServices().click());
  for (let step = 0; step < 2; step++) await act(async () => button("Next").click());

  const configure = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="Configure ${name}"]`)!;
  const expanded = (name: string) => configure(name).getAttribute("aria-expanded");
  expect(expanded("redis")).toBe("false");
  expect(expanded("worker")).toBe("false");
  expect(button("Expand all").disabled).toBe(false);
  expect(button("Collapse all").disabled).toBe(true);

  await act(async () => configure("redis").click());
  expect(expanded("redis")).toBe("true");
  expect(expanded("worker")).toBe("false");
  expect(button("Expand all").disabled).toBe(false);
  expect(button("Collapse all").disabled).toBe(false);
  await act(async () => button("Custom").click());
  expect(button("Next").disabled).toBe(true);

  await act(async () => button("Expand all").click());
  expect(expanded("redis")).toBe("true");
  expect(expanded("worker")).toBe("true");
  expect(button("Expand all").disabled).toBe(true);
  expect(button("Collapse all").disabled).toBe(false);
  await act(async () => button("Back").click());
  await act(async () => button("Next").click());
  expect(expanded("redis")).toBe("true");
  expect(expanded("worker")).toBe("true");
  expect(button("Custom").getAttribute("aria-pressed")).toBe("true");

  await act(async () => button("Collapse all").click());
  expect(expanded("redis")).toBe("false");
  expect(expanded("worker")).toBe("false");
  expect(button("Expand all").disabled).toBe(false);
  expect(button("Collapse all").disabled).toBe(true);
  expect(container.textContent).toContain("Complete route setup");
  expect(button("Next").disabled).toBe(true);

  await act(async () => button("Expand all").click());
  for (let step = 0; step < 2; step++) await act(async () => button("Back").click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Re-scan"]')!.click(),
  );
  await act(async () => selectServices().click());
  for (let step = 0; step < 2; step++) await act(async () => button("Next").click());
  expect(expanded("redis")).toBe("false");
  expect(expanded("worker")).toBe("false");
  expect(button("Next").disabled).toBe(false);
  expect(h.migrate).not.toHaveBeenCalled();
});

it("keeps the self-hosted in-place flow and its reviewed volume choice", async () => {
  const stack = scannedStack();
  stack.services[0]!.volumes = [
    { type: "volume", source: "redis-data", target: "/data", rw: true },
  ];
  h.scanStream.mockResolvedValue({ ...stack, serverId: "source-a" });
  h.migrate.mockResolvedValue({ migrationId: "run", confirmationToken: "token" });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("First server");
  await act(async () => button("Scan server").click());
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Select all services in Standalone containers"]',
      )!
      .click(),
  );
  await act(async () => button("Next").click());
  await act(async () => button("Next").click());
  expect(button("Migrate")).toBeUndefined();
  expect(container.textContent).toContain("Import summary");
  expect(container.textContent).not.toContain("Target server");
  expect(h.preview).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Configure redis"]')!.click(),
  );
  await act(async () => button("Copy").click());
  await act(async () => button("Next").click());
  expect(container.textContent).toContain("Target server");
  expect(button("Migrate").disabled).toBe(false);
  await act(async () => button("Migrate").click());
  expect(h.migrate.mock.lastCall?.[0]).toMatchObject({
    sourceServerId: "source-a",
    targetServerId: "source-a",
    serviceContainerIds: ["redis-container"],
    volumeStrategies: { "redis-container": "copy" },
    flatDocker: false,
  });
});

it("uses the same default cards selection and destination review in the modal", async () => {
  useCloud();
  h.scanStream.mockResolvedValue(scannedStack());
  const modalButton = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    )!;
  await act(async () =>
    root.render(<ServerMigrationWizard isOpen serverId="external" onClose={vi.fn()} />),
  );
  await act(async () => modalButton("Scan server").click());
  expect(
    Array.from(document.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.textContent === "Cards")
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Select all services in Standalone containers"]',
      )!
      .click(),
  );
  const name = document.querySelector<HTMLInputElement>('input[id^="import-name-"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "imported-redis",
    );
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => modalButton("Next").click());
  await act(async () => modalButton("Next").click());
  expect(document.querySelector('[aria-label="Configure redis"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Target server");
  expect(document.body.textContent).toContain("Import summary");
  expect(modalButton("Next").disabled).toBe(false);
  await act(async () => modalButton("Next").click());
  expect(document.body.textContent).toContain("Target server");
  expect(document.body.textContent).toContain("Managed server");
  expect(modalButton("Next")).toBeUndefined();
});

it("offers recovered projects inside discovery and keeps recovery separate from migration", async () => {
  const stack = scannedStack();
  h.scanStream.mockResolvedValue({
    ...stack,
    services: [],
    groups: [],
    adoptable: false,
    openshipProjects: [
      {
        projectId: "original-id",
        suggestedName: "recovered",
        knownHere: false,
        hasSnapshot: false,
        services: stack.services,
      },
    ],
  });
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("First server");
  await act(async () => button("Scan server").click());
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Cards");
  expect(container.textContent).not.toContain("Openship projects found");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Recover recovered"]')!.click(),
  );
  const panel = container.querySelector('aside[aria-label="Import details"]')!;
  expect(panel.textContent).toContain("From containers");
  expect(panel.querySelector<HTMLInputElement>('input[id^="recover-name-"]')!.value).toBe(
    "recovered",
  );
  await act(async () => button("Re-import").click());
  expect(h.reimport).toHaveBeenCalledExactlyOnceWith({
    serverId: "source-a",
    projectId: "original-id",
    projectName: "recovered",
  });
  expect(h.migrate).not.toHaveBeenCalled();
  expect(panel.textContent).toContain("Open project");
  await act(async () => button("Back").click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Recover recovered"]')!.click(),
  );
  expect(panel.textContent).toContain("Open project");
  expect(button("Re-import")).toBeUndefined();
  expect(h.reimport).toHaveBeenCalledOnce();
});

it("does not show a stale recovery response after the organization changes", async () => {
  const stack = scannedStack();
  h.scanStream.mockResolvedValue({
    ...stack,
    openshipProjects: [
      {
        projectId: "private-project",
        suggestedName: "Private recovery",
        knownHere: false,
        hasSnapshot: true,
        services: stack.services,
      },
    ],
    groups: [],
    services: [],
    adoptable: false,
  });
  let complete!: (value: unknown) => void;
  h.reimport.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("First server");
  await act(async () => button("Scan server").click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Recover Private recovery"]')!.click(),
  );
  await act(async () => button("Re-import").click());
  h.organizationId = "org-b";
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await act(async () =>
    complete({ success: true, projectId: "private-project", reattached: true }),
  );
  expect(container.textContent).not.toContain("Private recovery");
  expect(button("Open project")).toBeUndefined();
});

it("remembers a successful recovery that finishes after leaving its review", async () => {
  const stack = scannedStack();
  h.scanStream.mockResolvedValue({
    ...stack,
    openshipProjects: [
      {
        projectId: "original-id",
        suggestedName: "Existing shop",
        knownHere: false,
        hasSnapshot: true,
        services: stack.services,
      },
    ],
  });
  let complete!: (value: unknown) => void;
  h.reimport.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("First server");
  await act(async () => button("Scan server").click());
  const openReview = () =>
    act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Recover Existing shop"]')!.click(),
    );

  await openReview();
  await act(async () => button("Re-import").click());
  await act(async () => button("Back").click());
  await act(async () => complete({ success: true, projectId: "restored-id", reattached: true }));
  expect(button("Open project")).toBeUndefined();
  await openReview();
  expect(button("Open project")).toBeDefined();
  expect(button("Re-import")).toBeUndefined();
  expect(h.reimport).toHaveBeenCalledOnce();
  expect(h.migrate).not.toHaveBeenCalled();
});

it("shows a useful empty result when only excluded proxy containers are discovered", async () => {
  useCloud();
  const stack = scannedStack();
  stack.services[0]!.proxyKind = "traefik";
  h.scanStream.mockResolvedValue(stack);
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await pickSource("Migration source");
  await act(async () => button("Scan server").click());
  expect(container.textContent).toContain("No adoptable Docker containers were found");
  expect(button("Next")).toBeUndefined();
  expect(button("Scan server").disabled).toBe(false);
});

it("does not restore an old organization's run or transfer progress after switching context", async () => {
  useCloud();
  let complete!: (value: unknown) => void;
  h.getMigration.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    root.render(<ServerMigrationWizard variant="tab" initialRunId="run" onClose={vi.fn()} />),
  );
  const callbacks = h.streamMigration.mock.calls[0]![1];
  h.organizationId = "org-b";
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  await act(async () => {
    complete({
      run: {
        id: "run",
        projectName: "Private org-a workload",
        status: "awaiting_cutover",
        confirmationToken: "old-secret",
      },
    });
    callbacks.onProgress({
      task: "private-volume",
      kind: "volume",
      movedBytes: 10,
      totalBytes: 100,
    });
  });
  expect(container.textContent).not.toContain("Private org-a workload");
  expect(container.textContent).not.toContain("private-volume");
  expect(h.confirmCutover).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lets New Project select a source before scanning through the shared inline wizard", async () => {
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  const scan = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Scan server",
  )!;
  expect(scan.disabled).toBe(true);
  expect(h.scanStream).not.toHaveBeenCalled();
  const picker = container.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
  expect(picker).not.toBeNull();
  await act(async () => picker.click());
  const source = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Second server"),
  )!;
  expect(source).toBeDefined();
  await act(async () => source.click());
  expect(scan.disabled).toBe(false);
  await act(async () => scan.click());
  expect(h.scanStream).toHaveBeenCalledExactlyOnceWith(
    "source-b",
    expect.objectContaining({ flatDocker: false }),
  );
});
