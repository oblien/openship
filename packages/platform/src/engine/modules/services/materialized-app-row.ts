import type { Project, Service } from "@repo/db";

/**
 * Is this row one the materializer above WROTE, rather than one a person
 * configured? Keyed on the full signature it creates: the project slug as the
 * name, `sortOrder: -1` (which nothing else in the codebase writes), and every
 * build-identity field left null so it inherits the project snapshot.
 *
 * A row is only reclaimable while its build identity is pristine. `enabled` is
 * deliberately NOT part of the signature — disabling the mystery service is the
 * first thing an operator hit by #589 tries, and that workaround must not make
 * the row un-healable. Nor are `environment` / `ports` / `volumes`: the caller
 * gates on the row never having deployed successfully, which is the real
 * data-safety property (no container was ever created from it, so no volume
 * holds anything), and a few unused form fields are not worth leaving a project
 * un-deployable over.
 */
export function isMaterializedAppRow(
  project: Pick<Project, "slug">,
  row: Pick<
    Service,
    | "kind"
    | "name"
    | "sortOrder"
    | "image"
    | "build"
    | "dockerfile"
    | "framework"
    | "installCommand"
    | "buildCommand"
    | "startCommand"
    | "outputDirectory"
  >,
): boolean {
  return (
    row.kind === "monorepo" &&
    row.name === project.slug &&
    row.sortOrder === -1 &&
    !row.image &&
    !row.build &&
    !row.dockerfile &&
    !row.framework &&
    !row.installCommand &&
    !row.buildCommand &&
    !row.startCommand &&
    !row.outputDirectory
  );
}
