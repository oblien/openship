import { describe, it, expect } from "vitest";
import { specContainerPort, withLoopbackPublish } from "../../src/lib/loopback-publish";

describe("specContainerPort", () => {
  it("parses every docker port-spec form", () => {
    expect(specContainerPort("3000")).toBe(3000);
    expect(specContainerPort("8080:3000")).toBe(3000);
    expect(specContainerPort("127.0.0.1:8080:80")).toBe(80);
    expect(specContainerPort("3000/udp")).toBe(3000);
    expect(specContainerPort("0.0.0.0:9090:9000/tcp")).toBe(9000);
    expect(specContainerPort("bogus")).toBeNull();
  });
});

describe("withLoopbackPublish", () => {
  it("republishes an existing 0.0.0.0 binding for the routed port on loopback", () => {
    expect(withLoopbackPublish(["3000:3000"], 3000, 20500)).toEqual(["127.0.0.1:20500:3000"]);
  });

  it("adds a loopback binding when the routed port wasn't published (edge-only service)", () => {
    expect(withLoopbackPublish([], 8080, 20600)).toEqual(["127.0.0.1:20600:8080"]);
  });

  it("leaves OTHER (port-only) bindings untouched", () => {
    expect(withLoopbackPublish(["9000:9000", "3000:3000"], 3000, 21000)).toEqual([
      "9000:9000",
      "127.0.0.1:21000:3000",
    ]);
  });

  it("replaces a differently-mapped host port for the routed container port", () => {
    expect(withLoopbackPublish(["8080:3000"], 3000, 21001)).toEqual(["127.0.0.1:21001:3000"]);
  });
});
