import { describe, expect, it, vi } from "vitest";
import {
  extractChangedFiles,
  projectMatchesChanges,
} from "@repo/platform/engine/modules/github/webhook-changed-files";

describe("projectMatchesChanges", () => {
  it("ignores a sibling project while matching the selected project", () => {
    expect(projectMatchesChanges("services/backend", ["services/client/page.tsx"])).toBe(false);
    expect(projectMatchesChanges("services/backend", ["services/backend/src/index.ts"])).toBe(true);
  });

  it.each(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])(
    "treats repository-wide build input %s as relevant",
    (file) => {
      expect(projectMatchesChanges("services/backend", [file])).toBe(true);
    },
  );

  it("matches explicitly configured shared paths", () => {
    expect(
      projectMatchesChanges(
        "services/backend",
        ["packages/shared/src/index.ts"],
        ["packages/shared"],
      ),
    ).toBe(true);
  });
});

describe("extractChangedFiles", () => {
  it("preserves an incomplete compare result instead of treating it as exhaustive", async () => {
    const compareCommits = vi.fn().mockResolvedValue({
      files: ["services/client/page.tsx"],
      truncated: true,
    });
    const result = await extractChangedFiles(
      {
        before: "1111111111111111111111111111111111111111",
        after: "2222222222222222222222222222222222222222",
        repository: { name: "openship", owner: { login: "oblien" } },
        commits: Array.from({ length: 20 }, () => ({
          added: [],
          modified: [],
          removed: [],
        })),
      } as never,
      { compareCommits },
    );

    expect(result).toMatchObject({ truncated: true });
    expect(Array.from(result.files)).toEqual(["services/client/page.tsx"]);
  });
});
