import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  BUILD_SESSION_ERROR_FALLBACK,
  classifyBuildSessionFailure,
  hydrateSnapshotServices,
} from "./load-session";
import { normalizeComposeService, type ComposeServiceInfo } from "./types";

/**
 * The build page must not render "not found" for a deployment that exists
 * (#604). These pin the two halves of that fix:
 *
 * 1. only the server saying "404" classifies as not-found — a hydration
 *    exception, a 5xx, or a network failure is a load error with a retry;
 * 2. an empty `composeServices` snapshot no longer blanks a populated
 *    service list.
 */

const svc = (name: string, serviceId?: string): ComposeServiceInfo =>
  normalizeComposeService({ name, ...(serviceId ? { id: serviceId } : {}) });

describe("classifyBuildSessionFailure", () => {
  it("marks an HTTP 404 from the API as not-found", () => {
    const out = classifyBuildSessionFailure(
      new ApiError(404, "Not Found", { message: "Deployment not found" }),
    );
    expect(out.notFound).toBe(true);
    expect(out.error).toBe("Deployment not found");
  });

  it("treats a 5xx as a load failure, not a missing deployment", () => {
    // The backend maps internal failures to 500 precisely so they don't read
    // as "not found"; the client must not undo that at the last step.
    const out = classifyBuildSessionFailure(
      new ApiError(500, "Internal Server Error", { message: "boom" }),
    );
    expect(out.notFound).toBe(false);
  });

  it("treats a client-side hydration exception as a load failure", () => {
    // A throw while restoring config into state (the reported case: any
    // exception inside the try) is never evidence the resource is gone.
    const out = classifyBuildSessionFailure(new TypeError("cannot read properties of undefined"));
    expect(out.notFound).toBe(false);
    expect(out.error).toBe("cannot read properties of undefined");
  });

  it("treats a network-level failure as a load failure", () => {
    const out = classifyBuildSessionFailure(new TypeError("fetch failed"));
    expect(out.notFound).toBe(false);
  });

  it("falls back to the standard message for unrecognized throws", () => {
    const out = classifyBuildSessionFailure("stray string");
    expect(out.notFound).toBe(false);
    expect(out.error).toBe(BUILD_SESSION_ERROR_FALLBACK);
  });
});

describe("hydrateSnapshotServices", () => {
  const loaded = [svc("app", "s_app"), svc("postgres", "s_pg")];

  it("keeps the loaded list when the snapshot ships an empty composeServices array", () => {
    // #604: a `services`-type deploy reports `composeServices: []` while its
    // real services live elsewhere in the payload — `[]` is an Array, so the
    // old guard blanked the list instead of falling back.
    expect(hydrateSnapshotServices([], loaded)).toBe(loaded);
  });

  it("keeps the loaded list when the snapshot carries no composeServices at all", () => {
    expect(hydrateSnapshotServices(undefined, loaded)).toBe(loaded);
    expect(hydrateSnapshotServices(null, loaded)).toBe(loaded);
  });

  it("normalizes a populated snapshot and carries ids from the loaded rows", () => {
    const out = hydrateSnapshotServices([{ name: "app", image: "ghcr.io/app" } as never], loaded);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("app");
    expect(out[0].image).toBe("ghcr.io/app");
    // The snapshot carries no service-row ids; the loaded rows' ids survive.
    expect(out[0].serviceId).toBe("s_app");
  });

  it("returns an empty list when there is nothing to fall back to", () => {
    expect(hydrateSnapshotServices([], [])).toEqual([]);
  });
});
