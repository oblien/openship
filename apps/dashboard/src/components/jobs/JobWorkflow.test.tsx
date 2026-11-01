// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { JobForm } from "./JobForm";

const h = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), onSaved: vi.fn() }));
vi.mock("@/lib/api", () => ({
  jobsApi: {
    create: h.create,
    list: async () => ({ data: [] }),
    triggerEvents: async () => ({ data: [] }),
  },
  notificationsApi: { listChannels: async () => ({ channels: [] }) },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { list: h.list } }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "local" }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => vi.fn() }));
vi.mock("@/hooks/useServerDestinations", () => ({
  useServerDestinations: () => ({
    organizationId: "org",
    data: { servers: [] },
    loading: false,
    error: null,
  }),
}));

let host: HTMLDivElement;
let root: Root;
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  )!;
const click = (text: string) => act(async () => button(text).click());
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <JobForm initialWorkflowId="workflow" onSaved={h.onSaved} onCancel={() => {}} />
      </I18nProvider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.list.mockResolvedValue([
    {
      id: "workflow",
      name: "Release",
      enabled: true,
      plan: {
        triggers: ["workflow_dispatch"],
        inputs: [
          {
            name: "version",
            description: "Release version",
            required: true,
            type: "string",
            default: "",
            options: [],
          },
          {
            name: "dry_run",
            description: "Preview changes",
            required: false,
            type: "boolean",
            default: "true",
            options: [],
          },
        ],
      },
    },
  ]);
  h.create.mockResolvedValue({ data: { key: "job" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Jobs invokes the saved workflow", () => {
  it("uses declared inputs without requiring a command or a second server selection", async () => {
    await render();
    const c = baseDictionary.jobs.create;
    await fill(
      host.querySelector<HTMLInputElement>(`input[placeholder="${c.namePlaceholder}"]`)!,
      "Release job",
    );
    expect(button(c.submit).disabled).toBe(true);
    await fill(
      [...host.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("version"))!
        .querySelector("input")!,
      "1.2.3",
    );
    expect(button(c.submit).disabled).toBe(false);
    expect(
      host.querySelector('[role="checkbox"][aria-label="dry_run"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    await click(c.submit);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "workflow",
        inputs: { version: "1.2.3", dry_run: "true" },
        scheduleType: "recurring",
      }),
    );
    expect(h.create.mock.calls[0]![0]).not.toHaveProperty("command");
    expect(h.create.mock.calls[0]![0]).not.toHaveProperty("serverIds");
    expect(h.onSaved).toHaveBeenCalledOnce();
  });
  it("keeps a missing workflow unsaveable and offers the shared setup page", async () => {
    h.list.mockResolvedValue([]);
    await render();
    const c = baseDictionary.jobs.create;
    await fill(
      host.querySelector<HTMLInputElement>(`input[placeholder="${c.namePlaceholder}"]`)!,
      "Release job",
    );
    expect(button(c.submit).disabled).toBe(true);
    expect(host.querySelector('a[href="/actions/new"]')?.textContent).toBe(
      baseDictionary.actions.newWorkflow,
    );
    expect(h.create).not.toHaveBeenCalled();
  });
});
