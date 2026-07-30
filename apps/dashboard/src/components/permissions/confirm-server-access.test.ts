import { describe, it, expect } from "vitest";
import { serversNewlyGranted, hasNewServerGrant } from "./confirm-server-access";
import type { PickerGrant } from "@/lib/api";

const server = (id: string): PickerGrant => ({ resourceType: "server", resourceId: id, permissions: ["read"] });
const project = (id: string): PickerGrant => ({ resourceType: "project", resourceId: id, permissions: ["read"] });

describe("serversNewlyGranted", () => {
  it("flags a newly added specific server grant", () => {
    const d = serversNewlyGranted([], [server("srv_1")]);
    expect(d).toEqual({ wildcard: false, ids: ["srv_1"] });
    expect(hasNewServerGrant(d)).toBe(true);
  });

  it("flags a newly added wildcard (all servers) grant", () => {
    const d = serversNewlyGranted([project("p1")], [project("p1"), server("*")]);
    expect(d).toEqual({ wildcard: true, ids: [] });
    expect(hasNewServerGrant(d)).toBe(true);
  });

  it("does NOT flag a pre-existing server grant re-saved unchanged", () => {
    const prev = [server("srv_1")];
    const next = [server("srv_1"), project("p1")];
    const d = serversNewlyGranted(prev, next);
    expect(hasNewServerGrant(d)).toBe(false);
  });

  it("does NOT flag when only non-server grants change", () => {
    const d = serversNewlyGranted([server("srv_1")], [server("srv_1"), project("p2")]);
    expect(hasNewServerGrant(d)).toBe(false);
  });

  it("ignores server entries whose permissions were cleared (a revoke, not a grant)", () => {
    const next: PickerGrant[] = [{ resourceType: "server", resourceId: "srv_9", permissions: [] }];
    const d = serversNewlyGranted([], next);
    expect(hasNewServerGrant(d)).toBe(false);
  });

  it("reports multiple new specific servers", () => {
    const d = serversNewlyGranted([server("srv_1")], [server("srv_1"), server("srv_2"), server("srv_3")]);
    expect(d.ids.sort()).toEqual(["srv_2", "srv_3"]);
  });
});
