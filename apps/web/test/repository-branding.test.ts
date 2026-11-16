import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { deploySourceParams, parseDeploySource } from "@repo/core";
import { createRepositoryBrandingLoader } from "../src/lib/repository-branding";
import { GET } from "../src/app/api/deploy/branding/route";

function repository(name = "owner/app", branch?: string) {
  const source = parseDeploySource({ repo: `https://github.com/${name}`, branch });
  if (source.kind !== "repo") throw new Error("Expected repository");
  return source;
}

function manifest(display: unknown = { name: "My app", logo: "public/logo.svg" }) {
  return Response.json({ display, env: { TOKEN: "must-not-be-exposed" }, services: [{}] });
}

describe("public repository branding", () => {
  test("fetches one public file on the requested branch and projects only validated display fields", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const load = createRepositoryBrandingLoader({
      now: () => 0,
      fetchFile: async (url, init) => {
        requests.push({ url, init });
        return manifest({ name: "  My app  ", logo: "./public/my logo.svg", env: "ignore" });
      },
    });
    const result = await load(repository("Owner/App", "release/v2"));
    expect(result).toEqual({
      display: {
        name: "My app",
        logoUrl: "https://raw.githubusercontent.com/owner/app/release%2Fv2/public/my%20logo.svg",
      },
      maxAge: 1800,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://raw.githubusercontent.com/owner/app/release%2Fv2/openship.json",
    );
    expect(requests[0].init).toMatchObject({
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(Object.keys(requests[0].init.headers!)).toEqual(["Accept"]);
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("must-not-be-exposed");
  });

  test("uses the default branch, coalesces in-flight reads and caches by repository and branch", async () => {
    let release!: (value: Response) => void;
    const requests: string[] = [];
    const load = createRepositoryBrandingLoader({
      now: () => 0,
      fetchFile: (url) => {
        requests.push(url);
        return requests.length === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(manifest());
      },
    });
    const first = load(repository("Owner/App"));
    const second = load(repository());
    expect(requests).toEqual(["https://raw.githubusercontent.com/owner/app/HEAD/openship.json"]);
    release(manifest());
    expect(await first).toEqual(await second);
    await load(repository());
    expect(requests).toHaveLength(1);
    await load(repository("owner/app", "main"));
    await load(repository("owner/other"));
    expect(requests).toHaveLength(3);
  });

  test("revalidates cached display fields with the ETag after expiry", async () => {
    let clock = 0;
    const headers: Headers[] = [];
    const load = createRepositoryBrandingLoader({
      now: () => clock,
      fetchFile: async (_url, init) => {
        headers.push(new Headers(init.headers));
        return headers.length === 1
          ? new Response(
              JSON.stringify({ display: { name: "My app" }, env: { SECRET: "hidden" } }),
              { headers: { ETag: '"v1"' } },
            )
          : new Response(null, { status: 304 });
      },
    });
    expect((await load(repository())).maxAge).toBe(1800);
    clock = 1799_000;
    expect((await load(repository())).maxAge).toBe(1);
    expect(headers).toHaveLength(1);
    clock = 1800_000;
    expect(await load(repository())).toEqual({ display: { name: "My app" }, maxAge: 1800 });
    expect(headers[1].get("If-None-Match")).toBe('"v1"');
  });

  test.each([
    ["private or missing file", () => new Response("not found", { status: 404 })],
    ["invalid JSON", () => new Response("{invalid")],
    ["missing metadata", () => Response.json({ framework: "nextjs" })],
    ["non-object manifest", () => Response.json([])],
    ["invalid display", () => manifest({ name: 42, logo: "https://untrusted.example/logo.svg" })],
    [
      "timeout or redirect failure",
      () => {
        throw new DOMException("Timed out", "TimeoutError");
      },
    ],
  ] as const)("falls back and negative-caches %s", async (_label, response) => {
    let calls = 0,
      clock = 0;
    const load = createRepositoryBrandingLoader({
      now: () => clock,
      fetchFile: async () => {
        calls++;
        return response();
      },
    });
    expect(await load(repository())).toEqual({ display: null, maxAge: 300 });
    clock = 299_000;
    expect(await load(repository())).toEqual({ display: null, maxAge: 1 });
    expect(calls).toBe(1);
    clock = 300_000;
    await load(repository());
    expect(calls).toBe(2);
  });

  test("keeps a valid name when the logo is unsafe", async () => {
    const load = createRepositoryBrandingLoader({
      fetchFile: async () => manifest({ name: "My app", logo: "../logo.svg" }),
    });
    expect((await load(repository())).display).toEqual({ name: "My app" });
  });

  test.each([true, false])(
    "cancels oversized manifests (declared length: %s)",
    async (declared) => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const load = createRepositoryBrandingLoader({
        fetchFile: async () =>
          new Response(stream, {
            headers: declared ? { "Content-Length": String(65 * 1024) } : {},
          }),
      });
      expect((await load(repository())).display).toBeNull();
      expect(cancelled).toBe(true);
    },
  );

  test("caps concurrent upstream requests and still shares an existing request", async () => {
    const releases: Array<(value: Response) => void> = [];
    const load = createRepositoryBrandingLoader({
      fetchFile: () => new Promise((resolve) => releases.push(resolve)),
    });
    const pending = Array.from({ length: 8 }, (_, i) => load(repository(`owner/app${i}`)));
    const duplicate = load(repository("owner/app0"));
    expect(await load(repository("owner/overflow"))).toEqual({ display: null, maxAge: 60 });
    expect(releases).toHaveLength(8);
    releases.forEach((release) => release(manifest()));
    await Promise.all([...pending, duplicate]);
  });

  test("bounds cache growth while retaining frequently read entries", async () => {
    const calls: string[] = [];
    const load = createRepositoryBrandingLoader({
      fetchFile: async (url) => {
        calls.push(url);
        return manifest();
      },
    });
    for (let i = 0; i < 256; i++) await load(repository(`owner/app${i}`));
    await load(repository("owner/app0"));
    await load(repository("owner/app256"));
    await load(repository("owner/app0"));
    expect(calls).toHaveLength(257);
    await load(repository("owner/app1"));
    expect(calls).toHaveLength(258);
  });

  test("backs off across repositories when GitHub rate limits the reader", async () => {
    let calls = 0,
      clock = 0;
    const load = createRepositoryBrandingLoader({
      now: () => clock,
      fetchFile: async () => {
        calls++;
        return calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
          : manifest();
      },
    });
    await load(repository());
    expect(await load(repository("owner/other"))).toEqual({ display: null, maxAge: 60 });
    expect(calls).toBe(1);
    clock = 120_000;
    expect((await load(repository("owner/other"))).display?.name).toBe("My app");
    expect(calls).toBe(2);
  });
});

describe("public branding route", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  test("rejects malformed or ambiguous references before making any network request", async () => {
    fetchSpy = spyOn(globalThis, "fetch");
    const valid = deploySourceParams(repository()).toString();
    for (const query of [
      "",
      "repo=bad",
      "repo=https://127.0.0.1/repo",
      `${valid}&repo=bad`,
      `${valid}&branch=main&branch=other`,
      `${valid}&app=n8n`,
      `${valid}&branch=../main`,
    ]) {
      const response = await GET(new Request(`https://openship.io/api/deploy/branding?${query}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns only public metadata, uses public caching and never forwards incoming credentials", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(manifest());
    const query = deploySourceParams(repository("owner/route-test"));
    const response = await GET(
      new Request(`https://openship.io/api/deploy/branding?${query}`, {
        headers: { Authorization: "Bearer do-not-forward", Cookie: "session=do-not-forward" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(
      /^public, max-age=300, s-maxage=1[78]\d\d$/,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      display: {
        name: "My app",
        logoUrl: "https://raw.githubusercontent.com/owner/route-test/HEAD/public/logo.svg",
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ Accept: "application/json" });
  });
});
