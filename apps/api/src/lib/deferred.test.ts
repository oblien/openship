import { describe, it, expect } from "vitest";
import { deferred } from "./deferred";

/**
 * `assistantAgents`, `assistantAutomations` and `chatApps` are built at import
 * time with the shared `assistant` runtime as their default dependency. Through
 * an import cycle those factories can run before `assistant.service` finishes
 * evaluating, and the bundled API then captured `undefined`: creating an agent
 * failed with a bare 500 ("Cannot read properties of undefined (reading
 * 'native')") and model discovery reported every connection as unreadable.
 *
 * `deferred` must therefore never touch its target when created, only when used.
 */

describe("deferred", () => {
  it("does not resolve the target until a property is read", () => {
    let target: { ping(): string } | undefined;
    const stand = deferred(() => {
      if (!target) throw new Error("resolved too early");
      return target;
    });
    // Created while the "singleton" is still undefined, exactly like the import cycle.
    target = { ping: () => "pong" };
    expect(stand.ping()).toBe("pong");
  });

  it("follows the current target instead of the first one", () => {
    let target = { name: "first" };
    const stand = deferred(() => target);
    expect(stand.name).toBe("first");
    target = { name: "second" };
    expect(stand.name).toBe("second");
  });

  it("binds methods to the resolved target", () => {
    class Runtime {
      private readonly id = "runtime";
      who() {
        return this.id;
      }
    }
    const stand = deferred(() => new Runtime());
    const { who } = stand;
    expect(who()).toBe("runtime");
  });

  it("answers `in` checks from the resolved target", () => {
    const stand = deferred(() => ({ native: () => null }) as Record<string, unknown>);
    expect("native" in stand).toBe(true);
    expect("missing" in stand).toBe(false);
  });
});
