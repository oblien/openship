import { describe, expect, test } from "vitest";

import { rootScopeAffected } from "./webhook-changed-files";

/**
 * #637: a monorepo project with its own root directory must only show an
 * update when the repo diff actually touches that project — directly under
 * its root, at a shared/root-config path, or when no root scopes it at all.
 */
describe("rootScopeAffected", () => {
  test("a file under the project root counts", () => {
    expect(
      rootScopeAffected(["apps/backend/src/api.ts"], { rootDirectory: "apps/backend" }),
    ).toBe(true);
  });

  test("a diff confined to a sibling directory does not count", () => {
    expect(
      rootScopeAffected(["apps/client/src/ui.tsx"], { rootDirectory: "apps/backend" }),
    ).toBe(false);
  });

  test("an empty diff scoped to an untouched root does not count", () => {
    expect(rootScopeAffected([], { rootDirectory: "apps/backend" })).toBe(false);
  });

  test("a similarly-prefixed sibling directory does not count (path boundary)", () => {
    expect(
      rootScopeAffected(["apps/backend-utils/turbo.json"], { rootDirectory: "apps/backend" }),
    ).toBe(false);
  });

  test("a leading/trailing slash root still matches its directory", () => {
    expect(
      rootScopeAffected(["apps/backend/nested/deep.ts"], { rootDirectory: "/apps/backend/" }),
    ).toBe(true);
  });

  test("a repo-root config change affects every project", () => {
    expect(
      rootScopeAffected(["package.json"], { rootDirectory: "apps/backend" }),
    ).toBe(true);
  });

  test("a configured shared path affects every project", () => {
    expect(
      rootScopeAffected(
        ["packages/ui/button.tsx"],
        {
          rootDirectory: "apps/backend",
          isMonorepo: true,
          monorepoSharedPaths: ["packages/"],
        },
      ),
    ).toBe(true);
  });

  test("a shared path is inert without monorepo semantics", () => {
    expect(
      rootScopeAffected(
        ["packages/ui/button.tsx"],
        {
          rootDirectory: "apps/backend",
          monorepoSharedPaths: ["packages/"],
        },
      ),
    ).toBe(false);
  });

  test("a project without a scoping root is affected by any change", () => {
    expect(rootScopeAffected(["anything/anywhere.ts"], { rootDirectory: null })).toBe(true);
    expect(rootScopeAffected(["anything/anywhere.ts"], {})).toBe(true);
    expect(rootScopeAffected(["anything/anywhere.ts"], { rootDirectory: "." })).toBe(true);
  });

  test("file exactly at the root path counts as under it", () => {
    expect(rootScopeAffected(["apps/backend"], { rootDirectory: "apps/backend" })).toBe(true);
  });
});
