import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));

import { projectCommand, releaseImageSourceFromOptions } from "../../src/commands/project";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship project list", () => {
  it("paginates /projects and tabulates the rows", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toContain("/api/projects");
      return { json: { data: [{ id: "p1", name: "shop", slug: "shop" }], total: 1 } };
    });
    const { out, code } = await runCommand(projectCommand, ["list"]);
    expect(code).toBe(0);
    expect(out).toContain("p1");
    expect(out).toContain("shop");
  });
});

describe("openship project get", () => {
  it("GETs /projects/:id", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { id: "p1", name: "shop" } } }));
    const { out, code } = await runCommand(projectCommand, ["get", "p1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toContain("/api/projects/p1");
    expect(out).toContain("shop");
  });
});

describe("openship project release-image", () => {
  it("PUTs the complete GitHub release image source", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toBe("http://api.test/api/projects/project%2Fone/release-image-source");
      expect(req.method).toBe("PUT");
      expect(req.body).toEqual({
        artifactKind: "image",
        mode: "github",
        imageTemplate: "ghcr.io/acme/api:{tag}",
        repo: "acme/api",
      });
      return { json: { data: { id: "project/one" } } };
    });

    const { err, code } = await runCommand(projectCommand, [
      "release-image",
      "project/one",
      "--image-template",
      "ghcr.io/acme/api:{tag}",
      "--github-repo",
      "acme/api",
    ]);

    expect(code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
    expect(err).toContain("now deploys ghcr.io/acme/api:{tag}");
  });

  it("supports a pinned-only URL source", () => {
    expect(
      releaseImageSourceFromOptions({
        imageTemplate: "registry.example.test/acme/api:{version}",
        pin: "2.4.1",
      }),
    ).toEqual({
      artifactKind: "image",
      mode: "url",
      imageTemplate: "registry.example.test/acme/api:{version}",
      pinnedVersion: "2.4.1",
    });
  });

  it("supports pinning a GitHub release source", () => {
    expect(
      releaseImageSourceFromOptions({
        imageTemplate: "ghcr.io/acme/api:{tag}",
        githubRepo: "acme/api",
        pin: "v2.4.1",
      }),
    ).toEqual({
      artifactKind: "image",
      mode: "github",
      imageTemplate: "ghcr.io/acme/api:{tag}",
      repo: "acme/api",
      pinnedVersion: "v2.4.1",
    });
  });

  it("rejects ambiguous sources before making a request", async () => {
    fetchStub = stubFetch(() => ({ json: { data: {} } }));
    const { err, code } = await runCommand(projectCommand, [
      "release-image",
      "p1",
      "--image-template",
      "ghcr.io/acme/api:{tag}",
      "--github-repo",
      "acme/api",
      "--version-url",
      "https://versions.example.test/latest",
    ]);

    expect(code).toBe(1);
    expect(err).toContain("--github-repo cannot be combined");
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("rejects insecure version endpoints", () => {
    expect(() =>
      releaseImageSourceFromOptions({
        imageTemplate: "ghcr.io/acme/api:{tag}",
        versionUrl: "http://versions.example.test/latest",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      releaseImageSourceFromOptions({
        imageTemplate: "ghcr.io/acme/api:{tag}",
        versionUrl: "https://user:token@versions.example.test/latest",
      }),
    ).toThrow("embedded credentials");
  });
});
