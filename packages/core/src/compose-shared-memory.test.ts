import { describe, expect, it } from "vitest";
import { parseComposeShmSize, readComposeShmConfig } from "./compose-shared-memory";

describe("container shared memory", () => {
  it("normalizes Compose units and byte counts without enabling host IPC", () => {
    expect(parseComposeShmSize("2g")).toBe(2147483648);
    expect(parseComposeShmSize("512mb")).toBe(536870912);
    expect(parseComposeShmSize(2147483648)).toBe(2147483648);
    expect(readComposeShmConfig("${SHM}", () => "2g").config).toEqual({ shmSize: 2147483648 });
    expect(readComposeShmConfig(undefined).config).toEqual({});
  });
  it.each([0, -1, 1.5, "garbage", "2.2b", "2t", {}, Infinity])(
    "rejects invalid or oversized allocation %j",
    (value) => {
      expect(() => parseComposeShmSize(value)).toThrow();
      expect(readComposeShmConfig(value)).toMatchObject({
        issues: [{ field: "shm_size", blocking: true }],
      });
    },
  );
});
