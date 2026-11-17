import { describe, expect, it } from "vitest";
import {
  deployInstallCommand,
  deployLinkHref,
  deploySetupHref,
  encodeRepoSlug,
  isRepositoryDeployPath,
  parseDeployDestination,
  parseDeploySource,
} from "./deploy-link";

describe("public deployment intent", () => {
  it("round-trips an app and a repository/branch through the public link", () => {
    for (const input of [
      { app: "n8n" },
      { repo: "https://www.github.com/owner/my.app.git/", branch: "release/v2" },
    ]) {
      const source = parseDeploySource(input);
      const url = new URL(deployLinkHref(source, "server"), "https://openship.io");
      const params = Object.fromEntries(url.searchParams);
      expect(parseDeploySource(params)).toEqual(source);
      expect(parseDeployDestination(params.destination)).toBe("server");
      expect(url.pathname).toBe("/deploy");
    }
  });

  it.each([{ app: "n8n" }, { repo: "https://github.com/owner/repo", branch: "main" }])("carries referral codes from shared buttons to Cloud setup: %j", (input) => {
    const source = parseDeploySource(input);
    const link = new URL(deployLinkHref(source, undefined, "AF-COMMUNITY"), "https://openship.io");
    const setup = new URL(deploySetupHref(parseDeploySource(Object.fromEntries(link.searchParams)), "cloud", link.searchParams.get("ref")!), "https://app.openship.io");
    expect(setup.searchParams.get("ref")).toBe("AF-COMMUNITY");
    expect(setup.searchParams.get("destination")).toBe("cloud");
  });

  it("shares the dashboard's base64url repository slug while accepting pasted URLs", () => {
    const source = parseDeploySource({
      repo: "https://github.com/oblien/mindwire",
      branch: "release/v2",
    });
    const link = new URL(deployLinkHref(source), "https://openship.io");
    expect(link.searchParams.get("repo")).toBe(encodeRepoSlug("oblien", "mindwire"));
    expect(link.searchParams.get("repo")).toBe("b2JsaWVuL21pbmR3aXJl");
    expect(parseDeploySource(Object.fromEntries(link.searchParams))).toEqual(source);
    const setup = new URL(deploySetupHref(source), "https://app.openship.io");
    expect(setup.pathname).toBe(`/deploy/${link.searchParams.get("repo")}`);
    expect(setup.searchParams.get("branch")).toBe("release/v2");
  });

  it.each([
    "local:/etc/passwd",
    "upload:session",
    "project:proj_1",
    "repo:v2:{}",
    '{"repo":"owner/repo","command":"id"}',
    "https://github.com/owner/repo",
    "owner/repo/extra",
    "owner/repo.git",
    "owner/repo?token=secret",
    "../repo",
    "owner/$(id)",
    "owner/repo\n",
  ])("rejects encoded non-repository payloads: %s", (payload) => {
    expect(() => parseDeploySource({ repo: Buffer.from(payload).toString("base64url") })).toThrow();
  });

  it.each(["b3duZXIvcmVwbw==", "b3duZXIvcmVwbx", "b3duZXIvcmVwbw\n", "A".repeat(401)])(
    "rejects noncanonical or oversized encoded references: %s",
    (repo) => {
      expect(() => parseDeploySource({ repo })).toThrow();
    },
  );

  it.each([
    {},
    { app: "n8n", repo: "https://github.com/owner/repo" },
    { app: ["n8n", "redis"] },
    { app: "../../admin" },
    { app: "N8N" },
    { app: "n8n", branch: "main" },
    { repo: ["https://github.com/a/b"] },
    ...[
      "file:///etc/passwd",
      "https://127.0.0.1/repo.git",
      "https://github.com.evil.test/owner/repo",
      "https://token@github.com/owner/repo",
      "https://github.com:123/owner/repo",
      "https://github.com/owner/repo?token=secret",
      "https://github.com/owner/repo#payload",
      "https://github.com/owner/repo/tree/main",
      "https://github.com/owner/$(id)",
    ].map((repo) => ({ repo })),
    ...[
      "",
      "--upload-pack=evil",
      "$(id)",
      "main\nanything",
      "a..b",
      "a//b",
      "foo.lock",
      "main~1",
      "main/",
    ].map((branch) => ({ repo: "https://github.com/a/b", branch })),
  ])("rejects ambiguous or executable input: %j", (input) => {
    expect(() => parseDeploySource(input)).toThrow();
  });

  it("passes source arguments to the local launcher, never a saved Cloud context", () => {
    const source = parseDeploySource({
      repo: "https://github.com/owner/repo",
      branch: "release/v2",
    });
    expect(deployInstallCommand(source)).toBe(
      "curl -fsSL https://get.openship.io | sh -s -- --repo 'https://github.com/owner/repo' --branch 'release/v2'",
    );
    expect(deployInstallCommand(parseDeploySource({ app: "n8n" }), true)).toBe(
      "openship launch --app 'n8n'",
    );
    expect(parseDeployDestination("https://evil.test")).toBeUndefined();
  });
  it("reuses the ordinary repository slug and app wizard routes", () => {
    const source = parseDeploySource({
      repo: "https://github.com/owner/repo",
      branch: "release/v2",
    });
    const href = deploySetupHref(source, "server");
    const url = new URL(href, "https://app.openship.io");
    expect(Buffer.from(url.pathname.split("/").pop()!, "base64url").toString()).toBe("owner/repo");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      branch: "release/v2",
      destination: "server",
    });
    expect(deploySetupHref(parseDeploySource({ app: "n8n" }), "cloud")).toBe(
      "/apps/new/n8n?destination=cloud",
    );
    expect(encodeRepoSlug("owner", "a.repo-name")).toBe(
      Buffer.from("owner/a.repo-name").toString("base64url"),
    );
  });
  it("only allows canonical repository setup paths as sign-in continuations", () => {
    expect(isRepositoryDeployPath(`/deploy/${encodeRepoSlug("owner", "repo")}`)).toBe(true);
    for (const decoded of [
      "local:/etc/passwd",
      "upload:session",
      "project:proj_1",
      "repo:v2:{}",
      "owner/repo/extra",
      "../repo",
      "owner/repo?token=secret",
      "owner/$(id)",
    ]) {
      expect(isRepositoryDeployPath(`/deploy/${Buffer.from(decoded).toString("base64url")}`)).toBe(
        false,
      );
    }
    expect(isRepositoryDeployPath("/deploy/mail")).toBe(false);
    expect(isRepositoryDeployPath("/deploy/../settings")).toBe(false);
    expect(isRepositoryDeployPath(`//evil.test/deploy/${encodeRepoSlug("owner", "repo")}`)).toBe(
      false,
    );
  });
});
