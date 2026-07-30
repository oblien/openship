import { describe, expect, it } from "vitest";

import { buildDiscordMessage, buildSlackMessage } from "../../src/lib/notification-workers";

describe("notification chat-webhook payload limits", () => {
  it("clamps a long Slack section body to Slack's 3000-char limit", () => {
    const msg = buildSlackMessage({ title: "Deployment failed", body: "x".repeat(5000) });
    const section = msg.blocks[1] as { text: { text: string } };
    expect(section.text.text.length).toBeLessThanOrEqual(3000);
    expect(section.text.text.startsWith("```\n")).toBe(true);
    expect(section.text.text.endsWith("\n```")).toBe(true);
  });

  it("clamps a long Slack header to Slack's 150-char limit", () => {
    const msg = buildSlackMessage({ title: "T".repeat(400), body: "body" });
    const header = msg.blocks[0] as { text: { text: string } };
    expect(header.text.text.length).toBeLessThanOrEqual(150);
  });

  it("clamps a long Discord embed to Discord's 256/4096-char limits", () => {
    const msg = buildDiscordMessage({
      title: "D".repeat(400),
      body: "y".repeat(9000),
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const embed = msg.embeds[0] as { title: string; description: string; timestamp: string };
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("leaves a short message untouched", () => {
    const msg = buildSlackMessage({ title: "Deploy OK", body: "All good" });
    const section = msg.blocks[1] as { text: { text: string } };
    expect(section.text.text).toBe("```\nAll good\n```");
  });
});
