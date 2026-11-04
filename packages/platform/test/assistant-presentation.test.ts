import { expect, test } from "vitest";
import type { Event, Message, ToolPart } from "mindwire";
import { assistantEvent, assistantMessages } from "../src/engine/modules/assistant/presentation";
import { assistantImagesError, ASSISTANT_IMAGE_MAX_BYTES } from "@repo/contracts";

const image = {
  name: "status.png",
  mime: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};
test("history preserves validated user images without exposing paths, artifacts or remote URLs", () => {
  const message: Message = {
    id: "user",
    chatId: "native",
    role: "user",
    text: "",
    createdAt: "",
    attachments: [
      { ...image, path: "/private/user/picture.png", artifactId: "private-id" },
      { path: "/private/auth.json", name: "auth.json" },
      { ...image, data: "https://example.com/tracker.png" },
    ],
  };
  const result = assistantMessages([message], "chat")[0];
  expect(result.attachments).toEqual([image]);
  expect(JSON.stringify(result)).not.toContain("/private");
  expect(
    assistantMessages([{ ...message, role: "assistant" }], "chat")[0].attachments,
  ).toBeUndefined();
});
test("image limits apply to decoded bytes and combined attachments", () => {
  const full = {
    ...image,
    data: Buffer.concat([
      Buffer.from(image.data, "base64"),
      Buffer.alloc(ASSISTANT_IMAGE_MAX_BYTES - Buffer.from(image.data, "base64").length),
    ]).toString("base64"),
  };
  expect(assistantImagesError([full])).toBeNull();
  expect(assistantImagesError([full, full, image])).toMatch(/8 MB/);
  expect(assistantImagesError([{ ...full, data: full.data + "AAAA" }])).toMatch(/4 MB/);
});

test("native tools keep their identity, argument payload and terminal outcome in live and saved views", () => {
  for (const type of ["mcpToolCall", "McpToolCall", "mcp_tool_call"]) {
    for (const status of ["completed", "failed", "cancelled", "incomplete"]) {
      const tool = {
        id: "call",
        name: "openship.get_projects",
        status,
        input: {
          type,
          arguments: { query: { page: 1 } },
          transport: "private-fixture",
        },
        output: '{"data":[]}',
        action: { kind: "mcp", mcp: { server: "openship", tool: "get_projects" } },
        transport: "private-fixture",
      } satisfies ToolPart & { status: string; transport: string };
      const event: Event = { type: "tool_result", tool };
      const message: Message = {
        id: "reply",
        role: "assistant",
        text: "",
        chatId: "native-private",
        createdAt: "",
        parts: [{ type: "tool", tool }],
      };
      const live = assistantEvent(event)?.tool;
      const saved = assistantMessages([message], "public-chat")[0];
      expect(live).toEqual(saved?.parts?.[0].tool);
      expect(live).toMatchObject({
        status,
        input: { query: { page: 1 } },
        action: { kind: "mcp", mcp: { server: "openship", tool: "get_projects" } },
      });
      expect(JSON.stringify(live)).not.toContain("private-fixture");
      expect(saved.chatId).toBe("public-chat");
    }
  }
});
