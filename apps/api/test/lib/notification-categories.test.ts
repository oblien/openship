import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  CATEGORY_GROUPS,
  EVENT_HEADLINES,
  categoryForEventType,
  findCategory,
} from "../../src/lib/notification-categories";

/**
 * The category registry is a public contract in three directions at once, and
 * nothing was guarding any of them:
 *
 *   • ids are STORED — notification_subscription.category and
 *     notification_default.category hold them, so renaming one silently orphans
 *     every row a user has toggled.
 *   • groups drive the Settings tab strip. A group with no categories renders as
 *     a dead tab (or, with the current UI, vanishes) and nobody notices.
 *   • every eventType the dispatcher maps has to land on a category that still
 *     exists, or the delivered alert falls back to printing a raw id.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/lib/notification-categories.ts", import.meta.url)),
  "utf8",
);

/**
 * Every eventType the dispatcher maps.
 *
 * EVENT_TYPE_TO_CATEGORY is private, so its KEYS are enumerated from source and each
 * one pushed through the exported function — the assertions still run against real
 * behavior, the source read only supplies the inputs.
 */
const MAPPED_EVENT_TYPES = (() => {
  const block = SOURCE.slice(
    SOURCE.indexOf("const EVENT_TYPE_TO_CATEGORY"),
    SOURCE.indexOf("export function categoryForEventType"),
  );
  return [...block.matchAll(/^\s*"([\w.]+)":/gm)].map((m) => m[1]!);
})();

describe("notification category registry", () => {
  it("has unique ids", () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins the stored ids", () => {
    // These are DB values, not display strings. A diff here means either a new
    // category (add it below) or a rename that needs a migration first — the
    // labels above them are free to change, which is the point of the split.
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      "deploy.failed",
      "deploy.succeeded",
      "deploy.cancelled",
      "service.down",
      "service.crash_loop",
      "service.unhealthy",
      "service.recovered",
      "server.unreachable",
      "backup.failed",
      "backup.succeeded",
      "backup.restore_completed",
      "job.run.failed",
      "job.run.succeeded",
      "job.run.started",
      "domain.expiring",
      "domain.verification_failed",
      "member.added",
      "member.removed",
      "invitation.sent",
      "billing.alert",
      "quota.warning",
    ]);
  });

  it("puts every category in a declared group", () => {
    // Also enforced by the type (group is the union derived from CATEGORY_GROUPS),
    // but this one survives someone widening the field to `string`.
    const groupIds = new Set<string>(CATEGORY_GROUPS.map((g) => g.id));
    for (const cat of CATEGORIES) {
      expect(groupIds, `${cat.id} → unknown group "${cat.group}"`).toContain(cat.group);
    }
  });

  it("leaves no group empty", () => {
    // The half the compiler can't see: a group is only real if something is in
    // it. An empty one is a tab that shows nothing.
    const used = new Set(CATEGORIES.map((c) => c.group));
    for (const g of CATEGORY_GROUPS) {
      expect(used, `group "${g.id}" has no categories`).toContain(g.id);
    }
  });

  it("resolves every mapped eventType to a live category", () => {
    expect(MAPPED_EVENT_TYPES.length).toBeGreaterThan(20);

    for (const eventType of MAPPED_EVENT_TYPES) {
      const category = categoryForEventType(eventType);
      expect(category, `${eventType} maps to nothing`).toBeDefined();
      expect(findCategory(category!), `${eventType} → dead category ${category}`).toBeDefined();
    }
  });

  it("overrides a headline only where an event shares a category with its opposite", () => {
    for (const [eventType, headline] of Object.entries(EVENT_HEADLINES)) {
      // An override on an eventType the dispatcher doesn't map is dead code — the
      // event never becomes a delivery, so nothing ever renders it, and the symptom
      // is an alert that still reads wrong.
      const category = categoryForEventType(eventType);
      expect(category, `${eventType} has a headline but maps to no category`).toBeDefined();

      // And it is only justified for a genuinely two-directional category. Where the
      // category has one event type, the override is a second place to edit the same
      // string, which is how the two drift apart.
      const sharing = MAPPED_EVENT_TYPES.filter((e) => categoryForEventType(e) === category);
      expect(sharing.length, `${category} carries only ${eventType} — set its label instead`)
        .toBeGreaterThan(1);

      // A title identical to the category label is the no-op the override exists to
      // avoid; it means the two directions never actually diverged.
      expect(headline.title).not.toBe(findCategory(category!)!.label);
    }
  });

  it("keeps the app-health group whole", () => {
    // The health watch is the one producer whose categories span two nouns —
    // four about an app, one about the box under it. They share a tab because an
    // operator reads them together; if a later edit splits them off, that's a
    // decision, not a drive-by.
    const appHealth = CATEGORIES.filter((c) => c.group === "app_health").map((c) => c.id);
    expect(appHealth).toEqual([
      "service.down",
      "service.crash_loop",
      "service.unhealthy",
      "service.recovered",
      "server.unreachable",
    ]);
    // All on by default: an app that's down is the thing nobody wants to hear
    // about from a user first.
    for (const id of appHealth) expect(findCategory(id)!.defaultEnabled).toBe(true);
  });
});
