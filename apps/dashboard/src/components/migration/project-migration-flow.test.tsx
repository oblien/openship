// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMigrationCard } from "./ProjectMigrationCard";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  started: vi.fn(),
  toast: vi.fn(),
  hide: vi.fn(),
  modal: vi.fn(),
}));
vi.mock("@/lib/api/services", () => ({ servicesApi: { list: h.list } }));
vi.mock("@/lib/api/server-migration", () => ({
  dockerMigrationApi: { startProjectMove: h.start },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: h.modal, hideModal: h.hide }),
}));
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({ excludeIds, onSelect, disabled, value }: any) => (
    <div>
      <span data-target>{value ?? "No target"}</span>
      {["source", "other"]
        .filter((id) => !excludeIds.includes(id))
        .map((id) => (
          <button key={id} disabled={disabled} onClick={() => onSelect({ id, name: id })}>
            {id}
          </button>
        ))}
    </div>
  ),
}));
let host: HTMLDivElement, root: Root;
const services = [
  { name: "api", volumes: [], advanced: {} },
  { name: "db", volumes: ["data:/data"], advanced: {} },
];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.list.mockResolvedValue({ success: true, services });
  h.start.mockResolvedValue({ migrationId: "copy-run" });
  h.modal.mockReturnValue("review");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(extra: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(
      <ProjectMigrationCard
        projectId="project"
        projectName="Shop"
        sourceServerId="source"
        sourceServerName="Source"
        initialIntent="copy"
        initialServiceNames={["api"]}
        copyOnly
        onStarted={h.started}
        {...extra}
      />,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const duplicate = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .filter((node) => node.textContent?.trim() === "Duplicate")
    .at(-1)!;
const checkbox = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((node) =>
    node.textContent?.includes(name),
  )!;
const click = async (node: HTMLElement) => {
  await act(async () => node.click());
};
const review = () => h.modal.mock.calls.at(-1)![0];

describe("duplicate selection, review, submission and recovery", () => {
  it("reviews a same-server scoped copy, then opens the durable run", async () => {
    await render();
    await click(button("source"));
    await click(duplicate());
    expect(h.start).not.toHaveBeenCalled();
    expect(review().message).toContain("api");
    expect(review().message).toContain("pause");
    await act(async () => review().buttons[1].onClick());
    expect(h.start).toHaveBeenCalledExactlyOnceWith({
      projectId: "project",
      targetServerId: "source",
      intent: "copy",
      serviceNames: ["api"],
      newName: "Shop-copy",
    });
    expect(h.started).toHaveBeenCalledExactlyOnceWith("copy-run");
  });
  it("never widens an empty explicit selection into copying all services", async () => {
    await render();
    await click(button("source"));
    await click(checkbox("api"));
    expect(duplicate().disabled).toBe(true);
    expect(host.textContent).toContain("Select at least one");
  });
  it("does not allow all-services copy before discovery completes or after a failed load", async () => {
    let reject!: (value: unknown) => void;
    h.list.mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    await render({ initialServiceNames: undefined });
    await click(button("source"));
    expect(duplicate().disabled).toBe(true);
    await act(async () => reject(new Error("offline")));
    expect(duplicate().disabled).toBe(true);
    await click(button("Retry"));
    expect(duplicate().disabled).toBe(false);
  });
  it("requires the selected service's dependencies", async () => {
    h.list.mockResolvedValue({ services: [{ ...services[0], dependsOn: ["db"] }, services[1]] });
    await render();
    await click(button("source"));
    expect(duplicate().disabled).toBe(true);
    expect(host.textContent).toContain("Include these dependencies in the copy: db");
    await click(checkbox("db"));
    expect(duplicate().disabled).toBe(false);
  });
  it("clears a same-server destination when switching to Move", async () => {
    await render({ copyOnly: false });
    await click(button("source"));
    await click(button("Move"));
    expect(host.querySelector("[data-target]")?.textContent).toBe("No target");
    expect(button("Migrate").disabled).toBe(true);
    expect(button("source")).toBeUndefined();
  });
  it("submits once, locks controls while pending, and permits retry after failure", async () => {
    let reject!: (value: unknown) => void;
    h.start.mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    await render();
    await click(button("source"));
    await click(duplicate());
    await act(async () => {
      review().buttons[1].onClick();
      review().buttons[1].onClick();
    });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(checkbox("api").disabled).toBe(true);
    await act(async () => reject(new Error("Target unavailable")));
    expect(h.toast).toHaveBeenCalledWith("Target unavailable", "error", expect.any(String));
    expect(duplicate().disabled).toBe(false);
    await click(duplicate());
    await act(async () => review().buttons[1].onClick());
    expect(h.started).toHaveBeenCalledWith("copy-run");
  });
  it("keeps cancellation read-only and resets private drafts when switching projects", async () => {
    await render();
    await click(button("source"));
    await click(duplicate());
    await act(async () => review().buttons[0].onClick());
    expect(h.start).not.toHaveBeenCalled();
    await render({ projectId: "another", projectName: "Other" });
    expect(host.querySelector("[data-target]")?.textContent).toBe("No target");
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Other-copy");
  });
});
