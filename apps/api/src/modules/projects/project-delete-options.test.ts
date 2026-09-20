import { describe, expect, it } from "vitest";
import { AppError } from "@repo/core";
import { parseProjectDeleteOptions } from "./project-delete-options";

describe("parseProjectDeleteOptions", () => {
  it("accepts compatible flags as JSON booleans", () => {
    expect(
      parseProjectDeleteOptions(
        {},
        { force: true, forceOrphan: false, wipeVolumes: true, recordOnly: false },
      ),
    ).toEqual({ force: true, forceOrphan: false, wipeVolumes: true, recordOnly: false });
  });

  it("accepts query booleans and lets an explicit query value win over the body", () => {
    expect(
      parseProjectDeleteOptions(
        { force: "false", forceOrphan: "false", wipeVolumes: "true", recordOnly: "false" },
        { force: true, forceOrphan: true, wipeVolumes: false, recordOnly: true },
      ),
    ).toEqual({ force: false, forceOrphan: false, wipeVolumes: true, recordOnly: false });
  });

  it("makes forceOrphan imply force for body and query clients", () => {
    expect(parseProjectDeleteOptions({}, { force: false, forceOrphan: true })).toMatchObject({
      force: true,
      forceOrphan: true,
    });
    expect(
      parseProjectDeleteOptions({ force: "false", forceOrphan: "true" }, undefined),
    ).toMatchObject({ force: true, forceOrphan: true });
  });

  it("accepts the legacy orphan spelling used by older API clients", () => {
    expect(parseProjectDeleteOptions({}, { orphan: true })).toMatchObject({
      force: true,
      forceOrphan: true,
    });
    expect(parseProjectDeleteOptions({ orphan: "true" }, undefined)).toMatchObject({
      force: true,
      forceOrphan: true,
    });
  });

  it("defaults an absent optional body and all flags to false", () => {
    expect(parseProjectDeleteOptions({}, undefined)).toEqual({
      force: false,
      forceOrphan: false,
      wipeVolumes: false,
      recordOnly: false,
    });
  });

  it.each([{ wipeVolumes: true }, { forceOrphan: true }])(
    "rejects record-only with destructive/deferred cleanup flags",
    (flags) => {
      expect(() => parseProjectDeleteOptions({}, { recordOnly: true, ...flags })).toThrow(
        /recordOnly cannot be combined/i,
      );
    },
  );

  it.each([
    [{ force: "1" }, undefined, "force query parameter"],
    [{}, { forceOrphan: "true" }, "forceOrphan in the request body"],
    [{}, [], "JSON object"],
  ] as const)("rejects invalid boolean input", (query, body, message) => {
    let thrown: unknown;
    try {
      parseProjectDeleteOptions(query, body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ statusCode: 400, code: "INVALID_DELETE_OPTIONS" });
    expect((thrown as Error).message).toContain(message);
  });
});
