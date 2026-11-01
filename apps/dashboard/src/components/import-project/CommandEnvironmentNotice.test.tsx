// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { CommandEnvironmentNotice } from "./CommandEnvironmentNotice";
const m = vi.hoisted(() => ({ post: vi.fn(), scope: 1 }));
vi.mock("@/lib/api/client", () => ({
  api: { post: m.post },
  getApiRequestScopeVersion: () => m.scope,
}));
vi.mock("@/lib/api", () => ({ getApiErrorMessage: (_: unknown, fallback: string) => fallback }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.post.mockReset();
  m.scope = 1;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows names without values and moves draft commands and variables together", async () => {
  const migrate = vi.fn();
  await act(async () =>
    root.render(
      <CommandEnvironmentNotice
        commands={{ buildCommand: "TOKEN='sensitive value' bun run build" }}
        migrateDraft={migrate}
      />,
    ),
  );
  expect(container.textContent).toContain("TOKEN");
  expect(container.textContent).not.toContain("sensitive value");
  await act(async () => container.querySelector("button")!.click());
  expect(migrate).toHaveBeenCalledWith(
    { buildCommand: "bun run build" },
    { TOKEN: "sensitive value" },
  );
});
it("does not migrate expressions or overwrite conflicting draft values", async () => {
  const migrate = vi.fn();
  await act(async () =>
    root.render(
      <CommandEnvironmentNotice
        commands={{ buildCommand: "TOKEN=$SECRET build" }}
        migrateDraft={migrate}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  await act(async () =>
    root.render(
      <CommandEnvironmentNotice
        commands={{ buildCommand: "TOKEN=one build", startCommand: "TOKEN=two start" }}
        migrateDraft={migrate}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(migrate).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("different values");
});
it("warns about chained assignments without exposing their values or offering partial migration", async () => {
  const migrate = vi.fn();
  await act(async () =>
    root.render(
      <CommandEnvironmentNotice
        commands={{ buildCommand: "prepare && TOKEN=private-value build" }}
        migrateDraft={migrate}
      />,
    ),
  );
  expect(container.textContent).toContain("TOKEN");
  expect(container.textContent).not.toContain("private-value");
  expect(container.querySelector("button")).toBeNull();
  expect(migrate).not.toHaveBeenCalled();
});
it("submits a service-scoped atomic migration and ignores a response after account scope changes", async () => {
  const changed = vi.fn();
  let resolve!: (value: unknown) => void;
  m.post.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () =>
    root.render(
      <CommandEnvironmentNotice
        projectId="project"
        serviceId="service"
        commands={{ startCommand: "TOKEN=secret serve" }}
        onMigrated={changed}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(m.post).toHaveBeenCalledWith("projects/project/env/migrate-commands", {
    environment: "production",
    serviceId: "service",
    commands: { startCommand: "TOKEN=secret serve" },
  });
  m.scope++;
  await act(async () => resolve({ data: { commands: { startCommand: "serve" } } }));
  expect(changed).not.toHaveBeenCalled();
});
