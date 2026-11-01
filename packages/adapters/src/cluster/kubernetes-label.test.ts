import { describe, expect, it } from "vitest";
import { kubernetesIdLabel } from "./kubernetes-label";

describe("Kubernetes identity labels", () => {
  it("preserves valid existing identities so deployments need no migration", () => {
    for (const id of ["a", "proj_example", "dep_with-DASH_1", "with.period", "a".repeat(63)])
      expect(kubernetesIdLabel(id)).toBe(id);
  });

  it("does not collapse identities by stripping punctuation or truncating their prefix", () => {
    const ids = [
      "dep_name",
      "dep_name_",
      "dep_name-",
      ".dep_name",
      "dep/name",
      "dep=name",
      "a".repeat(64),
      "a".repeat(63) + "b",
    ];
    const labels = ids.map(kubernetesIdLabel);
    expect(new Set(labels).size).toBe(ids.length);
    for (const [index, label] of labels.entries()) {
      expect(label).toMatch(/^[a-z0-9](?:[-a-z0-9_.]*[a-z0-9])?$/i);
      expect(label.length).toBeLessThanOrEqual(63);
      expect(kubernetesIdLabel(ids[index]!)).toBe(label);
    }
  });
});
