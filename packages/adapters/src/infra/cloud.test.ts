import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Oblien } from "oblien";
import { CloudInfraProvider } from "./cloud";

const hostname = "app.example.com";
const expiry = "2030-01-01T00:00:00.000Z";
let page: Record<string, unknown>;
let routes: ReturnType<typeof vi.fn>;
let pages: Record<string, ReturnType<typeof vi.fn>>;
let provider: CloudInfraProvider;

beforeEach(() => {
  page = { slug: "route-one", domain: "opsh.io", url: `https://${hostname}`, custom_domain: hostname,
    namespace: "ns-one", source_workspace_id: "ws-one", exported_path: "/opt/openship/cloud-docker/routes/route-one" };
  routes = vi.fn(async () => ({ data: [{ hostname, namespace: "ns-one", owner_type: "page", owner_id: "route-one", is_custom: 1 }] }));
  pages = {
    list: vi.fn(async () => ({ pages: [page] })), get: vi.fn(async () => ({ page })),
    getDomain: vi.fn(async () => ({ domain: { customDomain: hostname, sslStatus: "active", sslExpiry: expiry } })),
    renewSSL: vi.fn(), disconnectDomain: vi.fn(), delete: vi.fn(async () => ({ success: true })),
  };
  provider = new CloudInfraProvider({ domain: { routes }, pages } as unknown as Oblien, { namespace: "ns-one", workspaceId: "ws-one", routeRoot: "/opt/openship/cloud-docker/routes", lock: { run: work => work() } });
});

describe("Cloud custom-domain certificates", () => {
  it("reads the flat Page domain response returned by deployed Oblien APIs", async () => {
    await expect(provider.verifyCert(hostname)).resolves.toMatchObject({ domain: hostname, verified: true, expiresAt: expiry });
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });

  it("accepts the SDK's nested SSL response", async () => {
    pages.getDomain.mockResolvedValue({ domain: { domain: hostname, ssl: { status: "active", expiresAt: expiry } } });
    await expect(provider.verifyCert(hostname)).resolves.toMatchObject({ verified: true, expiresAt: expiry });
  });

  it("reports a missing certificate without crashing on an absent SSL object", async () => {
    pages.getDomain.mockResolvedValue({ domain: { customDomain: hostname } });
    await expect(provider.verifyCert(hostname)).resolves.toMatchObject({ verified: false, reason: "missing" });
  });

  it("reuses a valid existing certificate without requesting another one", async () => {
    await expect(provider.provisionCert(hostname)).resolves.toMatchObject({ verified: true });
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });

  it("reads the renewed certificate after a pending first response", async () => {
    pages.getDomain.mockResolvedValueOnce({ domain: { customDomain: hostname, sslStatus: "pending", sslExpiry: null } });
    await expect(provider.provisionCert(hostname)).resolves.toMatchObject({ verified: true, reason: "renewed" });
    expect(pages.renewSSL).toHaveBeenCalledOnce();
    expect(pages.renewSSL).toHaveBeenCalledWith("route-one");
  });

  it.each(["2000-01-01", "not-a-date", null])("does not accept a certificate with invalid expiry %s", async (value) => {
    pages.getDomain.mockResolvedValue({ domain: { customDomain: hostname, sslStatus: "active", sslExpiry: value } });
    await expect(provider.verifyCert(hostname)).resolves.toMatchObject({ verified: false });
  });

  it("returns an actionable, structured error when the domain has no route in the organization", async () => {
    routes.mockResolvedValue({ data: [{ hostname, namespace: "ns-other", owner_type: "page", is_custom: 1 }] });
    await expect(provider.provisionCert(hostname)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_NOT_CONNECTED", statusCode: 409 });
    expect(pages.getDomain).not.toHaveBeenCalled();
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });

  it("pins the registry lookup to the namespace", async () => {
    await provider.verifyCert(hostname);
    expect(routes).toHaveBeenCalledWith({ namespace: "ns-one" });
  });

  it("rejects a Page that changes namespaces after inventory", async () => {
    pages.get.mockResolvedValue({ page: { ...page, namespace: "ns-other" } });
    await expect(provider.renewCert(hostname)).rejects.toThrow(/ownership changed/i);
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });

  it("rejects a changed domain binding before reading or renewing its certificate", async () => {
    pages.getDomain.mockResolvedValue({ domain: { customDomain: "other.example.com", sslStatus: "active", sslExpiry: expiry } });
    await expect(provider.provisionCert(hostname)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_CHANGED", statusCode: 409 });
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });

  it("deletes the owned Page only after checking its current custom-domain binding", async () => {
    await provider.removeRoute(hostname);
    expect(pages.delete).toHaveBeenCalledWith("route-one");
  });

  it("never disconnects a replacement binding", async () => {
    pages.getDomain.mockResolvedValue({ domain: { customDomain: "other.example.com" } });
    await expect(provider.removeRoute(hostname)).rejects.toThrow(/changed/i);
    expect(pages.delete).not.toHaveBeenCalled();
  });

  it("does not use another project's Docker Page for TLS", async () => {
    provider = new CloudInfraProvider({ domain: { routes }, pages } as unknown as Oblien, {
      namespace: "ns-one", workspaceId: "ws-other", routeRoot: "/opt/openship/cloud-docker/routes",
    });
    await expect(provider.renewCert(hostname)).rejects.toMatchObject({ code: "CLOUD_DOMAIN_NOT_CONNECTED" });
    expect(pages.renewSSL).not.toHaveBeenCalled();
  });
});
