/**
 * #533: deploy ORDER and reference resolution for shared namespaces.
 *
 * `network_mode: service:gluetun` is not a preference, it is a precondition —
 * Docker resolves `container:<id>` at create time, so the provider has to exist
 * first. That makes it a dependency in every sense `depends_on` already is, which
 * is why both feed one list: the topological sort visits providers first, and the
 * "dependency didn't come up" guard holds dependents back when one failed.
 *
 * Resolution happens in the API rather than the runtime because only the deploy
 * loop knows which siblings actually came up in THIS deployment. A reference that
 * can't be satisfied has to fail its own service with a legible reason, not reach
 * the daemon as an unresolvable id.
 */

import type { Service } from "@repo/db";
import { describe, expect, it } from "vitest";

import {
  effectiveDependencies,
  resolveServiceNamespaces,
  topoSort,
} from "../../../src/modules/deployments/compose/deploy.service";

const svc = (over: Partial<Service> & { name: string }) =>
  ({ dependsOn: [], advanced: {}, ...over }) as Service;

describe("topoSort", () => {
  const order = (services: Service[]) => topoSort(services).map((s) => s.name);

  it("puts a namespace provider before its dependent, with no depends_on declared", () => {
    // The ordering guarantee the whole resolution rests on: by the time the
    // dependent is created, the provider has a container id.
    expect(
      order([
        svc({ name: "qbit", advanced: { networkMode: "service:gluetun" } }),
        svc({ name: "gluetun" }),
      ]),
    ).toEqual(["gluetun", "qbit"]);
  });

  it("orders a chain of namespace providers", () => {
    expect(
      order([
        svc({ name: "c", advanced: { networkMode: "service:b" } }),
        svc({ name: "b", advanced: { networkMode: "service:a" } }),
        svc({ name: "a" }),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("emits every service EXACTLY once when references form a cycle", () => {
    // The cycle break used to push the node and then let its own frame push it
    // again, so `ordered` carried a duplicate and the deploy loop ran that service
    // twice — the second pass violating UNIQUE(deploymentId, serviceId). No order
    // satisfies a cycle; appearing once is the part that must hold.
    const cyclic = [
      svc({ name: "a", advanced: { networkMode: "service:b" } }),
      svc({ name: "b", advanced: { networkMode: "service:a" } }),
    ];
    const names = order(cyclic);
    expect(names).toHaveLength(2);
    expect(new Set(names)).toEqual(new Set(["a", "b"]));
  });

  it("emits every service exactly once for a depends_on cycle too", () => {
    const names = order([
      svc({ name: "x", dependsOn: ["y"] }),
      svc({ name: "y", dependsOn: ["z"] }),
      svc({ name: "z", dependsOn: ["x"] }),
    ]);
    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(["x", "y", "z"]));
  });

  it("ignores a reference to a service that isn't in the list", () => {
    expect(order([svc({ name: "solo", advanced: { networkMode: "service:absent" } })])).toEqual([
      "solo",
    ]);
  });
});

describe("effectiveDependencies", () => {
  it("passes through declared depends_on untouched", () => {
    expect(effectiveDependencies(svc({ name: "app", dependsOn: ["db", "cache"] }))).toEqual([
      "db",
      "cache",
    ]);
  });

  it("adds the namespace provider, so the sort places it first", () => {
    expect(
      effectiveDependencies(svc({ name: "qbit", advanced: { networkMode: "service:gluetun" } })),
    ).toEqual(["gluetun"]);
  });

  it("does not duplicate a provider already declared in depends_on", () => {
    expect(
      effectiveDependencies(
        svc({ name: "qbit", dependsOn: ["gluetun"], advanced: { networkMode: "service:gluetun" } }),
      ),
    ).toEqual(["gluetun"]);
  });

  it("counts network and pid providers once each", () => {
    expect(
      effectiveDependencies(
        svc({
          name: "probe",
          advanced: { networkMode: "service:vpn", pidMode: "service:app" },
        }),
      ),
    ).toEqual(["vpn", "app"]);
  });

  it("adds nothing for container:, none, or an empty blob", () => {
    expect(
      effectiveDependencies(svc({ name: "a", advanced: { networkMode: "container:abc" } })),
    ).toEqual([]);
    expect(effectiveDependencies(svc({ name: "a", advanced: { networkMode: "none" } }))).toEqual([]);
    expect(effectiveDependencies(svc({ name: "a" }))).toEqual([]);
  });
});

describe("resolveServiceNamespaces", () => {
  const stack = new Set(["gluetun", "qbit", "app"]);

  it("resolves a sibling reference to that sibling's live container id", () => {
    // The id, not the name: a name would be re-resolved by the daemon later, after
    // we have stopped watching.
    const running = new Map([["gluetun", "cid-gluetun"]]);
    expect(
      resolveServiceNamespaces(
        svc({ name: "qbit", advanced: { networkMode: "service:gluetun" } }),
        running,
        stack,
      ),
    ).toEqual({ namespaces: { network: "container:cid-gluetun" } });
  });

  it("resolves network and pid independently", () => {
    const running = new Map([
      ["gluetun", "cid-vpn"],
      ["app", "cid-app"],
    ]);
    expect(
      resolveServiceNamespaces(
        svc({ name: "qbit", advanced: { networkMode: "service:gluetun", pidMode: "service:app" } }),
        running,
        stack,
      ),
    ).toEqual({ namespaces: { network: "container:cid-vpn", pid: "container:cid-app" } });
  });

  it("passes container: and none straight through", () => {
    expect(
      resolveServiceNamespaces(
        svc({ name: "qbit", advanced: { networkMode: "container:deadbeef" } }),
        new Map(),
        stack,
      ),
    ).toEqual({ namespaces: { network: "container:deadbeef" } });
    expect(
      resolveServiceNamespaces(
        svc({ name: "qbit", advanced: { networkMode: "none" } }),
        new Map(),
        stack,
      ),
    ).toEqual({ namespaces: { network: "none" } });
  });

  it("refuses a reference to a service outside this stack", () => {
    // The validation the issue asks for. Left unchecked this reaches Docker as an
    // unresolvable container id and fails with a daemon-level message instead.
    const result = resolveServiceNamespaces(
      svc({ name: "qbit", advanced: { networkMode: "service:someone-elses-vpn" } }),
      new Map([["someone-elses-vpn", "cid-foreign"]]),
      stack,
    );
    expect(result.namespaces).toBeUndefined();
    expect(result.error).toContain("not a service in this stack");
  });

  it("refuses a self-reference", () => {
    const result = resolveServiceNamespaces(
      svc({ name: "qbit", advanced: { pidMode: "service:qbit" } }),
      new Map([["qbit", "cid-self"]]),
      stack,
    );
    expect(result.error).toContain("refers to itself");
  });

  it("refuses when the provider is in the stack but has no running container", () => {
    // The provider failed, or hasn't been reached. Either way there is no namespace
    // to join, and starting anyway would put the container on its own network —
    // the exact silent wrong this issue is about.
    const result = resolveServiceNamespaces(
      svc({ name: "qbit", advanced: { networkMode: "service:gluetun" } }),
      new Map(),
      stack,
    );
    expect(result.namespaces).toBeUndefined();
    expect(result.error).toContain("no running container");
  });

  it("returns nothing to apply for a service that shares nothing", () => {
    expect(resolveServiceNamespaces(svc({ name: "app" }), new Map(), stack)).toEqual({});
  });

  it("ignores a stored value that is not a supported mode", () => {
    // `host` can't be stored by the parser, but a hand-written row must not
    // smuggle it past the refusal either.
    expect(
      resolveServiceNamespaces(
        svc({ name: "app", advanced: { networkMode: "host" } }),
        new Map(),
        stack,
      ),
    ).toEqual({});
  });
});
