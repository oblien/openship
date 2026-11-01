import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { CreateServiceBody, UpdateServiceBody } from "@repo/contracts";
import {
  assertValidGeneratedConfigFiles,
  MAX_GENERATED_CONFIG_FILES,
  MAX_GENERATED_CONFIG_FILE_BYTES,
} from "@repo/platform/engine/lib/generated-config-files";

const files = [
  { path: "/etc/kong/kong.yml", content: "_format_version: '3.0'\n" },
  { path: "/docker-entrypoint-initdb.d/init.sql", content: "SELECT 1;\n" },
];

describe("service advanced.files schema", () => {
  it("accepts generated config files on both create and update", () => {
    expect(Value.Check(CreateServiceBody, { name: "gateway", advanced: { files } })).toBe(true);
    expect(Value.Check(UpdateServiceBody, { advanced: { files } })).toBe(true);
  });

  it("accepts null on update/create so mergeAdvanced can remove the key", () => {
    expect(Value.Check(CreateServiceBody, { name: "gateway", advanced: { files: null } })).toBe(
      true,
    );
    expect(Value.Check(UpdateServiceBody, { advanced: { files: null } })).toBe(true);
  });

  it("rejects malformed file entries instead of persisting unusable host mounts", () => {
    expect(Value.Check(UpdateServiceBody, { advanced: { files: [{ path: "/x" }] } })).toBe(false);
    expect(
      Value.Check(UpdateServiceBody, {
        advanced: { files: [{ path: "/x", content: "ok", unexpected: true }] },
      }),
    ).toBe(false);
  });

  it.each(["relative.yml", "/etc/../root.yml", "/etc/app.yml:rw", "/etc/app.yml\nnext"])(
    "rejects unsafe container target %j",
    (path) => {
      const body = { advanced: { files: [{ path, content: "ok" }] } };
      if (path.includes("..")) {
        expect(() => assertValidGeneratedConfigFiles(body.advanced.files)).toThrow(
          /generated-config-path-invalid/,
        );
      } else {
        expect(Value.Check(UpdateServiceBody, body)).toBe(false);
      }
    },
  );

  it("rejects duplicate and overlapping mount targets", () => {
    expect(() =>
      assertValidGeneratedConfigFiles([
        { path: "/etc/app", content: "one" },
        { path: "/etc/app/config.yml", content: "two" },
      ]),
    ).toThrow(/generated-config-path-conflict/);
    expect(() =>
      assertValidGeneratedConfigFiles([
        { path: "/etc/app.yml", content: "one" },
        { path: "/etc/app.yml", content: "two" },
      ]),
    ).toThrow(/generated-config-path-conflict/);
  });

  it("bounds file count, individual content, and aggregate content", () => {
    expect(
      Value.Check(UpdateServiceBody, {
        advanced: {
          files: Array.from({ length: MAX_GENERATED_CONFIG_FILES + 1 }, (_, i) => ({
            path: `/etc/${i}`,
            content: "",
          })),
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(UpdateServiceBody, {
        advanced: {
          files: [{ path: "/etc/huge", content: "x".repeat(MAX_GENERATED_CONFIG_FILE_BYTES + 1) }],
        },
      }),
    ).toBe(false);
    expect(() =>
      assertValidGeneratedConfigFiles(
        Array.from({ length: 5 }, (_, i) => ({
          path: `/etc/chunk-${i}`,
          content: "x".repeat(MAX_GENERATED_CONFIG_FILE_BYTES),
        })),
      ),
    ).toThrow(/generated-config-files-too-large/);
  });
});
