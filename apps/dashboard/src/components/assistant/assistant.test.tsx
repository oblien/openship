import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appendAssistantEvents,
  pendingAssistantQuestions,
  assistantFieldInput,
  type AssistantSnapshot,
  type AssistantActivity,
  type AssistantPart,
  type PermissionAccessRequest,
} from "@repo/contracts";
import { mergeAssistantActivity } from "./use-conversation";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { parseToolOutput } from "./tool-output";
import { AssistantAccessRequest, permissionRequest } from "./AssistantAccessRequest";

const snapshot = (): AssistantSnapshot => ({
  conversation: {
    id: "chat",
    title: "Test",
    provider: "codex",
    model: "",
    state: "running",
    createdAt: "",
    updatedAt: "",
  },
  messages: [],
  activity: { runId: "run", state: "running", cursor: 0, events: [], reset: false },
  accessChanged: false,
  hasMore: false,
});
describe("Assistant presentation and replay", () => {
  it("only offers permission review for a successful access-request tool result from this connection", () => {
    const request: PermissionAccessRequest = {
      kind: "permission_request",
      granted: false,
      clientId: "our-agent",
      organizationId: "our-org",
      reason: "The requested restart needs write access.",
      access: "Write access to the API project.",
      reviewPath: "/settings?tab=mcp",
    };
    const part = (name: string, output: unknown, isError = false): AssistantPart => ({
      type: "tool",
      tool: {
        id: "request",
        name,
        input: {},
        output: typeof output === "string" ? output : JSON.stringify(output),
        isError,
      },
    });
    for (const prefix of ["", "mcp__openship__", "mcp__openship_", "openship.", "functions."]) {
      const result = part(`${prefix}get_permissions_access_request`, {
        content: [{ type: "text", text: JSON.stringify({ data: request }) }],
      });
      expect(permissionRequest(result, "our-agent")).toEqual(request);
      expect(permissionRequest(result, "other-agent")).toBeNull();
    }
    expect(permissionRequest(part("get_projects", request), "our-agent")).toBeNull();
    expect(
      permissionRequest(
        part("get_permissions_access_request", { ...request, granted: true }),
        "our-agent",
      ),
    ).toBeNull();
    expect(
      permissionRequest(part("get_permissions_access_request", request, true), "our-agent"),
    ).toBeNull();
    expect(
      permissionRequest(
        part("get_permissions_access_request", {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(request) }],
        }),
        "our-agent",
      ),
    ).toBeNull();
    expect(
      permissionRequest(
        part("get_permissions_access_request", { ...request, access: "x".repeat(2001) }),
        "our-agent",
      ),
    ).toBeNull();
    expect(
      permissionRequest({ type: "text", text: JSON.stringify(request) }, "our-agent"),
    ).toBeNull();
    const html = renderToStaticMarkup(
      <AssistantAccessRequest
        request={{ ...request, reason: '<img src="https://example.com/track">' }}
        onReview={() => {
          throw new Error("Must wait for the user's click");
        }}
      />,
    );
    expect(html).toContain("Review permissions");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
  });
  it("ignores delayed activity that would rewind the displayed turn", () => {
    const current = snapshot();
    current.activity.cursor = 5;
    current.activity.state = "done";
    expect(
      mergeAssistantActivity(current, {
        runId: "run",
        state: "running",
        cursor: 3,
        reset: false,
        events: [{ sequence: 3, native: { type: "text", text: "Old response", delta: true } }],
      }),
    ).toBe(current);
  });
  it("does not duplicate text on repeated activity and keeps late tool results above answers", () => {
    const activity: AssistantActivity = {
      runId: "run",
      state: "running" as const,
      cursor: 2,
      reset: false,
      events: [
        { sequence: 1, native: { type: "text", itemId: "text", delta: true, text: "Checking " } },
        { sequence: 2, native: { type: "text", itemId: "text", delta: true, text: "apps" } },
      ],
    };
    let state = mergeAssistantActivity(snapshot(), activity);
    state = mergeAssistantActivity(state, activity);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe("Checking apps");
    const messages = appendAssistantEvents(
      state.messages,
      [
        {
          sequence: 3,
          native: { type: "tool_use", tool: { id: "tool", name: "get_projects", input: {} } },
        },
        {
          sequence: 4,
          native: {
            type: "input",
            input: { id: "answer", text: "The API", createdAt: "", status: "accepted" },
          },
        },
        {
          sequence: 5,
          native: { type: "tool_result", tool: { id: "tool", output: '{"data":[]}' } },
        },
        { sequence: 6, native: { type: "text", text: "No projects", delta: false } },
      ],
      "run",
    );
    expect(messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages[0].parts?.find((p) => p.tool)?.tool?.output).toBe('{"data":[]}');
    expect(messages[2].text).toBe("No projects");
  });
  it("retains async questions after completion and removes acknowledged ones", () => {
    const interaction = {
      id: "question",
      kind: "form",
      responseMode: "message" as const,
      needsResponse: true,
      questions: [{ id: "app", title: "Which app?" }],
    };
    let messages = appendAssistantEvents(
      [],
      [{ sequence: 1, native: { type: "interaction", interaction } }],
      "run",
    );
    expect(pendingAssistantQuestions(messages, "run", false)).toHaveLength(1);
    messages = appendAssistantEvents(
      messages,
      [
        {
          sequence: 2,
          native: { type: "interaction", interaction: { ...interaction, needsResponse: false } },
        },
      ],
      "run",
    );
    expect(pendingAssistantQuestions(messages, "run", false)).toHaveLength(0);
  });
  it("drops hidden alternate credentials before authentication", () => {
    expect(
      assistantFieldInput(
        [
          { key: "type", label: "Type", type: "select", default: "native" },
          { key: "key", label: "Key", type: "secret", visibleWhen: { key: "type", equals: "api" } },
        ],
        { key: "hidden-secret" },
      ),
    ).toEqual({ type: "native" });
  });
  it("unpacks nested MCP payloads and preserves errors", () => {
    expect(
      parseToolOutput(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: "Permission denied" }) }],
          },
        }),
      ),
    ).toEqual({ isError: true, value: { error: "Permission denied" } });
    expect(
      parseToolOutput({ structuredContent: { success: true, data: [{ name: "API" }] } }),
    ).toEqual({ isError: false, value: [{ name: "API" }] });
  });
  it("never renders raw HTML, script links or remote image loads", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {
          "<script>alert(1)</script>\n\n![tracker](https://example.com/track)\n\n[unsafe](javascript:alert(1))\n\n[project](/projects/p1)\n\n| App | State |\n| --- | --- |\n| API | Ready |"
        }
      </AssistantMarkdown>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("https://example.com/track");
    expect(html).toContain('href="/projects/p1"');
    expect(html).toContain('data-streamdown="table"');
  });
  it("keeps fenced code inert while offering a code-only copy action", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>{'```html\n<img src="https://example.com/track" onerror="alert(1)">\n```'}</AssistantMarkdown>,
    );
    expect(html).toContain("Copy code");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
