import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ChatCoreProps } from "@mindwire-ai/client";
import type { AssistantMessage, AssistantPart } from "@repo/contracts";
import { AssistantTranscript } from "./AssistantTranscript";

// SSR has no viewport to measure. Exercise the real shared rows here; the
// browser suite covers virtualization and scrolling with actual dimensions.
vi.mock("@mindwire-ai/client", async (original) => {
  const client = await original<typeof import("@mindwire-ai/client")>();
  return {
    ...client,
    ChatCore: (props: ChatCoreProps) => <client.ChatCore {...props} virtualization="none" />,
  };
});

const response = (parts: AssistantPart[]): AssistantMessage => ({
  id: "response",
  chatId: "chat",
  role: "assistant",
  text: "",
  createdAt: "",
  parts,
});
function render(messages: AssistantMessage[], active = true, pending?: "Sending" | "Working") {
  return renderToStaticMarkup(
    <AssistantTranscript
      messages={messages}
      active={active}
      pending={pending}
      clientId="connection"
      onReviewAccess={() => {}}
      onEarlier={async () => {}}
    />,
  );
}

it("shows activity before the send request has returned and while opening the accepted chat", () => {
  expect(render([], false, "Sending")).toContain('role="status"');
  expect(render([], false, "Sending")).toContain("Sending");
  expect(render([], false, "Working")).toContain("Working");
});

it("keeps activity visible after text arrives until the turn actually finishes", () => {
  const messages = [response([{ type: "text", text: "I’ll check the deployment." }])];
  expect(render(messages)).toContain("Working");
  expect(render(messages, false)).not.toContain("Working");
  expect(render(messages, false)).not.toContain("Copy response");
});

it("uses the live thinking indicator without a duplicate Working indicator", () => {
  const messages = [response([{ type: "thinking", text: "Checking the latest state." }])];
  expect(render(messages)).toContain("Thinking");
  expect(render(messages)).not.toContain("Working");
  expect(render(messages, false)).not.toContain('role="status"');
});

it("keeps working after a tool completes, while retaining the tool’s actual state", () => {
  const messages = [
    response([
      {
        type: "tool",
        tool: { id: "tool", name: "get_projects", input: {}, output: "[]" },
      },
    ]),
  ];
  const html = render(messages);
  expect(html).toContain("Completed");
  expect(html).toContain("Working");
  expect(render(messages, false)).not.toContain('role="status"');
});
