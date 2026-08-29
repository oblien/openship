import { describe, it, expect } from "vitest";
import type { Service } from "@/lib/api";
import { beginServicesFetch, failServicesFetch } from "./services-fetch-state";

/**
 * The #666 regression and its inverse both live here: a refresh that reports
 * loading (skeleton flash on every action), and a navigation that doesn't
 * (project A's rows rendered under project B). The fix must satisfy both.
 */

const rows = [{ id: "s1" }] as unknown as Service[];
const prev = { services: rows, isLoading: false, error: null };

describe("beginServicesFetch", () => {
  it("refresh keeps the rows on screen and reports no loading", () => {
    expect(beginServicesFetch(prev, "A", "A")).toMatchObject({
      isLoading: false,
      services: rows,
    });
  });

  it("navigation reports loading even though the held list is non-empty", () => {
    // A's rows must never pass for B's — the skeleton is correct here.
    expect(beginServicesFetch(prev, "A", "B").isLoading).toBe(true);
  });

  it("first load with nothing held reports loading", () => {
    expect(
      beginServicesFetch({ services: [], isLoading: false, error: null }, null, "A").isLoading,
    ).toBe(true);
  });

  it("clears a previous error once a fetch starts", () => {
    const failing = { ...prev, error: "Failed to load services" };
    expect(beginServicesFetch(failing, "A", "A").error).toBeNull();
  });
});

describe("failServicesFetch", () => {
  it("failed refresh keeps the rows that were on screen", () => {
    expect(failServicesFetch(prev, "A", "A").services).toBe(rows);
  });

  it("failed navigation drops the previous project's list", () => {
    expect(failServicesFetch(prev, "A", "B").services).toEqual([]);
  });

  it("always clears loading and surfaces the failure", () => {
    const out = failServicesFetch({ ...prev, isLoading: true }, "A", "A");
    expect(out.isLoading).toBe(false);
    expect(out.error).toBe("Failed to load services");
  });
});
