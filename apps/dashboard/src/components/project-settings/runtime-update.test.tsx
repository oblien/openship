// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ApiError, setApiResourceScope } from "@/lib/api/client";
import { useRuntimeUpdate } from "@/hooks/useRuntimeUpdate";
import { RuntimeRedeployMenu } from "./RuntimeRedeployMenu";
import { RuntimeImageUpdateNotice } from "./RuntimeImageUpdateNotice";
import { SecurityProjectReview } from "../updates/SecurityProjectReview";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  check: vi.fn(),
  security: vi.fn(),
  checkSecurity: vi.fn(),
  policy: vi.fn(),
  applySecurity: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  pricing: vi.fn(),
  resourceKey: "account-one",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.resourceKey }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => h.pricing }));
vi.mock("@/lib/api/updates", () => ({
  updatesApi: {
    updateRuntime: h.update,
    checkRuntime: h.check,
    security: h.security,
    checkSecurity: h.checkSecurity,
    securityPolicy: h.policy,
    applySecurity: h.applySecurity,
  },
}));

let root: Root;
let element: HTMLDivElement;
const c = baseDictionary.projectSettings.runtimeUpdates;
function Harness({
  projectId = "project-a",
  serviceId = "php",
  disabled = false,
  revision,
}: {
  projectId?: string;
  serviceId?: string;
  disabled?: boolean;
  revision?: string;
}) {
  const runtime = useRuntimeUpdate(projectId, serviceId, undefined, revision);
  return (
    <>
      <button disabled={disabled || runtime.updating} onClick={() => void runtime.update()}>
        Redeploy
      </button>
      <RuntimeRedeployMenu runtime={runtime} disabled={disabled} />
      <RuntimeImageUpdateNotice
        result={runtime.checkResult}
        busy={runtime.updating}
        onRefresh={runtime.update}
      />
    </>
  );
}
function button(label: string) {
  const match = [...element.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(match, label).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function menuAction(label: string) {
  await click(c.options);
  await click(label);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const image = {
  serviceId: "php",
  serviceName: "php",
  role: "image",
  ref: "php:8.4-fpm",
  currentDigest: "sha256:old",
  latestDigest: "sha256:new",
  status: "update_available",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.resourceKey = "account-one";
  setApiResourceScope(`runtime-test-${Math.random()}`);
  h.update.mockResolvedValue({
    data: { deployment_id: "new-deployment", project_id: "project-a" },
  });
  h.check.mockResolvedValue({
    data: { checkedAt: new Date().toISOString(), images: [image] },
  });
  h.pricing.mockReturnValue(false);
  h.security.mockReset().mockResolvedValue({
    data: {
      projectId: "project-a",
      deploymentId: "deployed-a",
      checkedAt: new Date().toISOString(),
      autoRefresh: false,
      feedStale: false,
      feedError: null,
      unknownServices: [],
      findings: [
        {
          id: "patch-node",
          revision: 1,
          serviceId: "php",
          title: "Patch runtime",
          message: "A runtime patch is available.",
          url: "https://example.com/security",
          confidence: "confirmed",
          evidence: ["php 8.4.1"],
          canRefresh: true,
          severity: "high",
        },
      ],
    },
  });
  h.applySecurity
    .mockReset()
    .mockResolvedValue({ data: { deployment_id: "security-deployment", project_id: "project-a" } });
  h.policy.mockReset().mockResolvedValue({ data: { autoRefresh: true } });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

it("refreshes exactly the selected service through the Redeploy menu", async () => {
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  expect(h.update).toHaveBeenCalledExactlyOnceWith("project-a", { serviceIds: ["php"] });
  expect(h.push).toHaveBeenCalledExactlyOnceWith("/build/new-deployment");
});

it("routes an Actions-gated refresh to the project's existing Actions flow", async () => {
  h.update.mockResolvedValue({
    data: { awaiting_actions: true, action_request_id: "request-a", project_id: "project-a" },
  });
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  expect(h.push).toHaveBeenCalledExactlyOnceWith("/projects/project-a/actions");
  expect(h.toast).not.toHaveBeenCalled();
});

it("deduplicates repeated refresh clicks while admission is pending", async () => {
  const pending = deferred<unknown>();
  h.update.mockReturnValue(pending.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    button("Redeploy").click();
    button("Redeploy").click();
  });
  expect(h.update).toHaveBeenCalledOnce();
  expect(button("Redeploy").disabled).toBe(true);
  expect(button(c.options).disabled).toBe(true);
  await act(async () =>
    pending.resolve({ data: { deployment_id: "new", project_id: "project-a" } }),
  );
});

it("keeps disabled lifecycle controls unavailable", async () => {
  await act(async () => root.render(<Harness disabled />));
  expect(button("Redeploy").disabled).toBe(true);
  expect(button(c.options).disabled).toBe(true);
  await click("Redeploy");
  expect(h.update).not.toHaveBeenCalled();
});

it("checks runtime digests in exactly the same service scope and offers one refresh notice", async () => {
  await act(async () => root.render(<Harness />));
  await menuAction(c.check);
  expect(h.check).toHaveBeenCalledExactlyOnceWith("project-a", { serviceIds: ["php"] });
  expect(element.textContent).toContain(c.available);
  expect(element.textContent).toContain("php:8.4-fpm");
  expect(element.textContent).toContain("sha256:old → sha256:new");
  expect(h.update).not.toHaveBeenCalled();
  await click(c.refresh);
  expect(h.update).toHaveBeenCalledExactlyOnceWith("project-a", { serviceIds: ["php"] });
});

it.each([
  { status: "unknown", currentDigest: null, expected: c.checkUnavailable },
  { status: "pinned", currentDigest: "sha256:fixed", expected: c.pinned },
  { status: "current", currentDigest: "sha256:new", expected: c.current },
])(
  "reports $status distinctly without claiming a runtime patch version",
  async ({ status, currentDigest, expected }) => {
    h.check.mockResolvedValue({
      data: {
        checkedAt: new Date().toISOString(),
        images: [{ ...image, status, currentDigest }],
      },
    });
    await act(async () => root.render(<Harness />));
    await menuAction(c.check);
    expect(h.toast).toHaveBeenCalledExactlyOnceWith(expected, "info");
    expect(element.textContent).not.toContain(c.available);
  },
);

it("keeps check failures retryable without triggering redeploy", async () => {
  h.check.mockRejectedValue(new ApiError(502, "Bad gateway", { error: "Registry unavailable" }));
  await act(async () => root.render(<Harness />));
  await menuAction(c.check);
  expect(h.toast).toHaveBeenCalledWith("Registry unavailable", "error");
  expect(button(c.options).disabled).toBe(false);
  expect(h.update).not.toHaveBeenCalled();
});

it("surfaces an API rejection and restores the refresh action", async () => {
  h.update.mockRejectedValue(new ApiError(409, "Conflict", { error: "Digest pins stay fixed" }));
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  expect(h.toast).toHaveBeenCalledWith("Digest pins stay fixed", "error", c.title);
  expect(h.push).not.toHaveBeenCalled();
  expect(button(c.options).disabled).toBe(false);
});

it("does not navigate or show private results after changing account", async () => {
  const pending = deferred<unknown>();
  h.update.mockReturnValue(pending.promise);
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  h.resourceKey = "account-two";
  setApiResourceScope("account-two");
  await act(async () => root.render(<Harness />));
  await act(async () =>
    pending.resolve({ data: { deployment_id: "old-account", project_id: "project-a" } }),
  );
  expect(h.push).not.toHaveBeenCalled();
  expect(h.toast).not.toHaveBeenCalled();
  expect(button(c.options).disabled).toBe(false);
});

it("discards a digest check completed after switching services", async () => {
  const pending = deferred<unknown>();
  h.check.mockReturnValue(pending.promise);
  await act(async () => root.render(<Harness />));
  await menuAction(c.check);
  await act(async () => root.render(<Harness serviceId="node" />));
  await act(async () =>
    pending.resolve({
      data: { checkedAt: new Date().toISOString(), images: [image] },
    }),
  );
  expect(element.textContent).not.toContain("php:8.4-fpm");
  expect(h.toast).not.toHaveBeenCalled();
});

it("does not use a saved billing retry after changing project", async () => {
  h.update.mockRejectedValue(new ApiError(402, "Payment required", { error: "Plan required" }));
  h.pricing.mockReturnValue(true);
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  const retry = h.pricing.mock.calls[0][1] as () => Promise<void>;
  await act(async () => root.render(<Harness projectId="project-b" />));
  await act(async () => retry());
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.toast).not.toHaveBeenCalled();
});

it("keeps a timed-out refresh recoverable without starting a second deployment", async () => {
  h.update.mockRejectedValue(new DOMException("Timed out", "AbortError"));
  await act(async () => root.render(<Harness />));
  await menuAction(c.refresh);
  expect(h.toast).toHaveBeenCalledWith(c.uncertain, "info");
  expect(h.push).toHaveBeenCalledWith("/projects/project-a/deployments");
  expect(h.update).toHaveBeenCalledOnce();
});

it("clears old image drift when the active deployment or configuration changes", async () => {
  await act(async () => root.render(<Harness revision="deployment-one" />));
  await menuAction(c.check);
  expect(element.textContent).toContain(c.available);
  await act(async () => root.render(<Harness revision="deployment-two" />));
  expect(element.textContent).not.toContain(c.available);
});

it("keeps security patches off by default and sends the reviewed advisory through the runtime flow", async () => {
  await act(async () => root.render(<SecurityProjectReview projectId="project-a" />));
  expect(
    button(baseDictionary.projectSettings.securityAdvisories.automatic).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
  await click(c.refresh);
  expect(h.applySecurity).toHaveBeenCalledExactlyOnceWith("project-a", {
    advisoryId: "patch-node",
    deploymentId: "deployed-a",
    serviceId: "php",
  });
  expect(h.update).not.toHaveBeenCalled();
  expect(h.push).toHaveBeenCalledWith("/build/security-deployment");
});

it("never shows another workspace's delayed security findings", async () => {
  const pending = deferred<unknown>();
  h.security.mockReturnValueOnce(pending.promise);
  await act(async () => root.render(<SecurityProjectReview projectId="project-a" />));
  h.resourceKey = "account-two";
  h.security.mockResolvedValue({
    data: {
      projectId: "project-b",
      deploymentId: null,
      autoRefresh: false,
      feedStale: false,
      feedError: null,
      unknownServices: [],
      checkedAt: null,
      findings: [],
    },
  });
  await act(async () => root.render(<SecurityProjectReview projectId="project-b" />));
  await act(async () =>
    pending.resolve({
      data: {
        projectId: "project-a",
        deploymentId: "old",
        unknownServices: [],
        findings: [
          {
            id: "secret",
            serviceId: "secret-service",
            title: "Private service evidence",
            evidence: [],
          },
        ],
      },
    }),
  );
  expect(element.textContent).not.toContain("Private service evidence");
});

it("shows a failed security check without claiming no matching vulnerabilities", async () => {
  h.security.mockRejectedValue(new Error("Disconnected"));
  await act(async () => root.render(<SecurityProjectReview projectId="project-a" />));
  expect(element.textContent).toContain(
    baseDictionary.projectSettings.securityAdvisories.unavailable,
  );
  expect(element.textContent).not.toContain(
    baseDictionary.projectSettings.securityAdvisories.noMatches,
  );
  expect(button(baseDictionary.projectSettings.securityAdvisories.automatic).disabled).toBe(true);
});

it("refreshes runtime observations explicitly without deploying or changing policy", async () => {
  h.checkSecurity.mockReset().mockResolvedValue({
    data: {
      projectId: "project-a",
      deploymentId: "deployed-a",
      checkedAt: new Date().toISOString(),
      autoRefresh: false,
      feedStale: false,
      feedError: null,
      unknownServices: [],
      findings: [],
    },
  });
  await act(async () => root.render(<SecurityProjectReview projectId="project-a" />));
  await act(async () =>
    button(baseDictionary.projectSettings.securityAdvisories.checkAgain).click(),
  );
  expect(h.checkSecurity).toHaveBeenCalledExactlyOnceWith("project-a");
  expect(h.applySecurity).not.toHaveBeenCalled();
  expect(h.policy).not.toHaveBeenCalled();
  expect(element.textContent).toContain(
    baseDictionary.projectSettings.securityAdvisories.noMatches,
  );
});

it("explains a source redeploy prerequisite before offering a refresh and opens the normal deployment controls", async () => {
  const result = await h.security();
  result.data.findings[0] = {
    ...result.data.findings[0],
    canRefresh: false,
    sourceRedeployRequired: true,
    refreshBlockedReason:
      "Runtime update cannot confirm the source revision of a replayed artifact.",
  };
  h.security.mockResolvedValue(result);
  await act(async () => root.render(<SecurityProjectReview projectId="project-a" />));
  const copy = baseDictionary.projectSettings.securityAdvisories;
  expect(element.textContent).toContain(copy.sourceRedeployRequired);
  expect(
    [...element.querySelectorAll("button")].some((item) => item.textContent === c.refresh),
  ).toBe(false);
  await click(copy.openSourceRedeploy);
  expect(h.push).toHaveBeenCalledExactlyOnceWith("/projects/project-a/deployments");
  expect(h.applySecurity).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});
