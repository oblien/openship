import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { parseInput, SyncServicesBody, UpdateServiceBody } from "../src";

describe("operation input preservation", () => {
  it("retains explicitly open Compose fields and detaches nested data", () => {
    const input = { services: [{ name: "web", commandArgv: ["sh", "-c", "echo ready"], advanced: { networkMode: "service:vpn", environmentTemplateKeys: [], files: [{ path: "config.json", content: "{}" }] }, futureComposeField: { enabled: true } }] };
    const parsed = parseInput(SyncServicesBody, input);
    expect(parsed).toEqual(input);
    input.services[0]!.advanced.networkMode = "changed";
    expect(parsed.services[0]!.advanced).toMatchObject({ networkMode: "service:vpn" });
  });
  it("retains declared open values inside unions and arrays but strips implicit extra fields", () => {
    const schema = Type.Object({ entries: Type.Array(Type.Union([Type.Null(), Type.Object({ options: Type.Object({}, { additionalProperties: true }) })])) });
    expect(parseInput(schema, { privateOverride: true, entries: [{ privateOverride: true, options: { nested: { keep: [1, 2] } } }] })).toEqual({ entries: [{ options: { nested: { keep: [1, 2] } } }] });
  });
  it("continues to reject mass assignment on strict service mutations", () => {
    expect(() => parseInput(UpdateServiceBody, { projectId: "forged", name: "web" })).toThrow();
    expect(() => parseInput(UpdateServiceBody, { kind: "monorepo" })).toThrow();
  });
});
