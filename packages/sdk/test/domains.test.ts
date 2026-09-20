import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { domainFixture, dnsCredentialFixture } from "../../contracts/test/fixtures";

describe("domain and DNS remote transport", () => {
  it("adapts project-scoped creation without dropping sibling or edge recovery information", async () => {
    const domain = domainFixture("domain/a", "project/a");
    const details = { records: { mode: "external", records: [] }, www: { id: "www", hostname: "www.example.com" }, wwwError: "a sibling diagnostic", preexistingEdgeSite: { hostname: domain.hostname, hostnames: [domain.hostname], kind: "static", target: "/old", ssl: true } };
    const fetcher = vi.fn(async () => Response.json({ data: domain, ...details }, { status: 201 }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    expect(await client.domains.create("project/a", { hostname: domain.hostname, includeWww: true })).toEqual({ domain, ...details });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://ship.test/api/domains");
    expect(JSON.parse(init.body as string)).toMatchObject({ projectId: "project/a", hostname: domain.hostname, includeWww: true });
  });
  it("returns valid failed-verification results while preserving authentication and validation errors", async () => {
    const body = { verified: false, cnameVerified: false, txtVerified: true, message: "DNS is still propagating" };
    const fetcher = vi.fn(async () => Response.json(body, { status: 422 }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    expect(await client.domains.verify("domain/a", { force: true })).toEqual(body);
    expect(fetcher.mock.calls[0]).toMatchObject(["https://ship.test/api/domains/domain%2Fa/verify?force=true", { method: "POST" }]);
    fetcher.mockImplementation(async () => Response.json({ error: "Invalid body", code: "VALIDATION_ERROR" }, { status: 422 }));
    await expect(client.domains.verify("domain/a")).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    fetcher.mockImplementation(async () => Response.json({ error: "Login required" }, { status: 401 }));
    await expect(client.domains.verify("domain/a")).rejects.toMatchObject({ status: 401 });
  });
  it("keeps DNS target selection in the bodyless apply query and masks credential responses", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/dns/apply")) {
        expect(String(url)).toBe("https://ship.test/api/domains/domain%2Fa/dns/apply?serverId=server%2Fa");
        expect(init?.body).toBeUndefined();
        return Response.json({ data: { provisioned: true, records: [] } });
      }
      expect(String(url)).toBe("https://ship.test/api/dns/credentials/dns%2Fa");
      expect(init?.body).toBeUndefined();
      return Response.json({ data: dnsCredentialFixture("dns/a") });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await client.domains.dnsApply("domain/a", { serverId: "server/a" });
    expect(await client.dns.getCredential("dns/a")).toEqual(dnsCredentialFixture("dns/a"));
  });
  it("validates singleton input before sending and rejects credential leaks in remote responses", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { ...dnsCredentialFixture(), apiToken: "secret" } }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(client.domains.verifyPending({ limit: 1001 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.dns.verifyZone({ hostname: "../../etc/passwd" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.dns.getCredential("dns-a")).rejects.toMatchObject({ status: 502 });
  });
  it("streams terminal verification events and accepts cancellation", async () => {
    const fetcher = vi.fn(async () => new Response('event: session\ndata: {"type":"session"}\n\nevent: complete\ndata: {"type":"complete","status":"completed"}\n\n'));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const events = [];
    for await (const event of client.domains.verifyStream("domain/a", { force: true })) events.push(event.event);
    expect(events).toEqual(["session", "complete"]);
    const abort = new AbortController();
    abort.abort();
    const iterator = client.domains.verifyStream("domain/a", {}, { signal: abort.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
