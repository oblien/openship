// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { setApiResourceScope } from "@/lib/api/client";
import { RuntimeSourceUpdate } from "./RuntimeSourceUpdate";

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
  await click("Read images");
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
  await click("Read images");
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
