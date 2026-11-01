import { describe, expect, it } from "vitest";
import { listPrompts, getPrompt } from "../../../src/modules/mcp/mcp-prompts";
import { env, cloudRuntimeTarget } from "@repo/platform/engine/config/index";

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

  it("guides desktop callers through local import and managed server placement", () => {
    const text = getPrompt("deploy-a-folder", {})!.messages[0].content.text;
    expect(text).toContain("/api/projects/import");
    expect(text).toContain("localPath");
    expect(text).toContain("serverId");
    expect(text).toContain("buildStrategy:'server'");
    expect(text).toContain("create the project first");
    expect(text).toContain(`${cloudRuntimeTarget.api}/api/mcp`);
    expect(text).toContain("cannot be bypassed by omitting organizationId");
    expect(text).toContain("OAuth bearer tokens stay in the MCP client");
  });

  it("does not suggest reading a desktop path when connected directly to Cloud", () => {
    const original = env.CLOUD_MODE;
    try {
      env.CLOUD_MODE = true;
      const text = getPrompt("deploy-a-folder", {})!.messages[0].content.text;
      expect(text).not.toContain("/api/projects/import");
      expect(text).toContain("Local filesystem paths are not accessible here");
      expect(text).toContain("/api/projects/folder/session");
      expect(text).toContain("projectId");
    } finally { env.CLOUD_MODE = original; }
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
