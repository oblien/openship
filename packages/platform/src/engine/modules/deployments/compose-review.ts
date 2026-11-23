import { OperationError, type ComposeServiceDiff } from "@repo/contracts";
import { createHmac } from "node:crypto";
import { commandToArgv, sortJsonKeys, hasComposeInterpolation, ENV_MASK } from "@repo/core";
import { toComposeSpec, composeSpecDiff, type Service } from "@repo/db";
import { env } from "../../config/env";
import { redactDiagnosticText } from "@repo/core/diagnostics";
import { maskDriftChanges } from "../../lib/secret-env";

type SourceService = Parameters<typeof toComposeSpec>[0] & { name: string; kind?: string | null };

export type { SourceService };

// Compare authored configuration, not the values produced by interpolation in
// this request. Editing project env must not look like editing the Compose file.
function sourceSpec(value: Parameters<typeof toComposeSpec>[0]) {
  const spec = toComposeSpec(value);
  if (spec.advanced?.imageTemplate) {
    spec.image = spec.advanced.imageTemplate.expression;
    spec.advanced = {
      ...spec.advanced,
      imageTemplate: {
        expression: spec.advanced.imageTemplate.expression,
        unresolvedVariables: [],
      },
    };
  }
  if (spec.advanced?.commandTemplate) {
    const { expression } = spec.advanced.commandTemplate;
    spec.command = typeof expression === "string" ? expression : expression.join(" ");
    spec.commandArgv = commandToArgv(expression);
    spec.advanced = { ...spec.advanced, commandTemplate: { expression, unresolvedVariables: [] } };
  }
  for (const key of ["environmentTemplateKeys", "buildArgTemplateKeys"] as const) {
    if (spec.advanced?.[key]?.length) spec.advanced[key] = [...spec.advanced[key]].sort();
    else if (spec.advanced) delete spec.advanced[key];
  }
  return sortJsonKeys(spec) as typeof spec;
}

export function composeSourceRevision(
  projectId: string,
  services: readonly SourceService[],
): string {
  // Source specs can contain credentials. Key and scope the digest so it cannot
  // be used to guess those values offline or by scanning another project.
  const entries = services
    .filter((s) => !s.kind || s.kind === "compose")
    .map((s) => [s.name, sourceSpec(s)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(JSON.stringify(["compose-review-v1", projectId, entries]))
    .digest("hex");
}

/** One comparison for the gate, name summary and detailed review. */
function sourceChanges(rows: readonly Service[], services: readonly SourceService[]) {
  const existing = rows.filter((s) => s.kind === "compose" && !s.archivedAt);
  const byName = new Map(existing.map((s) => [s.name, s]));
  const incoming = services.filter((s) => !s.kind || s.kind === "compose");
  const names = new Set(incoming.map((s) => s.name));
  type Spec = ReturnType<typeof sourceSpec>;
  const changes: Array<{
    name: string;
    kind: ComposeServiceDiff["kind"];
    before: Spec | null;
    after: Spec | null;
  }> = [];
  for (const service of incoming) {
    const existing = byName.get(service.name);
    const after = sourceSpec(service);
    if (!existing) {
      changes.push({ name: service.name, kind: "added", before: null, after });
      continue;
    }
    const base = existing.importedSpec;
    // Legacy rows adopt their first baseline without losing saved settings.
    if (!base) continue;
    // Preserve the existing baseline migrations; a schema upgrade is not a source edit.
    const baseline = Object.hasOwn(base, "buildArgs")
      ? base
      : {
          ...base,
          buildArgs: service.buildArgs,
          advanced: {
            ...base.advanced,
            buildArgTemplateKeys: service.advanced?.buildArgTemplateKeys,
          },
        };
    const template = service.advanced?.commandTemplate;
    const migrated =
      !baseline.advanced?.commandTemplate && template && baseline.command === template.sourceValue
        ? { ...baseline, advanced: { ...baseline.advanced, commandTemplate: template } }
        : baseline;
    const before = sourceSpec(migrated);
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ name: service.name, kind: "changed", before, after });
  }
  for (const service of existing) {
    if (service.importedSpec && !names.has(service.name))
      changes.push({
        name: service.name,
        kind: "removed",
        before: sourceSpec(service.importedSpec),
        after: null,
      });
  }
  return changes;
}

