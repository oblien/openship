import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #527: the isLocal row's connection fields must stay refused, INCLUDING the next one
 * somebody adds.
 *
 * `updateServer` refuses a connection edit on the row that represents this box, because
 * nothing dials with those fields — the container→host channel authenticates with
 * OPENSHIP_HOST_SSH_*, and `ensureLocalServer` reverts `ssh_user` on the next read anyway.
 * Storing them meant the UI displayed a credential that was neither used nor kept, which
 * is where #527's reporter spent most of a dozen messages.
 *
 * The failure mode this guards is drift, not logic: the guard is a list, and a list goes
 * stale the moment someone adds `sshFoo` to the patch builder and not to it — restoring
 * exactly the silent-accept behaviour for one field, on the one row where it means
 * nothing. Asserted over the SOURCE rather than by importing the controller: the check is
 * about which lines exist, and importing would drag repos/permission/audit into a test
 * that needs none of them.
 */
describe("updateServer — every ssh* field it accepts is refused on the local row", () => {
  const SRC = readFileSync(
    join(__dirname, "../../../src/modules/system/servers.controller.ts"),
    "utf8",
  );

  /** The declared list. */
  const listed = (() => {
    const block = SRC.match(/LOCAL_ROW_READONLY_FIELDS = \[([\s\S]*?)\] as const/);
    expect(block, "LOCAL_ROW_READONLY_FIELDS was renamed or removed").toBeTruthy();
    return new Set([...block![1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
  })();

  /** Every ssh* field the patch builder actually writes. */
  const handled = new Set(
    [...SRC.matchAll(/if \(body\.(ssh\w+) !== undefined\)/g)].map((m) => m[1]),
  );

  it("finds the fields at all, so a rewrite can't make this vacuously pass", () => {
    expect(handled.size).toBeGreaterThan(5);
    expect(listed.size).toBeGreaterThan(5);
  });

  it("refuses every ssh* field the handler can write", () => {
    expect([...handled].filter((f) => !listed.has(f))).toEqual([]);
  });

  it("lists nothing the handler doesn't write, so the refusal names real fields", () => {
    expect([...listed].filter((f) => !handled.has(f))).toEqual([]);
  });

  it("leaves `name` writable — renaming this row is meaningful", () => {
    expect(listed.has("name")).toBe(false);
    expect(SRC).toContain("if (body.name !== undefined) patch.name");
  });
});
