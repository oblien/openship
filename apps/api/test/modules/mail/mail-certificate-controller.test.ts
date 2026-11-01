import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cloud: false,
  inOrg: true,
  assert: vi.fn(),
  get: vi.fn(),
  renew: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: h.assert } }));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-1" }),
}));
vi.mock("../../../src/lib/controller-helpers", () => ({
  assertNotCloud: (c: any) => (h.cloud ? c.json({ error: "Not available" }, 404) : undefined),
  isServerInOrg: async () => h.inOrg,
  param: (c: any, name: string) => c.req.param(name),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-certificate.service", () => ({
  getMailCertificateStatus: h.get,
  renewMailCertificate: h.renew,
  setMailCertificateAutoRenew: h.update,
}));
import {
  getCertificate,
  checkCertificate,
  renewCertificate,
  updateCertificate,
} from "../../../src/modules/mail/admin/certificate.controller";

const context = (body: unknown = { autoRenew: false }) =>
  ({
    req: { param: () => "srv-mail", json: async () => body },
    json: (data: unknown, status = 200) => ({ data, status }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.inOrg = true;
  h.assert.mockResolvedValue(undefined);
});

describe("mail certificate HTTP authorization", () => {
  it.each([getCertificate, checkCertificate, renewCertificate, updateCertificate])(
    "excludes cloud and other organizations before any remote operation",
    async (handler) => {
      h.cloud = true;
      expect(await handler(context())).toMatchObject({ status: 404 });
      expect(h.assert).not.toHaveBeenCalled();
      h.cloud = false;
      h.inOrg = false;
      expect(await handler(context())).toMatchObject({ status: 404 });
      expect(h.get).not.toHaveBeenCalled();
      expect(h.renew).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    },
  );

  it("requires mail administrator access for renewal and the preference", async () => {
    h.assert.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(renewCertificate(context())).rejects.toThrow("Forbidden");
    expect(h.renew).not.toHaveBeenCalled();
    await updateCertificate(context());
    expect(h.assert).toHaveBeenLastCalledWith(expect.anything(), {
      resourceType: "mail_server",
      resourceId: "srv-mail",
      action: "admin",
    });
    expect(h.update).toHaveBeenCalledWith("srv-mail", false);
  });

  it("never coerces a string false into enabled renewal", async () => {
    expect(await updateCertificate(context({ autoRenew: "false" }))).toMatchObject({ status: 400 });
    expect(h.update).not.toHaveBeenCalled();
  });
});
