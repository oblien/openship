// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantQuestion, AssistantSnapshot } from "@repo/contracts";
import { AssistantQuestions } from "./AssistantQuestions";

const respond = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/assistant", () => ({ assistantApi: { respond } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));

const question = (id = "repair", changes: Partial<AssistantQuestion> = {}): AssistantQuestion => ({
  id,
  kind: "form",
  title: "Open a draft PR?",
  runId: "run",
  responseMode: "message",
  needsResponse: true,
  questions: [
    {
      id: "choice",
      title: "Open a draft PR?",
      allowOther: false,
      options: [
        { id: "apply", label: "Open draft PR" },
        { id: "later", label: "Not now" },
      ],
    },
  ],
  ...changes,
});
function snapshot(questions = [question()]): AssistantSnapshot {
  return {
    conversation: {
      id: "chat",
      title: "Deployment investigation",
      provider: "codex",
      model: "",
      state: "done",
      createdAt: "",
      updatedAt: "",
    },
    messages: [
      {
        id: "live-run",
        chatId: "chat",
        role: "assistant",
        text: "",
        createdAt: "",
        parts: questions.map((interaction) => ({ type: "interaction", interaction })),
      },
    ],
    activity: { runId: "run", state: "done", cursor: 1, events: [], reset: false },
    accessChanged: false,
    hasMore: false,
  };
}
type Props = ComponentProps<typeof AssistantQuestions>;
let root: Root, host: HTMLDivElement, props: Props;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  respond.mockReset().mockResolvedValue({ accepted: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = { snapshot: snapshot(), active: false, onAnswered: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes };
  await act(async () =>
    root.render(
      <>
        <AssistantQuestions {...props} />
        <textarea aria-label="Message" defaultValue="Keep my draft" />
      </>,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  )!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function enter(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("expands above the composer without a dialog, preserving choices and the chat draft on collapse", async () => {
  await render();
  const trigger = button("Show agent questions");
  expect(trigger.textContent).toContain("Waiting for your answer");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("form")!.id).toBe(trigger.getAttribute("aria-controls"));
  expect(host.querySelector("form")!.hidden).toBe(true);
  await click("Show agent questions");
  expect(host.querySelector("form")!.hidden).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Send answer").disabled).toBe(true);
  await click("Open draft PR");
  await click("Hide agent questions");
  await click("Show agent questions");
  expect(button("Open draft PR").getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("textarea")!.value).toBe("Keep my draft");
  expect(respond).not.toHaveBeenCalled();
});

it("submits one answer through the existing API and disables edits and repeat submissions while sending", async () => {
  let resolve!: () => void;
  respond.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  await render();
  await click("Show agent questions");
  await submit();
  expect(respond).not.toHaveBeenCalled();
  await click("Open draft PR");
  await submit();
  await submit();
  expect(respond).toHaveBeenCalledExactlyOnceWith("chat", {
    interactionId: "repair",
    requestId: expect.any(String),
    answers: { choice: { options: ["apply"] } },
  });
  expect(button("Sending…").disabled).toBe(true);
  expect(button("Hide agent questions").disabled).toBe(true);
  expect(host.querySelector("fieldset")!.disabled).toBe(true);
  await act(async () => resolve());
  expect(props.onAnswered).toHaveBeenCalledTimes(1);
  expect(host.querySelector("form")!.hidden).toBe(true);
  await render({ snapshot: snapshot([question("repair", { needsResponse: false })]) });
  expect(host.querySelector("section")).toBeNull();
});

it("retains answers and retry identity on failure, but creates a new identity when the answer changes", async () => {
  respond.mockRejectedValue(new Error("Connection unavailable"));
  await render();
  await click("Show agent questions");
  await click("Open draft PR");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable");
  expect(host.querySelector("form")!.hidden).toBe(false);
  expect(props.onAnswered).not.toHaveBeenCalled();
  const first = respond.mock.calls[0]![1];
  await submit();
  expect(respond.mock.calls[1]![1]).toEqual(first);
  await click("Not now");
  await submit();
  expect(respond.mock.calls[2]![1].requestId).not.toBe(first.requestId);
  expect(respond.mock.calls[2]![1].answers.choice.options).toEqual(["later"]);
});

it("keeps separate drafts for queued requests and advances when another viewer resolves one", async () => {
  await render({ snapshot: snapshot([question(), question("second")]) });
  await click("Show agent questions");
  await click("Open draft PR");
  await click("Question 2");
  expect(button("Send answer").disabled).toBe(true);
  await click("Not now");
  await click("Question 1");
  expect(button("Open draft PR").getAttribute("aria-checked")).toBe("true");
  await render({
    snapshot: snapshot([question("repair", { needsResponse: false }), question("second")]),
  });
  expect(button("Not now").getAttribute("aria-checked")).toBe("true");
  await submit();
  expect(respond).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      interactionId: "second",
      answers: { choice: { options: ["later"] } },
    }),
  );
});

it("keeps text, secret and multi-select answers while collapsing, and validates required fields", async () => {
  await render({
    snapshot: snapshot([
      question("details", {
        questions: [
          { id: "token", title: "Token", isSecret: true },
          {
            id: "services",
            title: "Services",
            multiSelect: true,
            allowOther: false,
            options: [
              { id: "api", label: "API" },
              { id: "web", label: "Web" },
            ],
          },
          { id: "note", title: "Note", optional: true },
        ],
      }),
    ]),
  });
  await click("Show agent questions");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Answer: Token"]')!.type).toBe(
    "password",
  );
  await click("API");
  await click("Web");
  await enter("Answer: Token", "  ");
  expect(button("Send answer").disabled).toBe(true);
  await enter("Answer: Token", "secret-value");
  await click("Hide agent questions");
  await click("Show agent questions");
  expect(button("Send answer").disabled).toBe(false);
  await submit();
  expect(respond).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      answers: {
        token: { text: "secret-value" },
        services: { options: ["api", "web"] },
      },
    }),
  );
});

it("expires native requests after their run ends while keeping message-mode questions answerable", async () => {
  const native = question("native", { responseMode: undefined });
  await render({ snapshot: snapshot([native]), active: true });
  await click("Show agent questions");
  await render({ active: false });
  expect(host.querySelector("section")).toBeNull();
  await render({ snapshot: snapshot() });
  expect(host.querySelector("section")).not.toBeNull();
});
