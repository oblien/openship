import { describe, it, expect } from "vitest";
import { composeMountToSpec, composePortToSpec } from "./compose-spec";

describe("composeMountToSpec", () => {
  it("keeps read-only intent — the whole reason this is shared", () => {
    // `docker compose config` always emits long form, so the CLI sync mapper that
    // spelled this itself lost EVERY `:ro` in every synced file, bind-mounting a
    // host directory writable that the author had marked read-only (#533).
    expect(
      composeMountToSpec({
        type: "bind",
        source: "/host/config",
        target: "/etc/nginx/conf.d",
        read_only: true,
      }),
    ).toBe("/host/config:/etc/nginx/conf.d:ro");
  });

  it("read_only wins over the other flags", () => {
    // Downstream MODE_SUFFIX matches one flag, and of the wrong answers available,
    // granting write access is the worst one.
    expect(
      composeMountToSpec({
        source: "data",
        target: "/data",
        read_only: true,
        bind: { selinux: "Z" },
        volume: { nocopy: true },
      }),
    ).toBe("data:/data:ro");
  });

  it("folds selinux and nocopy", () => {
    expect(composeMountToSpec({ source: "/d", target: "/data", bind: { selinux: "Z" } })).toBe(
      "/d:/data:Z",
    );
    expect(composeMountToSpec({ source: "/d", target: "/data", bind: { selinux: "z" } })).toBe(
      "/d:/data:z",
    );
    expect(composeMountToSpec({ source: "c", target: "/c", volume: { nocopy: true } })).toBe(
      "c:/c:nocopy",
    );
  });

  it("accepts `name` as the source alias, and a target-only anonymous volume", () => {
    expect(composeMountToSpec({ name: "vol", target: "/v" })).toBe("vol:/v");
    expect(composeMountToSpec({ target: "/scratch" })).toBe("/scratch");
  });

  it("does NOT put a mode on an anonymous volume — Docker rejects that outright", () => {
    // `Binds` parses two segments as source:target and errors when the second is a
    // mode word, so `/scratch:ro` fails the container create rather than mounting
    // anything read-only. The parser reports the dropped flag separately.
    expect(composeMountToSpec({ target: "/scratch", read_only: true })).toBe("/scratch");
  });

  it("returns undefined when there is no mount to fold", () => {
    expect(composeMountToSpec({})).toBeUndefined();
    expect(composeMountToSpec({ source: "orphan" })).toBeUndefined();
  });
});

describe("composePortToSpec", () => {
  it("keeps the bound interface — dropping host_ip changes what was asked for", () => {
    // `127.0.0.1:8080:80` is a loopback-only publish; the bare `8080:80` the CLI
    // degraded it to means something else entirely.
    expect(
      composePortToSpec({ target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }),
    ).toBe("127.0.0.1:8080:80");
  });

  it("folds a non-tcp protocol into the /proto suffix and leaves tcp bare", () => {
    expect(composePortToSpec({ target: 53, published: "53", protocol: "udp" })).toBe("53:53/udp");
    expect(composePortToSpec({ target: 80, published: "80", protocol: "tcp" })).toBe("80:80");
  });

  it("handles an unpublished container port, with and without a pinned interface", () => {
    expect(composePortToSpec({ target: 3000 })).toBe("3000");
    expect(composePortToSpec({ target: 3000, host_ip: "127.0.0.1" })).toBe("127.0.0.1::3000");
    expect(composePortToSpec({ target: 3000, published: "" })).toBe("3000");
  });

  it("accepts the container_port / host_port aliases", () => {
    expect(composePortToSpec({ container_port: 80, host_port: "8080" })).toBe("8080:80");
  });

  it("returns undefined when there is no container port", () => {
    expect(composePortToSpec({})).toBeUndefined();
    expect(composePortToSpec({ published: "8080" })).toBeUndefined();
  });

  it("interpolates host_ip when the caller supplies a resolver", () => {
    expect(
      composePortToSpec({ target: 80, published: "80", host_ip: "${BIND_IP}" }, () => "10.0.0.5"),
    ).toBe("10.0.0.5:80:80");
  });
});
