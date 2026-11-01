import { shellQuote as sq } from "@repo/core";

/** Public exports must be readable by the edge, regardless of a builder's umask.
 * Only the staged copy changes; source files and private volumes keep their modes. */
export function staticExportCopyCommand(source: string, staging: string): string {
  return [
    `mkdir -p ${sq(staging)}`,
    `cp -a ${sq(source)}/. ${sq(staging)}/`,
    `test -z "$(find ${sq(staging)} -type l -print -quit)"`,
    `find ${sq(staging)} -type d -exec chmod 0755 {} +`,
    `find ${sq(staging)} -type f -exec chmod 0644 {} +`,
  ].join("\n");
}
