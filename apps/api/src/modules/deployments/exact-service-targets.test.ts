import { describe, expect, it } from "vitest";
import { assertExactServiceTargets, type ExactServiceTargetRow } from "@repo/platform/engine/modules/deployments/exact-service-targets";

const services: ExactServiceTargetRow[] = [
  { id: "svc-vpn", name: "vpn", enabled: true, advanced: null },
  {
    id: "svc-sidecar",
    name: "sidecar",
    enabled: true,
    advanced: { networkMode: "service:vpn" },
  },
  { id: "svc-disabled", name: "disabled", enabled: false, advanced: null },
];

describe("exact service deployment targets", () => {
  it("accepts enabled project services", () => {
    expect(() => assertExactServiceTargets(services, ["svc-sidecar"])).not.toThrow();
  });

  it("rejects missing and disabled targets", () => {
    expect(() => assertExactServiceTargets(services, ["svc-disabled"])).toThrow(/disabled/);
    expect(() => assertExactServiceTargets(services, ["svc-foreign"])).toThrow(/cross-project/);
  });

  it("rejects a namespace provider without its dependent", () => {
    expect(() => assertExactServiceTargets(services, ["svc-vpn"])).toThrow(/svc-sidecar/);
  });

  it("accepts a namespace provider and dependent together", () => {
    expect(() => assertExactServiceTargets(services, ["svc-vpn", "svc-sidecar"])).not.toThrow();
  });

  it("rejects a selected dependent whose namespace provider is absent or disabled", () => {
    expect(() =>
      assertExactServiceTargets(
        [
          ...services,
          {
            id: "svc-missing-client",
            name: "missing-client",
            enabled: true,
            advanced: { networkMode: "service:not-here" },
          },
        ],
        ["svc-missing-client"],
      ),
    ).toThrow(/missing or disabled.*not-here/);
    expect(() =>
      assertExactServiceTargets(
        [
          ...services,
          {
            id: "svc-disabled-client",
            name: "disabled-client",
            enabled: true,
            advanced: { pidMode: "service:disabled" },
          },
        ],
        ["svc-disabled-client"],
      ),
    ).toThrow(/missing or disabled.*disabled/);
  });

  it("rejects self-references and malformed namespace modes before activation", () => {
    expect(() =>
      assertExactServiceTargets(
        [
          ...services,
          {
            id: "svc-self",
            name: "self",
            enabled: true,
            advanced: { networkMode: "service:self" },
          },
        ],
        ["svc-self"],
      ),
    ).toThrow(/refers to itself/);
    expect(() =>
      assertExactServiceTargets(
        [
          ...services,
          {
            id: "svc-host",
            name: "host-mode",
            enabled: true,
            advanced: { networkMode: "host" },
          },
        ],
        ["svc-host"],
      ),
    ).toThrow(/invalid.*host is not supported/);
  });

  it("rejects namespace cycles before any selected service can activate", () => {
    expect(() =>
      assertExactServiceTargets(
        [
          {
            id: "svc-api",
            name: "api",
            enabled: true,
            advanced: { networkMode: "service:worker" },
          },
          {
            id: "svc-worker",
            name: "worker",
            enabled: true,
            advanced: { pidMode: "service:api" },
          },
          { id: "svc-unrelated", name: "unrelated", enabled: true, advanced: null },
        ],
        ["svc-unrelated", "svc-api", "svc-worker"],
      ),
    ).toThrow(/namespace cycle: api -> worker -> api/);
  });
});
