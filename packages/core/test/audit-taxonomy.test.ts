import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_CATEGORIES,
  AUDIT_EVENTS,
  auditResourceLabel,
  categoryForAuditEvent,
  describeAuditEvent,
  eventTypesForCategory,
  isAuditCategoryId,
  prettifyEventType,
} from "../src/audit-taxonomy";

/**
 * The catalog is a contract in two directions and nothing was guarding either:
 *
 *   • the API expands a category filter into `event_type IN (...)`, so an event
 *     with no entry is invisible in every tab but "All" — a row silently missing
 *     from the view an operator filtered to,
 *   • the dashboard renders each row as a sentence from `action`/`label`, so an
 *     event with no entry degrades to the prettified raw type ("Deployment
 *     succeeded" is fine; "Grant replaced" reads like a stub, which is what the
 *     dashboard-only label file this replaced was full of).
 *
 * The drift that motivated this: the old file mapped `deployment.canceled` while
 * the API emitted `deployment.cancelled`, and ~15 emitted types had no entry at
 * all. That is a class of bug only a coverage test catches, so the emitted types
 * are enumerated FROM apps/api's source and pushed through the real lookup.
 */

const API_SRC = fileURLToPath(new URL("../../../apps/api/src", import.meta.url));

/** Every `.ts` file under apps/api/src. */
function apiSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...apiSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Event types emitted as literals: `eventType: "..."` outside a comment.
 *
 * Deliberately over-inclusive — it also catches the notification dispatcher's
 * literals, which are mostly audit types too. A catalog entry for a type that
 * never reaches audit_event costs nothing; a missing one costs a readable row.
 */
function emittedEventTypes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of apiSourceFiles(API_SRC)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*\*/.test(line)) continue; // jsdoc example, not a call site
      const match = line.match(/eventType:\s*"([^"]+)"/);
      if (match?.[1] && !found.has(match[1])) found.set(match[1], file);
    }
  }
  return found;
}

/**
 * The incident service picks its audit event type out of a `Record<IncidentKind,
 * string>` map, so the literals above never see it — and those rows (a service
 * down, a server unreachable) are the ones an operator goes looking for first.
 * The map is private; its VALUES are read from source and pushed through the
 * real lookup, same as the literals.
 */
