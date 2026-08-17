/**
 * The grantable surface has ONE definition.
 *
 * It used to have seven, with no cross-check, and they drifted: the PAT screen
 * offered types the MCP consent screen deliberately withheld, and the two mint
 * allowlists could accept a type the resource picker had no catalog for. This
 * test's job is to make copy #8 fail rather than ship.
 *
 * The dashboard copies are pinned by grep rather than by import — this suite runs
 * under the API's vitest project and cannot resolve `@/lib/api`. A literal array
 * of resource types reappearing in those files is exactly the regression we're
 * guarding, so matching on the source text is the right instrument.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GRANTABLE_RESOURCE_TYPES,
  ORG_SINGLETON_RESOURCE_TYPES,
  PLATFORM_GRANT_TYPES,
  RESOURCE_GRANT_TYPES,
  RESOURCE_TYPE_LABELS,
  RESOURCE_TYPE_LABELS_SINGULAR,
  SELF_HOSTED_ONLY_GRANT_TYPES,
  SENSITIVE_GRANT_TYPES,
  grantableTypesForMode,
  isGrantableResourceType,
  isOrgSingletonResourceType,
} from "@repo/core";
import { GRANTABLE_RESOURCE_TYPES as VIA_API_LIB } from "../../src/lib/grantable-types";
import { ORG_SINGLETON_RESOURCES } from "../../src/lib/permission";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("one definition, re-exported not re-declared", () => {
  it("the API's grantable-types re-exports core's array by identity", () => {
    expect(VIA_API_LIB).toBe(GRANTABLE_RESOURCE_TYPES);
  });

  it("permission.ts's ORG_SINGLETON_RESOURCES is core's set, member for member", () => {
    expect([...ORG_SINGLETON_RESOURCES].sort()).toEqual([...ORG_SINGLETON_RESOURCE_TYPES].sort());
  });

  it("the token minter validates through the shared predicate, not a local Set", () => {
    const src = read("apps/api/src/modules/tokens/token.controller.ts");
    expect(src).toContain("isGrantableResourceType(g.resourceType)");
    expect(
      src,
      "GRANTABLE_TOKEN_TYPES was the mint-side copy — it must not come back",
    ).not.toContain("GRANTABLE_TOKEN_TYPES");
  });

  it("GRANTABLE_ROOTS is no longer declared in permission.ts", () => {
    // It was module-private and inert: every type it listed without a
    // `loadRootOrgId` case resolved to null anyway. Its presence invited readers
    // to treat it as the grantable surface, which it never was.
    //
    // Matches the DECLARATION, not the name — the comment explaining why it went
    // away is worth keeping, and banning the string would delete that history.
    expect(read("apps/api/src/lib/permission.ts")).not.toMatch(
      /(?:const|let|var|type|interface)\s+GRANTABLE_ROOTS\b/,
    );
  });
});

describe("no dashboard file re-declares the list", () => {
  // A literal array containing two or more grantable type names, which is the
  // shape every one of the seven copies had.
  const NAMES = GRANTABLE_RESOURCE_TYPES.map((t) => `"${t}"`);

  function literalRuns(src: string): string[] {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return (stripped.match(/\[[^[\]]*\]/g) ?? []).filter(
      (run) => NAMES.filter((n) => run.includes(n)).length >= 2,
    );
  }

  const FILES = [
    "apps/dashboard/src/lib/api/permissions.ts",
    "apps/dashboard/src/components/permissions/ResourcePicker.tsx",
    "apps/dashboard/src/components/permissions/mcp-access-templates.ts",
    "apps/dashboard/src/app/(dashboard)/settings/_components/PersonalAccessTokens.tsx",
    "apps/dashboard/src/app/(dashboard)/settings/_components/TeamTab.tsx",
  ];

  for (const file of FILES) {
    it(`${file} derives its types instead of listing them`, () => {
      expect(
        literalRuns(read(file)),
        `found a hardcoded resource-type array in ${file} — import from @repo/core instead`,
      ).toEqual([]);
    });
  }
});

describe("the derived views stay coherent", () => {
  it("resource and platform clusters partition the grantable set", () => {
    expect([...RESOURCE_GRANT_TYPES, ...PLATFORM_GRANT_TYPES].sort()).toEqual(
      [...GRANTABLE_RESOURCE_TYPES].sort(),
    );
    expect(RESOURCE_GRANT_TYPES.some(isOrgSingletonResourceType)).toBe(false);
    expect(PLATFORM_GRANT_TYPES.every(isOrgSingletonResourceType)).toBe(true);
  });

  it("every grantable type has both labels", () => {
    for (const t of GRANTABLE_RESOURCE_TYPES) {
      expect(RESOURCE_TYPE_LABELS[t], `plural label for ${t}`).toBeTruthy();
      expect(RESOURCE_TYPE_LABELS_SINGULAR[t], `singular label for ${t}`).toBeTruthy();
    }
  });

  it("mode filtering returns every grantable type — Operator is the only product", () => {
    const selfHosted = grantableTypesForMode(true);
    const other = grantableTypesForMode(false);
    expect(selfHosted).toEqual([...GRANTABLE_RESOURCE_TYPES]);
    expect(other).toEqual([...GRANTABLE_RESOURCE_TYPES]);
  });

  it("mode filtering preserves canonical display order", () => {
    for (const list of [grantableTypesForMode(true), grantableTypesForMode(false)]) {
      const canonical = GRANTABLE_RESOURCE_TYPES.filter((t) => list.includes(t));
      expect(list).toEqual(canonical);
    }
  });

  it("sensitive types are grantable — flagging is a UI concern, not a gate", () => {
    for (const t of SENSITIVE_GRANT_TYPES) expect(isGrantableResourceType(t)).toBe(true);
  });

  it("self-escalation and un-toolable types stay ungrantable", () => {
    // `permissions` would let a grantee widen its own access; `terminal`'s only
    // routes are WebSocket upgrades, so no grant can produce a usable capability.
    expect(isGrantableResourceType("permissions")).toBe(false);
    expect(isGrantableResourceType("terminal")).toBe(false);
  });
});
