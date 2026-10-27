// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { RepositoryPathBrowser } from "./RepositoryPathBrowser";
import { setApiResourceScope } from "@/lib/api/client";

const tree = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/github", () => ({ githubApi: { getRepoTree: tree } }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tree.mockReset();
  setApiResourceScope("browser-test");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (repo: string, onChange = vi.fn(), serverId?: string) =>
  act(async () =>
    root.render(
      <I18nProvider>
        <RepositoryPathBrowser
          source={{ owner: "example", repo, branch: "dev", serverId }}
          kind="file"
          value="Dockerfile"
          onChange={onChange}
        />
      </I18nProvider>,
    ),
  );
it("discards an earlier repository response after switching repositories", async () => {
  let resolveOld!: (data: unknown) => void;
  tree.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  await render("old");
  tree.mockResolvedValueOnce({ data: [{ path: "new.Dockerfile", type: "file" }] });
  await render("new");
  await act(async () => resolveOld({ data: [{ path: "private-old.Dockerfile", type: "file" }] }));
  expect(host.textContent).toContain("new.Dockerfile");
  expect(host.textContent).not.toContain("private-old.Dockerfile");
});
it("does not select an old account's file after its request scope changes", async () => {
  const changed = vi.fn();
  tree.mockResolvedValue({ data: [{ path: "Dockerfile", type: "file" }] });
  await render("repo", changed);
  setApiResourceScope("different-account");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(changed).not.toHaveBeenCalled();
});
it("does not publish a delayed tree from a disconnected account", async () => {
  let resolveTree!: (data: unknown) => void;
  tree.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveTree = resolve;
      }),
  );
  await render("repo");
  setApiResourceScope("disconnected");
  await act(async () => resolveTree({ data: [{ path: "private.Dockerfile", type: "file" }] }));
  expect(host.textContent).not.toContain("private.Dockerfile");
});

it("discards a previous server's pending tree when the destination changes", async () => {
  let finish!: (data: unknown) => void;
  tree.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render("repo", vi.fn(), "server-old");
  tree.mockResolvedValueOnce({ data: [{ path: "current.Dockerfile", type: "file" }] });
  await render("repo", vi.fn(), "server-new");
  expect(tree).toHaveBeenLastCalledWith("example", "repo", "dev", "server-new");
  await act(async () => finish({ data: [{ path: "previous.Dockerfile", type: "file" }] }));
  expect(host.textContent).toContain("current.Dockerfile");
  expect(host.textContent).not.toContain("previous.Dockerfile");
});
