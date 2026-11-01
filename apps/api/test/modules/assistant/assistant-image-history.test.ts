import { expect, it, vi } from "vitest";
import type {
  AssistantNativeClient,
  MessagePage,
} from "@repo/platform/engine/modules/assistant/native-target";
import { assistantImageHistory } from "../../../src/modules/assistant/assistant-image-history";

const message = (id: string, bytes = 4 * 1024 * 1024) => ({
  id,
  chatId: "native-chat",
  role: "user",
  text: "Inspect",
  createdAt: "",
  attachments: [
    { name: "status.png", artifactId: id, bytes, mime: "image/png", path: "/private/host/path" },
  ],
});
it("hydrates only the selected conversation's images and budgets expanded native history", async () => {
  const artifact = vi.fn(async (id: string) => ({
    id,
    chatId: id === "foreign" ? "another-chat" : "native-chat",
    bytes: 16,
    mime: "image/png",
    data: "fixture",
  }));
  const client = { surfaces: { artifact } } as unknown as AssistantNativeClient["mindwire"];
  const page: MessagePage = {
    messages: [message("oldest"), message("middle"), message("newest")],
    hasMore: false,
  };
  const result = await assistantImageHistory(client, "native-chat", page);
  expect(result.messages.map((m) => m.id)).toEqual(["middle", "newest"]);
  expect(result.hasMore).toBe(true);
  expect(result.before).toBe("middle");
  expect(artifact.mock.calls.map(([id]) => id)).toEqual(["middle", "newest"]);
  expect(result.messages[0].attachments).toEqual([
    { name: "status.png", mime: "image/png", data: "fixture" },
  ]);
  expect(
    (
      await assistantImageHistory(client, "native-chat", {
        messages: [message("foreign")],
        hasMore: false,
      })
    ).messages[0].attachments,
  ).toEqual([]);
});
