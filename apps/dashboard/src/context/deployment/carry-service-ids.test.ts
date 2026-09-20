import { describe, expect, it } from "vitest";
import { carryServiceIds, normalizeComposeService } from "./types";

/**
 * A deployment snapshot carries the compose config but no service-row ids, and hydrating
 * from it REPLACES `config.services`. These pin that the replacement keeps the identity
 * the previous load established — otherwise the env editor loses its reveal source
 * whenever the build page hydrates after the service rows.
 */
const svc = (name: string, serviceId?: string) =>
  normalizeComposeService({ name, ...(serviceId ? { id: serviceId } : {}) });

describe("carryServiceIds", () => {
  it("fills an id the snapshot didn't carry", () => {
    const out = carryServiceIds([svc("postgres")], [svc("postgres", "s1")]);
    expect(out[0].serviceId).toBe("s1");
  });

  it("keeps the incoming id when it already has one", () => {
    // The incoming row is the fresher fact about itself.
    const out = carryServiceIds([svc("postgres", "new")], [svc("postgres", "old")]);
    expect(out[0].serviceId).toBe("new");
  });

  it("matches per service, not positionally", () => {
    // A snapshot can list services in a different order, and compose keys them by name.
    const out = carryServiceIds(
      [svc("web"), svc("postgres")],
      [svc("postgres", "s_pg"), svc("web", "s_web")],
    );
    expect(out.map((s) => [s.name, s.serviceId])).toEqual([
      ["web", "s_web"],
      ["postgres", "s_pg"],
    ]);
  });

  it("leaves a service the previous list never had", () => {
    // A compose file that gained a service since the last load: no row exists for it yet,
    // and inventing one would point the reveal at another service's env.
    const out = carryServiceIds([svc("redis")], [svc("postgres", "s1")]);
    expect(out[0].serviceId).toBeUndefined();
  });

  it("preserves everything else about the incoming row", () => {
    const next = normalizeComposeService({ name: "web", image: "nginx", ports: ["80:80"] });
    const [out] = carryServiceIds([next], [svc("web", "s1")]);
    expect(out).toMatchObject({ image: "nginx", ports: ["80:80"], serviceId: "s1" });
  });

  it("is a no-op with no previous list", () => {
    const next = [svc("web")];
    expect(carryServiceIds(next, undefined)).toBe(next);
    expect(carryServiceIds(next, [])).toBe(next);
    // Nothing to carry: same array back, so no needless re-render downstream.
    expect(carryServiceIds(next, [svc("web")])).toBe(next);
  });
});
