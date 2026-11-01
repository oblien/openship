import { describe, expect, it } from "vitest";
import { assertPlausibleBackupSizes } from "@repo/platform/engine/modules/backups/backup-size-check";

const dump = (sizeBytes: number, metadata = {}) => ({
  name: "pg-dump.dump",
  payloadKind: "pg_dump",
  sizeBytes,
  metadata: { postgresDb: "app", format: "custom", compression: "none", ...metadata },
});
const history = (...sizes: number[]) =>
  sizes.map((size, index) => ({ id: `bkr_${index}`, artifacts: [dump(size)] }));

describe("PostgreSQL backup size sanity", () => {
  it("rejects the reported 8 MB dump against 1.26 GB history", () => {
    expect(() =>
      assertPlausibleBackupSizes(
        [dump(8_119_408)],
        history(1_260_000_000, 1_250_000_000, 1_270_000_000),
      ),
    ).toThrow(/below 1%.*1260000000 bytes/);
  });

  it("does not let one earlier truncated success reset the baseline", () => {
    expect(() =>
      assertPlausibleBackupSizes(
        [dump(8_119_408)],
        history(8_119_408, 1_260_000_000, 1_250_000_000),
      ),
    ).toThrow("potentially truncated");
  });

  it("allows normal variation, growth and the conservative threshold", () => {
    for (const size of [12_600_000, 900_000_000, 1_500_000_000]) {
      expect(() => assertPlausibleBackupSizes([dump(size)], history(1_260_000_000))).not.toThrow();
    }
  });

  it("allows a first backup without inventing a minimum database size", () => {
    expect(() => assertPlausibleBackupSizes([dump(1024)], [])).not.toThrow();
  });

  it.each([{ postgresDb: "other" }, { compression: "zstd" }, { format: "plain" }])(
    "does not compare different capture settings: %o",
    (metadata) => {
      expect(() =>
        assertPlausibleBackupSizes([dump(1024, metadata)], history(1_260_000_000)),
      ).not.toThrow();
    },
  );

  it("does not compare other payload kinds or malformed historical artifacts", () => {
    const recent = [
      {
        id: "old",
        artifacts: [
          null,
          "old",
          {},
          { ...dump(1_260_000_000), payloadKind: "volume" },
          dump(0),
          dump(NaN),
        ],
      },
    ];
    expect(() => assertPlausibleBackupSizes([dump(1024)], recent)).not.toThrow();
    expect(() =>
      assertPlausibleBackupSizes(
        [{ ...dump(1024), payloadKind: "volume" }],
        history(1_260_000_000),
      ),
    ).not.toThrow();
  });

  it("uses logical artifact size rather than incremental bytes uploaded", () => {
    const current = dump(1_260_000_000, { storage: { uploadedBytes: 1024 } });
    expect(() => assertPlausibleBackupSizes([current], history(1_260_000_000))).not.toThrow();
  });
});
