import { describe, expect, it } from "vitest";
import { assertValidEnvelope } from "../../src/modules/system/data-transfer/import.service";
import type { DataTransferFile } from "../../src/modules/system/data-transfer/types";

function instance(proxy: unknown): DataTransferFile {
  return {
    kind: "openship-instance-export",
    envelopeVersion: 1,
    dump: {
      formatVersion: 1,
      scope: { kind: "instance" },
      tables: { domain: [{ id: "events", hostname: "events.example.test", proxy }] },
    },
  } as DataTransferFile;
}

describe("whole-instance domain body-cap admission", () => {
  it.each([undefined, null, {}, { clientMaxBodySize: "1m" }, { clientMaxBodySize: "0" }])(
    "retains valid desired state and legacy inheritance %j",
    (proxy) => {
      const file = instance(proxy);
      expect(() => assertValidEnvelope(file)).not.toThrow();
      expect(file.dump.tables.domain![0]!.proxy).toEqual(proxy);
    },
  );

  it.each([
    [],
    "1m",
    { gzip: true },
    { clientMaxBodySize: "1m;return 200" },
    { clientMaxBodySize: "8388608g" },
    { clientMaxBodySize: "1m", proxyReadTimeout: "1s" },
  ])("rejects invalid settings before a whole-instance restore: %j", (proxy) => {
    expect(() => assertValidEnvelope(instance(proxy))).toThrow(/invalid domain proxy settings/);
  });
});
