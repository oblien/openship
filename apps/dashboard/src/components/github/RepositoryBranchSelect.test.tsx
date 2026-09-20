// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryBranchSelect } from "./RepositoryBranchSelect";
import { CustomSelect } from "@/components/ui/CustomSelect";

const api = vi.hoisted(() => ({ listBranches: vi.fn(), getBranchPage: vi.fn() }));
vi.mock("@/lib/api/github", () => ({ githubApi: api }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: api }));
let container: HTMLDivElement;
let root: Root;
const changed = vi.fn();
const page = (names: string[], number = 1, hasMore = false) => ({
  data: names.map((name) => ({ name })),
  pagination: { page: number, perPage: 100, hasMore },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(repo = "app", projectId?: string, value = "main") {
  await act(async () =>
    root.render(
      <RepositoryBranchSelect
        owner="acme"
        repo={repo}
        projectId={projectId}
        value={value}
        onChange={changed}
      />,
    ),
  );
}
async function open() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click(),
  );
}
async function search(query: string) {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function options() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

describe("repository branch selection (#870)", () => {
  it("keeps the selected branch highlighted when a page inserts earlier names", async () => {
    let finish!: (result: ReturnType<typeof page>) => void;
    api.listBranches.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render("app", undefined, "z-current");
    await open();
    await act(async () => finish(page(["a-other", "m-middle"])));
    await act(async () =>
      document.querySelector('input[role="combobox"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith("z-current");
  });

  it("keeps main pinned and searches branches beyond the first hundred in the migration picker", async () => {
    api.listBranches
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => `a-${i}`),
          1,
          true,
        ),
      )
      .mockResolvedValueOnce(page(["main", "master", "z-last"], 2));
    await render();
    await open();
    expect(options()[0]?.textContent).toBe("main");
    expect(options()).toHaveLength(101);
    await search("z-last");
    expect(api.listBranches).toHaveBeenLastCalledWith("acme", "app", 2);
    expect(options().map((option) => option.textContent)).toEqual(["z-last"]);
    await act(async () =>
      document
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(changed).toHaveBeenCalledWith("z-last");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("uses the project-scoped paginated operation for an existing deployment", async () => {
    api.getBranchPage.mockResolvedValue(page(["feature", "main"]));
    await render("app", "project-id");
    await open();
    expect(api.getBranchPage).toHaveBeenCalledWith("project-id", 1);
    expect(api.listBranches).not.toHaveBeenCalled();
    await act(async () =>
      options()
        .find((option) => option.textContent === "feature")!
        .click(),
    );
    expect(changed).toHaveBeenCalledWith("feature");
  });

  it("discards a previous repository's late page when the repository changes", async () => {
    let finish!: (result: ReturnType<typeof page>) => void;
    api.listBranches.mockImplementation((_owner, repo) =>
      repo === "old"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(page(["new-only"])),
    );
    await render("old");
    await open();
    await render("new");
    await open();
    await act(async () => finish(page(["old-only"])));
    expect(options().map((option) => option.textContent)).toEqual(["main", "new-only"]);
  });

  it("shows a retryable page failure without repeatedly requesting the failed page", async () => {
    api.listBranches.mockRejectedValueOnce(new Error("offline"));
    await render();
    await open();
    await search("feature");
    expect(api.listBranches).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load branches",
    );
    api.listBranches.mockResolvedValue(page(["feature"]));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    expect(options().map((option) => option.textContent)).toEqual(["feature"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves description search and query-specific empty messages for existing selectors", async () => {
    await act(async () =>
      root.render(
        <CustomSelect
          value="one"
          options={[{ value: "one", label: "Project", description: "example.test" }]}
          onChange={changed}
          searchPlaceholder="Search projects"
          emptySearchMessage={(query) => `No project: ${query}`}
        />,
      ),
    );
    await open();
    await search("example.test");
    expect(options()).toHaveLength(1);
    await search("missing");
    expect(document.body.textContent).toContain("No project: missing");
  });
});
