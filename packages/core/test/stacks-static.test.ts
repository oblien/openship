import { describe, it, expect } from "vitest";
import {
  STACKS,
  categoryServesFiles,
  isTypicallyStatic,
  type StackId,
  type StackDefinition,
} from "../src/stacks";

/**
 * `isTypicallyStatic` is the hasServer-toggle default, and it is now the ONLY
 * definition of "this stack's canonical shape is files" — the dashboard used to
 * open-code its body twice while this exported function had zero callers.
 *
 * It is deliberately NOT the same question as the two other "static" predicates
 * in the tree (see its docblock); these cases pin the differences that make
 * merging them wrong.
 */
describe("isTypicallyStatic", () => {
  it("accepts a pure SPA / static stack", () => {
    for (const id of ["static", "vite", "react", "vue", "angular", "cra", "blazor"]) {
      expect(isTypicallyStatic(id)).toBe(true);
    }
  });

  it("REJECTS an SSR-capable frontend — it ships a default start command", () => {
    // The clause that distinguishes this from `isStaticService`: Astro and Gatsby
    // are `frontend` but serve from a process by default, so the hasServer toggle
    // must default ON for them.
    expect(isTypicallyStatic("astro")).toBe(false);
    expect(isTypicallyStatic("gatsby")).toBe(false);
  });

  it("rejects backend / fullstack / docker stacks", () => {
    for (const id of ["node", "nextjs", "docker"]) {
      expect(isTypicallyStatic(id)).toBe(false);
    }
  });

  it("returns false — never throws — for an unknown or absent framework", () => {
    // Callers feed it a persisted `framework` column, which can hold a stale or
    // hand-edited value. The previous signature indexed STACKS unguarded.
    for (const id of ["unknown", "not-a-stack", "", null, undefined]) {
      expect(isTypicallyStatic(id)).toBe(false);
    }
    expect(isTypicallyStatic("__proto__")).toBe(false);
  });

  it("agrees with the raw stack definition for every stack", () => {
    // Guards the refactor itself: the extracted helper must answer identically to
    // the expression the dashboard used to inline.
    for (const [id, def] of Object.entries(STACKS) as Array<[StackId, StackDefinition]>) {
      const inline =
        (def.category === "static" || def.category === "frontend") && !def.defaultStartCommand;
      expect(isTypicallyStatic(id)).toBe(inline);
    }
  });
});

describe("categoryServesFiles", () => {
  it("accepts the two file-served categories", () => {
    expect(categoryServesFiles("static")).toBe(true);
    expect(categoryServesFiles("frontend")).toBe(true);
  });

  it("rejects every process-served category, and nothing at all", () => {
    for (const c of ["backend", "fullstack", "docker", "services", "generic", "", null, undefined]) {
      expect(categoryServesFiles(c)).toBe(false);
    }
  });

  it("is the SAME test every caller used to inline", () => {
    // Guards the dedup: three sites open-coded this expression, so if the shared
    // primitive ever narrows, the callers must fail here rather than silently
    // reclassify a whole category of project.
    for (const def of Object.values(STACKS) as StackDefinition[]) {
      expect(categoryServesFiles(def.category)).toBe(
        def.category === "static" || def.category === "frontend",
      );
    }
  });
});
