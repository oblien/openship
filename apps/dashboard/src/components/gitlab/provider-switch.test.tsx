// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GITHUB_PROVIDER } from "@repo/core";
import * as gitContext from "@/context/GitContext";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";
import { GitProviderSelect } from "@/components/git/GitProviderSelect";
const { GitConnectionsProvider, useGit } = gitContext;
const list = vi.hoisted(() => vi.fn());
const workspace = vi.hoisted(() => ({ id: "first" }));
vi.mock("@/hooks/use-scoped-resource", async (original) => ({
  ...(await original<typeof import("@/hooks/use-scoped-resource")>()),
  useResourceScope: () => workspace.id,
}));
vi.mock("@/components/github/useGitHubConnection", () => ({
  useGitHubConnection: () => ({
    definition: GITHUB_PROVIDER,
    icon: "github",
    selectedOwner: "octocat",
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/api/git", () => ({
  gitApi: (provider: string) => ({ getUserRepos: () => list(provider) }),
  gitSourcesChangedEvent: (provider: string) => "test:" + provider,
}));
function Picker() {
  const git = useGit();
  const page = useLibraryRepos(git.selectedOwner, git.connected, git.definition.id, git.catalog);
  return (
    <>
      <GitProviderSelect />
      <button onClick={() => git.setSelectedOwner("team/other")}>Other namespace</button>
      <button onClick={() => page.setVisibility("private")}>Private repos</button>
      <button onClick={page.refresh}>Refresh catalog</button>
      <span data-list>
        {page.meta.count}/{page.meta.total}
      </span>
      <output>
        {git.definition.name}/{git.selectedOwner}
      </output>
    </>
  );
}
async function select(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (row) => row.textContent === label,
  )!;
  await act(async () => option.click());
}
it("switches back and forth while keeping each provider's namespace and loading GitLab on demand", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockResolvedValue({
    data: [
      { owner: "team/subgroup", full_name: "team/subgroup/app", name: "app", private: false },
      { owner: "team/other", full_name: "team/other/api", name: "api", private: true },
      { owner: "team/other", full_name: "team/other/web", name: "web", private: false },
    ],
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <GitConnectionsProvider>
          <Picker />
        </GitConnectionsProvider>,
      ),
    );
    expect(list).not.toHaveBeenCalled();
    await select("GitLab");
    expect(list).toHaveBeenCalledExactlyOnceWith("gitlab");
    expect(node.querySelector("output")?.textContent).toBe("GitLab/team/subgroup");
    const click = (label: string) =>
      act(async () =>
        [...node.querySelectorAll("button")]
          .find((button) => button.textContent === label)!
          .click(),
      );
    await click("Other namespace");
    expect(node.querySelector("[data-list]")?.textContent).toBe("2/2");
    await click("Private repos");
    expect(node.querySelector("[data-list]")?.textContent).toBe("1/2");
    expect(list).toHaveBeenCalledTimes(1);
    await click("Refresh catalog");
    expect(list).toHaveBeenCalledTimes(2);
    await select("GitHub");
    expect(node.querySelector("output")?.textContent).toBe("GitHub/octocat");
    await select("GitLab");
    expect(node.querySelector("output")?.textContent).toBe("GitLab/team/other");
    expect(list.mock.calls).toEqual([["gitlab"], ["gitlab"]]);
    workspace.id = "second";
    let finish!: (value: { data: never[] }) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(
        <GitConnectionsProvider>
          <Picker />
        </GitConnectionsProvider>,
      ),
    );
    expect(node.querySelector("output")?.textContent).toBe("GitLab/");
    expect(node.querySelector("[data-list]")?.textContent).toBe("0/0");
    await act(async () => finish({ data: [] }));
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    node.remove();
    workspace.id = "first";
    vi.unstubAllGlobals();
  }
});

it("keeps all registered providers directly accessible in the sidebar switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onSelect = vi.fn();
  const mock = vi.spyOn(gitContext, "useGit").mockImplementation(() => {
    const git = useGit();
    const additional = {
      ...git.connections[0],
      definition: { ...git.definition, id: "self-hosted", name: "Self-hosted Git" },
    };
    return { ...git, connections: [...git.connections, additional], selectProvider: onSelect };
  });
  const node = document.body.appendChild(document.createElement("div"));
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <GitConnectionsProvider>
          <GitProviderSelect segmented />
        </GitConnectionsProvider>,
      ),
    );
    const buttons = [...node.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "GitHub",
      "GitLab",
      "Self-hosted Git",
    ]);
    await act(async () => buttons[2].click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("self-hosted");
  } finally {
    await act(async () => root.unmount());
    node.remove();
    mock.mockRestore();
    vi.unstubAllGlobals();
  }
});
