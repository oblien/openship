// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantDrawerLayout } from "./AssistantDrawer";
import { useAssistantNavigation } from "./AssistantLink";

const location = vi.hoisted(() => ({ search: "new=1", scope: "workspace-a", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams(location.search),
  useRouter: () => ({ replace: location.replace }),
}));
vi.mock("@/hooks/use-scoped-resource", () => ({ useResourceScope: () => location.scope }));
vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));
vi.mock("./AgentEditor", () => ({ AgentEditor: () => <input aria-label="Agent name" /> }));
vi.mock("./AssistantAgents", () => ({ AssistantAgents: () => <p>Agents</p> }));
vi.mock("./AutomationEditorData", () => ({
  AutomationEditorPanel: ({ onSaved }: { onSaved(): void }) => {
    const [name, setName] = useState("");
    const navigation = useAssistantNavigation();
    return (
      <>
        <input
          aria-label="Automation name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button onClick={() => navigation?.navigate("/assistant/agents/new")}>
          Create an agent
        </button>
        <button onClick={onSaved}>Save flow</button>
      </>
    );
  },
}));

let root: Root, host: HTMLDivElement;
function Chat() {
  const [draft, setDraft] = useState("");
  const navigation = useAssistantNavigation();
  return (
    <>
      <input
        aria-label="Message"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button onClick={() => navigation?.navigate("/assistant/automations/new")}>
        Create automation
      </button>
    </>
  );
}
const app = () => (
  <AssistantDrawerLayout>
    <Chat />
  </AssistantDrawerLayout>
);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  )!;
const input = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}
async function click(name: string) {
  await act(async () => button(name).click());
  await settle();
}
async function fill(name: string, value: string) {
  await act(async () => {
    const field = input(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  location.search = "new=1";
  location.scope = "workspace-a";
  location.replace.mockReset().mockImplementation((href: string) => {
    location.search = new URL(href, "https://openship.test").search.slice(1);
    root.render(app());
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(app()));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps the flow and chat drafts when an agent is opened within the same drawer", async () => {
  await fill("Message", "Unsent chat");
  button("Create automation").focus();
  await click("Create automation");
  await fill("Automation name", "Deployment checks");
  await click("Create an agent");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(input("Automation name").closest("[hidden]")).not.toBeNull();
  await click("Close agents");
  expect(input("Automation name").value).toBe("Deployment checks");
  expect(input("Automation name").closest("[hidden]")).toBeNull();
  await click("Close automation");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(location.search).toBe("new=1");
  expect(input("Message").value).toBe("Unsent chat");
  expect(document.activeElement).toBe(button("Create automation"));
  await click("Create automation");
  expect(input("Automation name").value).toBe("");
});

it("drops editor state across workspace changes and returns to the chat on save", async () => {
  await fill("Message", "Unsent chat");
  await click("Create automation");
  await fill("Automation name", "Private draft");
  location.scope = "workspace-b";
  await act(async () => root.render(app()));
  await settle();
  expect(input("Automation name").value).toBe("");
  await click("Save flow");
  expect(location.search).toBe("new=1");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(input("Message").value).toBe("Unsent chat");
});
