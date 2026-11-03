import { OperationError } from "@repo/contracts";
import { createHmac } from "node:crypto";
import { sortJsonKeys } from "@repo/core";
import { toComposeSpec, type Service } from "@repo/db";
import { env } from "../../config/env";

type SourceService = Parameters<typeof toComposeSpec>[0] & { name: string; kind?: string | null };

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
  for (const key of ["environmentTemplateKeys", "buildArgTemplateKeys"] as const) {
    if (spec.advanced?.[key]?.length) spec.advanced[key] = [...spec.advanced[key]].sort();
    else if (spec.advanced) delete spec.advanced[key];
  }
  return sortJsonKeys(spec);
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

export function composeSourceChanges(rows: readonly Service[], services: readonly SourceService[]) {
  const existing = rows.filter((s) => s.kind === "compose" && !s.archivedAt);
  const byName = new Map(existing.map((s) => [s.name, s]));
  const incoming = services.filter((s) => !s.kind || s.kind === "compose");
  const names = new Set(incoming.map((s) => s.name));
  return {
    added: incoming.filter((s) => !byName.has(s.name)).map((s) => s.name),
    changed: incoming
      .filter((s) => {
        const base = byName.get(s.name)?.importedSpec;
        // Legacy rows adopt their first baseline without losing saved settings.
        if (!base) return false;
        // Build args were added after the original baseline format. Backfill that
        // field once; do not mistake a schema upgrade for a source edit.
        const baseline = Object.hasOwn(base, "buildArgs")
          ? base
          : {
              ...base,
              buildArgs: s.buildArgs,
              advanced: {
                ...base.advanced,
                buildArgTemplateKeys: s.advanced?.buildArgTemplateKeys,
              },
            };
        return JSON.stringify(sourceSpec(baseline)) !== JSON.stringify(sourceSpec(s));
      })
      .map((s) => s.name),
    removed: existing.filter((s) => s.importedSpec && !names.has(s.name)).map((s) => s.name),
  };
}

export function assertComposeReviewed(
  projectId: string,
  rows: readonly Service[],
  source: readonly SourceService[],
  reviewedRevision?: string,
) {
  const changes = composeSourceChanges(rows, source);
  const changed =
    rows.some((s) => s.kind === "compose") &&
    (changes.added.length > 0 || changes.changed.length > 0 || changes.removed.length > 0);
  if (reviewedRevision ? reviewedRevision !== composeSourceRevision(projectId, source) : changed) {
    throw new OperationError(
      "The Compose configuration has changed. Review the latest services in Configure before deploying.",
      409,
      "COMPOSE_REVIEW_REQUIRED",
      { projectId, composeChanges: changes },
    );
  }
}
