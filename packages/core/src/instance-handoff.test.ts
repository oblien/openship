import { describe, expect, it } from "vitest";
import {
  handoffInstance,
  instanceOrigin,
  type HandoffManifest,
  type HandoffSource,
  type HandoffTarget,
} from "./instance-handoff";

describe("instance handoff", () => {
  it("never activates the receiver before the source durably retires", async () => {
    const events: string[] = [];
    let retired = false;
    const manifest = { totalChunks: 2 } as HandoffManifest;
    const connection = {
      origin: "https://ops.example.com",
      installationId: "target",
      cookies: { "openship.session_token": "device" },
    };
    const source: HandoffSource = {
      async freeze() {
        events.push("freeze");
        return manifest;
      },
      async chunk(index) {
        return Uint8Array.of(index);
      },
      async retire(value) {
        expect(value).toBe(manifest);
        events.push("retire");
        retired = true;
        return "proof";
      },
      async complete(value) {
        expect(value).toBe(connection);
        events.push("complete");
      },
    };
    const target: HandoffTarget = {
      async stage() {
        events.push("stage");
      },
      async chunk(index, bytes) {
        expect(bytes[0]).toBe(index);
        events.push(`chunk:${index}`);
      },
      async prepare() {
        expect(retired).toBe(false);
        events.push("verify");
      },
      async activate(proof) {
        expect(retired).toBe(true);
        expect(proof).toBe("proof");
        events.push("activate");
        return connection;
      },
    };
    expect(await handoffInstance(source, target)).toBe(connection);
    expect(events).toEqual([
      "freeze",
      "stage",
      "chunk:0",
      "chunk:1",
      "verify",
      "retire",
      "activate",
      "complete",
    ]);
  });

  it("leaves the source retired when the activation reply is lost", async () => {
    let retired = false,
      activated = false;
    const source: HandoffSource = {
      freeze: async () => ({ totalChunks: 0 }) as HandoffManifest,
      chunk: async () => new Uint8Array(),
      retire: async () => {
        retired = true;
        return "proof";
      },
      complete: async () => {
        throw new Error("must not run");
      },
    };
    const target: HandoffTarget = {
      stage: async () => {},
      chunk: async () => {},
      prepare: async () => {},
      activate: async () => {
        activated = true;
        throw new Error("connection lost after commit");
      },
    };
    await expect(handoffInstance(source, target)).rejects.toThrow("connection lost");
    expect({ retired, activated }).toEqual({ retired: true, activated: true });
  });

  it.each([
    "http://ops.example.com",
    "https://user:pass@ops.example.com",
    "https://ops.example.com/?token=x",
    "https://ops.example.com/arbitrary",
    "file:///tmp/database",
  ])("refuses an unsafe endpoint: %s", (endpoint) => {
    expect(() => instanceOrigin(endpoint)).toThrow();
  });
  it("accepts the shared dashboard proxy and a loopback test receiver", () => {
    expect(instanceOrigin("https://ops.example.com/api/proxy/")).toBe(
      "https://ops.example.com/api/proxy",
    );
    expect(instanceOrigin("http://127.0.0.1:49100")).toBe("http://127.0.0.1:49100");
  });
});