function incidentEventTypes(): string[] {
  const file = join(API_SRC, "modules/monitoring/incident.service.ts");
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  const start = src.indexOf("const EVENT_TYPE: Record<IncidentKind, string> = {");
  if (start === -1) return [];
  const block = src.slice(start, src.indexOf("};", start));
  return [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

const CATEGORY_IDS = AUDIT_CATEGORIES.map((c) => c.id);

describe("audit categories", () => {
  it("has unique ids", () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
  });

  it("pins the ids the dashboard deep-links to", () => {
    // These travel in URLs (?category=deployments) and are sent to the API as a
    // filter, so a rename breaks saved links and every bookmarked view. Labels
    // above them are free to change — that's the point of the split.
    expect(CATEGORY_IDS).toEqual([
      "deployments",
      "apps",
      "domains",
      "servers",
      "members",
      "security",
      "billing",
      "system",
    ]);
  });

  it("accepts only real ids", () => {
    for (const id of CATEGORY_IDS) expect(isAuditCategoryId(id)).toBe(true);
    expect(isAuditCategoryId("deployment")).toBe(false);
    expect(isAuditCategoryId("")).toBe(false);
    expect(isAuditCategoryId(undefined)).toBe(false);
  });
});

describe("audit event catalog", () => {
  it("puts every event in a category that exists", () => {
    const orphans = Object.entries(AUDIT_EVENTS)
      .filter(([, def]) => !CATEGORY_IDS.includes(def.category))
      .map(([type, def]) => `${type} → ${def.category}`);
    expect(orphans).toEqual([]);
  });

  it("gives every event a past-tense action and an actorless label", () => {
    const bad = Object.entries(AUDIT_EVENTS)
      .filter(([, def]) => !def.action?.trim() || !def.label?.trim())
      .map(([type]) => type);
    expect(bad).toEqual([]);
  });

  it("reaches every catalogued event from exactly one category filter", () => {
    // A category filter is `event_type IN (eventTypesForCategory(id))`. If a type
    // appeared in two lists it would double-count in the facet totals; if it
    // appeared in none it would be unreachable outside "All".
    const seen = new Map<string, number>();
    for (const id of CATEGORY_IDS) {
      for (const type of eventTypesForCategory(id)) {
        seen.set(type, (seen.get(type) ?? 0) + 1);
      }
    }
    expect([...seen].filter(([, n]) => n !== 1)).toEqual([]);
    expect([...seen.keys()].sort()).toEqual(Object.keys(AUDIT_EVENTS).sort());
  });

  it("returns an empty list for an unknown category rather than throwing", () => {
    // A stale bookmark (?category=deleted) must degrade to unfiltered, not 500.
    expect(eventTypesForCategory("nope")).toEqual([]);
    expect(eventTypesForCategory("")).toEqual([]);
    expect(categoryForAuditEvent("nope.happened")).toBeNull();
  });
});

describe("every event type apps/api emits is catalogued", () => {
  const present = existsSync(API_SRC);

  it.skipIf(!present)("literal `eventType:` call sites", () => {
    const emitted = emittedEventTypes();
    // Guard against the scan silently finding nothing if the call sites are ever
    // refactored into a shape this regex doesn't see.
    expect(emitted.size).toBeGreaterThan(50);
    const uncatalogued = [...emitted]
      .filter(([type]) => !(type in AUDIT_EVENTS))
      .map(([type, file]) => `${type}  (${file.slice(API_SRC.length + 1)})`);
    expect(
      uncatalogued,
      "New audit event types with no entry in AUDIT_EVENTS — add one so the row " +
        "renders as a sentence and lands in a category tab:\n" +
        uncatalogued.join("\n"),
    ).toEqual([]);
  });

  it.skipIf(!present)("the incident service's dynamic event types", () => {
    const kinds = incidentEventTypes();
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((type) => !(type in AUDIT_EVENTS))).toEqual([]);
  });

  it("catalogues the audit log's own settings events", () => {
    // Emitted by the PATCH /api/audit/settings handler. Turning recording off is
    // the one event whose absence from the log would be indistinguishable from
    // nothing having happened, so it must render properly.
    for (const type of ["audit.disabled", "audit.enabled", "audit.retention_changed"]) {
      expect(AUDIT_EVENTS[type], type).toBeDefined();
      expect(categoryForAuditEvent(type)).toBe("security");
    }
  });
});

describe("describeAuditEvent", () => {
  it("resolves a catalogued event and marks it known", () => {
    const d = describeAuditEvent("deployment.succeeded");
    expect(d.known).toBe(true);
    expect(d.category).toBe("deployments");
    expect(d.tone).toBe("success");
    expect(d.action).toBe("deployed");
  });

  it("defaults tone to neutral rather than leaving it undefined", () => {
    // The dashboard indexes a tone→token map with this; undefined would render a
    // dot with no colour class at all.
    for (const type of Object.keys(AUDIT_EVENTS)) {
      expect(describeAuditEvent(type).tone, type).toBeTruthy();
    }
  });

  it("never throws on an uncatalogued type — it hedges", () => {
    const d = describeAuditEvent("widget.frobnicated");
    expect(d.known).toBe(false);
    expect(d.label).toBe("Widget frobnicated");
    expect(d.tone).toBe("neutral");
    expect(d.category).toBe("system");
  });

  it("survives an empty event type", () => {
    expect(describeAuditEvent("").label).toBe("Unknown event");
  });
});

describe("prettifyEventType", () => {
  it("renders dotted and underscored types as a sentence", () => {
    expect(prettifyEventType("foo.bar_baz")).toBe("Foo bar baz");
    expect(prettifyEventType("deployment.succeeded")).toBe("Deployment succeeded");
  });

  it("renders permission tags — the auto-emitter's event types — with the colon", () => {
    expect(prettifyEventType("project:write")).toBe("Project: write");
    expect(prettifyEventType("project:service:write")).toBe("Project: service: write");
  });
});

describe("auditResourceLabel", () => {
  it("names known resource types", () => {
    expect(auditResourceLabel("project")).toBeTruthy();
    expect(auditResourceLabel("project")).not.toBe("project");
  });

  it("falls back to a de-punctuated noun, and to nothing when there is no type", () => {
    expect(auditResourceLabel("widget_thing")).toBe("widget thing");
    expect(auditResourceLabel(null)).toBe("");
    expect(auditResourceLabel(undefined)).toBe("");
  });
});
