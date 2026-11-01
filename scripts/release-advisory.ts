import { parseManifest } from "../packages/core/src/updates/advisories";
import type { Advisory, AdvisoryMode } from "../packages/core/src/updates/types";

/** Keep a prepared release's recovery instructions, link and audience when
 * `publish` is used. Only explicit command-line options override its copy. */
export function buildReleaseAdvisory(
  version: string,
  opts: { critical?: boolean; message?: string; modes?: readonly AdvisoryMode[] },
  manifest?: unknown,
): Advisory {
  const id = `update-${version}`;
  const prepared = parseManifest(manifest).advisories.find(entry => entry.id === id);
  const entry: Advisory = prepared ?? {
    id,
    severity: "recommended",
    announce: true,
    affects: `<${version}`,
    title: `Update to Openship ${version}`,
    message: `Openship ${version} is available. See the release notes for what's new — updating is recommended.`,
    action: { label: "Update now", kind: "update" },
  };
  return {
    ...entry,
    announce: true,
    severity: opts.critical || entry.severity === "critical" ? "critical" : "recommended",
    ...(opts.message !== undefined ? { message: opts.message } : {}),
    ...(opts.modes?.length ? { modes: [...opts.modes] } : {}),
  };
}
