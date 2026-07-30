import { describe, expect, it } from "vitest";
import { listPrompts, getPrompt } from "../../../src/modules/mcp/mcp-prompts";

/**
 * The guided-flow catalog (MCP `prompts`). Tool-name references resolve against
 * the live registry; in an isolated unit test the registry is empty, so refs
 * fall back to "METHOD /path" — assertions here target that stable fallback and
 * the structural contract, not generated tool names.
 */

describe("mcp prompts catalog", () => {
  it("lists the guided flows with names + descriptions", () => {
    const prompts = listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "openship-overview",
        "deploy-from-git",
        "deploy-a-folder",
        "install-catalog-app",
      ]),
    );
    for (const p of prompts) {
      expect(typeof p.name).toBe("string");
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("deploy-a-folder returns a user message describing the out-of-band upload", () => {
    const res = getPrompt("deploy-a-folder", {});
    expect(res).not.toBeNull();
    const text = (res!.messages[0] as { content: { text: string } }).content.text;
    expect(text).toMatch(/out.of.band/i);
    expect(text).toContain("/api/projects/folder/session");
    expect(text).toContain("/api/deployments/build/access");
  });

  it("deploy-from-git interpolates the repo argument", () => {
    const res = getPrompt("deploy-from-git", { repo: "acme/widgets", branch: "prod" });
    const text = (res!.messages[0] as { content: { text: string } }).content.text;
    expect(text).toContain("acme/widgets");
    expect(text).toContain("prod");
  });

  it("every prompt tells the agent where to report platform bugs", () => {
    for (const p of listPrompts()) {
      const res = getPrompt(p.name, {});
      const text = (res!.messages[0] as { content: { text: string } }).content.text;
      expect(text).toContain("https://github.com/oblien/openship/issues");
    }
  });

  it("returns null for an unknown prompt", () => {
    expect(getPrompt("does-not-exist", {})).toBeNull();
  });
});
