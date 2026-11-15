import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret" },
}));
// The revision derivation only needs a deterministic spec per service; the real
// toComposeSpec transform is covered by the apps/api integration suite.
vi.mock("@repo/db", () => ({ toComposeSpec: (value: unknown) => value }));

import {
  composeSourceRevision,
  resolveComposeReviewedRevision,
} from "./compose-review";

const SOURCE = [
  { name: "api", image: "api:1" },
  { name: "db", image: "postgres:16" },
];

describe("resolveComposeReviewedRevision", () => {
  it("returns the passed revision when acceptance is off", () => {
    expect(
      resolveComposeReviewedRevision("project", SOURCE, {
        composeRevision: "abc",
      }),
    ).toBe("abc");
    expect(
      resolveComposeReviewedRevision("project", SOURCE, {}),
    ).toBeUndefined();
  });

  it("derives the revision from the scanned source when acceptance is on", () => {
    expect(
      resolveComposeReviewedRevision("project", SOURCE, {
        acceptComposeChanges: true,
      }),
    ).toBe(composeSourceRevision("project", SOURCE));
  });

  it("acceptance wins over a stale passed revision", () => {
    expect(
      resolveComposeReviewedRevision("project", SOURCE, {
        composeRevision: "stale",
        acceptComposeChanges: true,
      }),
    ).toBe(composeSourceRevision("project", SOURCE));
  });

  it("tracks the current source, not the previously reviewed one", () => {
    const changed = [
      { name: "api", image: "api:2" },
      { name: "db", image: "postgres:16" },
    ];
    expect(
      resolveComposeReviewedRevision("project", changed, {
        acceptComposeChanges: true,
      }),
    ).not.toBe(composeSourceRevision("project", SOURCE));
  });
});