function summarize(changes: ReturnType<typeof sourceChanges>) {
  return {
    added: changes.filter((s) => s.kind === "added").map((s) => s.name),
    changed: changes.filter((s) => s.kind === "changed").map((s) => s.name),
    removed: changes.filter((s) => s.kind === "removed").map((s) => s.name),
  };
}

export function composeSourceChanges(rows: readonly Service[], services: readonly SourceService[]) {
  return summarize(sourceChanges(rows, services));
}

function displayDiff(changes: ReturnType<typeof sourceChanges>): ComposeServiceDiff[] {
  return changes.map(({ name, kind, before, after }) => {
    const secrets = [before, after]
      .flatMap((spec) => [
        ...Object.values(spec?.environment ?? {}),
        ...Object.values(spec?.buildArgs ?? {}),
      ])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const display = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      // Authored expressions can hold nested defaults and required-value messages.
      // Use the shared interpolation detector and mask the whole value, as the
      // drift preview already does for template provenance.
      if (hasComposeInterpolation(text)) return ENV_MASK;
      return redactDiagnosticText(text, 4000, secrets);
    };
    // Share the drift UI's comparison and masking instead of maintaining a
    // second interpretation of Compose fields or secret-bearing provenance.
    const raw = composeSpecDiff(before ?? {}, after ?? {});
    const masked = maskDriftChanges(raw);
    const fields: ComposeServiceDiff["fields"] = [];
    for (const [index, change] of masked.entries()) {
      // command is a lossy copy; argv preserves shell/list command semantics.
      if (change.field === "command") continue;
      if (change.field === "environment" || change.field === "buildArgs") {
        const previous = (raw[index]!.from ?? {}) as Record<string, unknown>;
        const next = (raw[index]!.to ?? {}) as Record<string, unknown>;
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
          if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
          const path = `${change.field === "buildArgs" ? "build.args" : "environment"}.${key}`;
          fields.push({
            path,
            before: Object.hasOwn(previous, key)
              ? (display((change.from as Record<string, unknown>)[key]) ?? "null")
              : null,
            after: Object.hasOwn(next, key)
              ? (display((change.to as Record<string, unknown>)[key]) ?? "null")
              : null,
          });
        }
      } else {
        const path =
          change.field === "commandArgv"
            ? "command"
            : change.field === "dependsOn"
              ? "depends_on"
              : change.field;
        fields.push({
          path,
          before: before ? display(change.from) : null,
          after: after ? display(change.to) : null,
        });
      }
    }
    return { name, kind, fields };
  });
}

/**
 * Resolve the revision a deploy may pass the Compose review gate with. An
 * explicit acceptance derives the revision from the source being deployed, so
 * the gate clears for exactly what was scanned — the caller cannot clear it
 * for a different revision. A caller that already holds a revision (dashboard
 * deploys) keeps passing it through. Without either, nothing is resolved and
 * the gate still refuses unreviewed changes.
 */
export function resolveComposeReviewedRevision(
  projectId: string,
  source: readonly SourceService[],
  options: { composeRevision?: string; acceptComposeChanges?: boolean } = {},
): string | undefined {
  if (options.acceptComposeChanges) return composeSourceRevision(projectId, source);
  return options.composeRevision;
}

export function assertComposeReviewed(
  projectId: string,
  rows: readonly Service[],
  source: readonly SourceService[],
  reviewedRevision?: string,
) {
  const delta = sourceChanges(rows, source);
  const changes = summarize(delta);
  const revision = composeSourceRevision(projectId, source);
  const changed =
    rows.some((s) => s.kind === "compose") &&
    (changes.added.length > 0 || changes.changed.length > 0 || changes.removed.length > 0);
  if (reviewedRevision ? reviewedRevision !== revision : changed) {
    throw new OperationError(
      "The Compose configuration has changed. Review the changes before deploying.",
      409,
      "COMPOSE_REVIEW_REQUIRED",
      {
        projectId,
        composeRevision: revision,
        composeChanges: changes,
        composeDiff: displayDiff(delta),
      },
    );
  }
}
