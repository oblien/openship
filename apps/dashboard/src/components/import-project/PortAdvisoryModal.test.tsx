// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import type { PortCheckUI } from "@/context/deployment/types";
import { PortAdvisoryModal } from "./PortAdvisoryModal";

const api = vi.hoisted(() => ({
  skip: vi.fn(),
  project: vi.fn(),
  service: vi.fn(),
  toast: vi.fn(),
  resolved: vi.fn(),
}));
vi.mock("@/lib/api/deploy", () => ({ deployApi: { skipPortCheck: api.skip } }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { update: api.project } }));
vi.mock("@/lib/api/services", () => ({ servicesApi: { update: api.service } }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.toast }) }));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

const copy = baseDictionary.importProject.deploymentProcessing.portAdvisory;
const check: PortCheckUI = {
  port: 3000,
  serviceId: "svc-app",
  serviceName: "web",
  listening: true,
  checked: true,
  loopbackOnly: true,
};
let host: HTMLDivElement;
let root: Root;

function Harness({ compose, result = check }: { compose: boolean; result?: PortCheckUI }) {
  const [skipped, setSkipped] = useState<(number | string)[]>([]);
  return (
    <PortAdvisoryModal
      deploymentId="dep-live"
      projectId="project"
      checks={[result]}
      skipped={skipped}
      isCompose={compose}
      onResolved={(id, target) => {
        api.resolved(id, target);
        setSkipped((previous) => [...previous, target]);
      }}
    />
  );
}
async function render(compose: boolean, result?: PortCheckUI) {
  await act(async () => root.render(<Harness compose={compose} result={result} />));
}
function skipButton() {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === copy.skip,
  )!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.skip.mockResolvedValue({ success: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("port review", () => {
  it.each([false, true])(
    "offers binding guidance and dismissal, not a port rewrite (Compose: %s)",
    async (compose) => {
      await render(compose);
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain("0.0.0.0");
      expect(host.querySelector("input")).toBeNull();
      expect(host.querySelector("a")?.getAttribute("href")).toBe(
        compose ? "/projects/project/services/svc-app" : "/projects/project/advanced",
      );

      await act(async () => skipButton().click());
      expect(api.skip).toHaveBeenCalledWith("dep-live", compose ? "svc-app" : 3000);
      expect(api.resolved).toHaveBeenCalledWith("dep-live", compose ? "svc-app" : 3000);
      expect(host.textContent).toBe("");
      expect(api.project).not.toHaveBeenCalled();
      expect(api.service).not.toHaveBeenCalled();
    },
  );

  it("retains the warning on a failed dismissal and prevents duplicate requests while saving", async () => {
    let reject!: (reason: Error) => void;
    api.skip.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    await render(false);
    await act(async () => skipButton().click());
    expect(skipButton().disabled).toBe(true);
    await act(async () => skipButton().click());
    expect(api.skip).toHaveBeenCalledTimes(1);
    expect(api.resolved).not.toHaveBeenCalled();

    await act(async () => reject(new Error("connection lost")));
    expect(skipButton().disabled).toBe(false);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(api.toast).toHaveBeenCalledWith(copy.skipError, "error");
    await act(async () => skipButton().click());
    expect(host.textContent).toBe("");
  });

  it("keeps the existing port editor for a checked non-listening port", async () => {
    await render(false, { ...check, listening: false, loopbackOnly: undefined });
    expect(host.querySelector("input")?.value).toBe("3000");
    expect(host.textContent).toContain(copy.changePort);
  });

  it("does not prompt when the probe was inconclusive", async () => {
    await render(false, { ...check, checked: false });
    expect(host.textContent).toBe("");
  });
});
