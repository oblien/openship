// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EdgePagesPanel } from "./EdgePagesPanel";
import { HtmlDocumentEditor } from "./HtmlDocumentEditor";
import { EdgePagesEditor } from "./EdgePagesEditor";
const api = vi.hoisted(() => ({ getEdgePages: vi.fn(), updateEdgePages: vi.fn() }));
const serverApi = vi.hoisted(() => ({ getEdgePages: vi.fn(), updateEdgePages: vi.fn() }));
vi.mock("@/lib/api", () => ({ projectsApi: api, getApiErrorMessage: (e: Error) => e.message }));
vi.mock("@/lib/api/system", () => ({ systemApi: serverApi }));
let root: Root;
let container: HTMLDivElement;
const saved = {
  config: { defaults: { files: [], errors: [], maintenance: { enabled: true, retryAfter: 300 } } },
  status: "applied",
  revision: "a".repeat(64),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.getEdgePages.mockResolvedValue(saved);
  serverApi.getEdgePages.mockResolvedValue({ config: { files: [], errors: [] } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text || button.getAttribute("aria-label") === text,
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
it.each(["project", "server"] as const)(
  "keeps %s settings unavailable while loading, then reveals the saved configuration",
  async (scope) => {
    let complete!: () => void;
    const target = scope === "project" ? api : serverApi;
    target.getEdgePages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve(scope === "project" ? saved : { config: saved.config.defaults });
        }),
    );
    await act(async () =>
      root.render(
        scope === "project" ? (
          <EdgePagesPanel projectId="project" hostnames={[]} />
        ) : (
          <EdgePagesPanel serverId="server" />
        ),
      ),
    );
    expect(container.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain(
      "Loading pages…",
    );
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Add file");
    await click("Save & apply");
    expect(target.updateEdgePages).not.toHaveBeenCalled();

    await act(async () => complete());
    expect(container.textContent).not.toContain("Loading pages…");
    expect(container.textContent).toContain("Add file");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    if (scope === "project") {
      expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    }
  },
);
it("does not expose an empty editable server configuration after a failed read", async () => {
  serverApi.getEdgePages.mockRejectedValue(new Error("connection lost"));
  await act(async () => root.render(<EdgePagesPanel serverId="server" />));
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(container.textContent).not.toContain("Add file");
  expect(container.textContent).toContain("connection lost");
  expect(serverApi.updateEdgePages).not.toHaveBeenCalled();
  serverApi.getEdgePages.mockResolvedValue({ config: { files: [], errors: [] } });
  await click("Retry");
  expect(container.textContent).toContain("Add file");
});
it("ends a timed-out project read with Retry and loads the saved settings on retry", async () => {
  let fail!: (error: Error) => void;
  api.getEdgePages.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await act(async () => root.render(<EdgePagesPanel projectId="project" hostnames={[]} />));
  expect(container.textContent).toContain("Loading pages…");
  await act(async () => fail(new Error("Request timed out. The server took too long to respond.")));
  expect(container.textContent).not.toContain("Loading pages…");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Request timed out.");
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(container.textContent).not.toContain("Add file");
  await click("Retry");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Add file");
  expect(api.getEdgePages).toHaveBeenCalledTimes(2);
});
it("shows pending application, submits the saved revision and waits for acknowledgement", async () => {
  api.getEdgePages.mockResolvedValue({ ...saved, status: "pending" });
  let complete!: (result: typeof saved) => void;
  api.updateEdgePages.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    root.render(<EdgePagesPanel projectId="project" hostnames={["site.test"]} />),
  );
  expect(container.textContent).toContain("Edge application is pending");
  await click("Save & apply");
  expect(api.updateEdgePages).toHaveBeenCalledWith("project", saved.config, saved.revision);
  expect(container.textContent).not.toContain("Applied to the edge.");
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  await act(async () => complete(saved));
  expect(container.textContent).toContain("Applied to the edge.");
});
it("resets state across project navigation and ignores a late old-project read", async () => {
  let complete!: (result: typeof saved) => void;
  api.getEdgePages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<EdgePagesPanel projectId="old" hostnames={[]} />));
  api.getEdgePages.mockResolvedValue({ ...saved, config: {}, status: "unpublished" });
  await act(async () => root.render(<EdgePagesPanel projectId="new" hostnames={[]} />));
  await act(async () => complete(saved));
  expect(container.textContent).toContain("will apply when the project is deployed");
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
});
it("keeps a rejected draft, hides stale applied state, and explicitly reloads the saved revision", async () => {
  await act(async () => root.render(<EdgePagesPanel projectId="project" hostnames={[]} />));
  api.updateEdgePages.mockRejectedValue(new Error("Settings changed in another session"));
  await click("Save & apply");
  expect(container.textContent).not.toContain("Applied to the edge.");
  await click("Maintenance mode");
  await click("Save & apply");
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  api.getEdgePages.mockResolvedValue({ ...saved, revision: "b".repeat(64) });
  await click("Discard draft & reload");
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  api.updateEdgePages.mockResolvedValue(saved);
  await click("Save & apply");
  expect(api.updateEdgePages).toHaveBeenLastCalledWith("project", saved.config, "b".repeat(64));
});
it("keeps the draft visible and disables changes until a reload succeeds", async () => {
  await act(async () => root.render(<EdgePagesPanel projectId="project" hostnames={[]} />));
  await click("Maintenance mode");
  api.updateEdgePages.mockRejectedValue(new Error("Settings changed in another session"));
  await click("Save & apply");
  let complete!: (result: typeof saved) => void;
  api.getEdgePages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await click("Discard draft & reload");
  expect(container.textContent).toContain("Loading pages…");
  expect(container.textContent).toContain("HTML files");
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click("Save & apply");
  expect(api.updateEdgePages).toHaveBeenCalledTimes(1);
  await act(async () => complete(saved));
  expect(container.textContent).not.toContain("Loading pages…");
  expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
it("shows inherited maintenance and copies its HTML without overwriting a hostname's file", async () => {
  const onChange = vi.fn();
  const file = { id: "shared", name: "unavailable.html", html: "<h1>Unavailable</h1>" };
  await act(async () =>
    root.render(
      <EdgePagesEditor
        value={{ files: [file], errors: [{ status: 502, pageId: "shared" }] }}
        inheritedMaintenance={{
          files: [{ ...file, html: "<h1>Maintenance</h1>" }],
          errors: [],
          maintenance: { enabled: true, pageId: "shared", retryAfter: 600 },
        }}
        onChange={onChange}
      />,
    ),
  );
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Uses the project’s maintenance settings.");
  await click("Customize maintenance");
  const next = onChange.mock.calls[0][0];
  expect(next.files[0]).toEqual(file);
  expect(next.files[1]).toMatchObject({ html: "<h1>Maintenance</h1>" });
  expect(next.maintenance).toEqual({ enabled: true, pageId: next.files[1].id, retryAfter: 600 });
  expect(next.maintenance.pageId).not.toBe(file.id);
});
it("previews HTML in an opaque sandbox instead of injecting it into the dashboard", async () => {
  const html =
    '<script>window.injected=true</script><img src="https://example.invalid/pixel"><h1>Page</h1>';
  await act(async () => root.render(<HtmlDocumentEditor value={html} onChange={() => {}} />));
  await click("Preview");
  const preview = container.querySelector("iframe")!;
  expect(preview.getAttribute("sandbox")).toBe("");
  expect(preview.srcdoc).toContain("default-src 'none'");
  expect(preview.srcdoc).toContain(html);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
});
