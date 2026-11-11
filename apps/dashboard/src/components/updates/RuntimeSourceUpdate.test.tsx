// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { ApiError, setApiResourceScope } from "@/lib/api/client";
import { RuntimeSourceUpdate } from "./RuntimeSourceUpdate";
import { SecurityProjectReview } from "./SecurityProjectReview";
import type { ProjectSecurityResult } from "@repo/contracts";

const api = vi.hoisted(() => ({ git: vi.fn(), read: vi.fn(), preview: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getGit: api.git } }));
vi.mock("@/lib/api/updates", () => ({
  updatesApi: {
    runtimeSource: api.read,
    previewRuntimeSource: api.preview,
    publishRuntimeSource: api.publish,
  },
}));
vi.mock("@/components/github/RepositoryPathBrowser", () => ({ RepositoryPathBrowser: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/useRuntimeUpdate", () => ({ useRuntimeUpdate: () => ({ updating: false }) }));
let root: Root, host: HTMLDivElement;
const source = {
  owner: "acme",
  repo: "app",
  branch: "main",
  baseSha: "a".repeat(40),
  path: "Dockerfile",
  url: "https://github.com/acme/app/blob/main/Dockerfile",
  references: [{ id: "from:1", label: "FROM · line 1", image: "node:22", line: 1 }],
  guidance: [],
  publishAccess: "available",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setApiResourceScope("source-test");
  vi.resetAllMocks();
  api.git.mockResolvedValue({
    gitProvider: "github",
    gitOwner: "acme",
    gitRepo: "app",
    gitBranch: "main",
  });
  api.read.mockResolvedValue({ data: source });
  api.preview.mockResolvedValue({
    data: {
      ...source,
      before: "FROM node:22\n",
      after: "FROM node:24\n",
      reviewId: "b".repeat(64),
    },
  });
  api.publish.mockResolvedValue({ data: { pullRequestUrl: "https://github.com/acme/app/pull/1" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (scope = "account-a") =>
  act(async () =>
    root.render(
      <I18nProvider>
        <CloudResourceContext.Provider value={scope}>
          <RuntimeSourceUpdate projectId="project" />
        </CloudResourceContext.Provider>
      </I18nProvider>,
    ),
  );
const click = async (text: string) => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
async function setImage(value: string) {
  const input = [...document.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Replacement image"))!
    .querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("requires a reviewed diff, invalidates it on edit, and creates a PR without triggering a deployment", async () => {
  await render();
  await click("Propose image update");
  await setImage("node:24");
  expect(document.body.textContent).not.toContain("Create draft PR");
  await click("Review change");
  expect(api.preview).toHaveBeenCalledWith(
    "project",
    expect.objectContaining({ image: "node:24", baseSha: source.baseSha }),
  );
  expect(document.body.textContent).toContain("−FROM node:22");
  await setImage("node:26");
  expect(document.body.textContent).not.toContain("Create draft PR");
  await setImage("node:24");
  await click("Review change");
  await click("Create draft PR");
  expect(api.publish).toHaveBeenCalledWith(
    "project",
    expect.objectContaining({ image: "node:24", reviewId: "b".repeat(64) }),
  );
  expect(document.body.textContent).toContain("Recheck the deployed runtime");
});
it("discards source and pending responses after an account/workspace switch", async () => {
  let resolve!: (value: unknown) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Propose image update");
  setApiResourceScope("account-b");
  await render("account-b");
  await act(async () =>
    resolve({
      data: {
        ...source,
        references: [{ ...source.references[0], image: "private-account-a:secret" }],
      },
    }),
  );
  expect(document.body.textContent).not.toContain("private-account-a");
  expect(document.body.textContent).not.toContain("Create draft PR");
});

it.each([false, true])(
  "offers source editing for a pinned advisory unless source redeploy is already required (%s)",
  async (sourceRedeployRequired) => {
    const result: ProjectSecurityResult = {
      projectId: "project",
      deploymentId: "deployment",
      checkedAt: new Date().toISOString(),
      autoRefresh: false,
      feedStale: false,
      feedError: null,
      unknownServices: [],
      findings: [
        {
          id: "pinned-node",
          revision: 1,
          title: "Update Node",
          message: "Review the image pin.",
          severity: "high",
          url: "https://example.com/advisory",
          serviceId: null,
          serviceName: null,
          evidence: ["node 22.23.3"],
          confidence: "confirmed",
          canRefresh: false,
          sourceRedeployRequired,
        },
      ],
    };
    await act(async () =>
      root.render(
        <I18nProvider>
          <SecurityProjectReview projectId="project" initialResult={result} />
        </I18nProvider>,
      ),
    );
    expect(document.body.textContent?.includes("Propose image update")).toBe(
      !sourceRedeployRequired,
    );
    expect(api.publish).not.toHaveBeenCalled();
  },
);

it("checks access on open, links to the existing connection settings, and retries after access is updated", async () => {
  api.read.mockResolvedValueOnce({ data: { ...source, publishAccess: "github_access_required" } });
  await render();
  await click("Propose image update");
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Contents and Pull requests read/write");
  expect(document.querySelector('a[href="/settings?tab=git"]')?.getAttribute("target")).toBe(
    "_blank",
  );
  await click("Check access again");
  expect(document.body.textContent).not.toContain("Contents and Pull requests read/write");
  await setImage("node:24");
  await click("Review change");
  await click("Create draft PR");
  expect(api.publish).toHaveBeenCalledTimes(1);
});

it("keeps a blocked preview unpublishable and distinguishes workspace permission from GitHub setup", async () => {
  api.read.mockResolvedValue({ data: { ...source, publishAccess: "workspace_access_required" } });
  api.preview.mockResolvedValue({
    data: {
      ...source,
      publishAccess: "workspace_access_required",
      before: "FROM node:22",
      after: "FROM node:24",
      reviewId: "b".repeat(64),
    },
  });
  await render();
  await click("Propose image update");
  expect(document.body.textContent).toContain("Ask your workspace owner");
  expect(document.querySelector('a[href="/settings?tab=git"]')).toBeNull();
  await setImage("node:24");
  await click("Review change");
  const publish = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Create draft PR",
  )!;
  expect(publish.disabled).toBe(true);
  expect(api.publish).not.toHaveBeenCalled();
});

it("offers branch recovery instead of publishing twice when PR permission is revoked", async () => {
  api.publish.mockRejectedValue(
    new ApiError(403, "Forbidden", {
      code: "REPOSITORY_PR_ACCESS_REQUIRED",
      error: "The branch was created, but GitHub denied the pull request.",
      recoveryUrl: "https://github.com/acme/app/compare/main...openship/changes/test?expand=1",
    }),
  );
  await render();
  await click("Propose image update");
  await setImage("node:24");
  await click("Review change");
  await click("Create draft PR");
  expect(document.body.textContent).toContain("Finish PR in GitHub");
  expect(document.body.textContent).not.toContain("Create draft PR");
  expect(document.querySelector('a[href*="/compare/main...openship/changes/"]')).toBeTruthy();
  expect(api.publish).toHaveBeenCalledTimes(1);
});
