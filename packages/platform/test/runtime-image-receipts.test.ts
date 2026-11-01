import { expect, it } from "vitest";
import {
  recordRuntimeImageReceipts,
  readRuntimeImageReceipts,
  runtimeImageTrackingRef,
} from "../src/engine/lib/runtime-image-receipts";

const digest = `sha256:${"a".repeat(64)}`;
it("carries sibling receipts forward and binds only newly built service bases to their artifacts", () => {
  const first = recordRuntimeImageReceipts({}, [
    { serviceId: "a", imageRef: "build-a", baseImages: [{ ref: "php:8.4", digest }] },
  ]);
  const second = recordRuntimeImageReceipts(first, [
    { serviceId: "b", imageRef: "build-b", baseImages: [{ ref: "node:22", digest }] },
  ]);
  expect(second.services).toEqual({
    a: [{ ref: "php:8.4", digest }],
    b: [{ ref: "node:22", digest }],
  });
  expect(second.artifacts?.services).toEqual({ a: "build-a", b: "build-b" });
  const unknown = recordRuntimeImageReceipts(second, [{ serviceId: "a", imageRef: "build-new" }]);
  expect(unknown.services?.a).toEqual([]);
  expect(unknown.artifacts?.services?.a).toBe("build-new");
});
it("discards malformed receipt metadata instead of treating it as a deployed baseline", () => {
  expect(
    readRuntimeImageReceipts({
      app: [{ ref: "php:8.4", digest: "latest" }],
      artifacts: { app: 42 },
    }),
  ).toEqual({ app: [], services: {}, artifacts: { services: {} } });
});
it("keeps the release tag trackable after immutable rollback while allowing a new configured tag", () => {
  const original = "ghcr.io/example/app:v1.2.3";
  expect(runtimeImageTrackingRef(`ghcr.io/example/app@${digest}`, original, true)).toBe(original);
  expect(runtimeImageTrackingRef(`ghcr.io/example/app@${digest}`, original)).toBe(
    `ghcr.io/example/app@${digest}`,
  );
  expect(runtimeImageTrackingRef("ghcr.io/example/app:v1.2.4", original)).toBe(
    "ghcr.io/example/app:v1.2.4",
  );
  expect(runtimeImageTrackingRef(`ghcr.io/example/app@${digest}`, undefined)).toBe(
    `ghcr.io/example/app@${digest}`,
  );
});
