import { getApiErrorMessage } from "@/lib/api/client";
import { encodeProjectSlug } from "@/utils/repoSlug";

/**
 * The two decisions a "new environment" click makes. Extracted for the same reason
 * `signup-next.ts` was: the page got both of them wrong in ways no type could catch.
 *
 * 1. ON FAILURE it rendered `error.message`. For an `ApiError` that string is
 *    `` `API ${status}: ${statusText}` `` — so the operator saw "API 400: Bad
 *    Request" while the server had been returning an actionable sentence
 *    ("Connect Openship Cloud to use a free subdomain…") in the response body all
 *    along. `getApiErrorMessage` is the existing extractor for exactly that and
 *    simply was not being used here.
 *
 * 2. ON SUCCESS it pushed the project page, which then offered to finish the
 *    half-configured environment the click had just made. A new environment has
 *    nothing deployed, so the only useful destination is the deploy wizard.
 *
 * 3. It built that entry by URL-encoding the project's HUMAN-READABLE slug
 *    ("site-staging"). But `/deploy/[slug]` decodes its segment with
 *    `decodeSlug`, which is base64url — so "site-staging" decoded to nothing,
 *    the wizard set `invalid_url`, and the page rendered
 *    `<ErrorState type="repo-not-found">`: "Repository Not Found", on an
 *    environment whose repo was fine. Every other caller (DraftProjectView,
 *    BuildSettings) encodes first; this one didn't.
 *
 * 4. It sent `?mode=config`, and that is NOT the "new thing" entry — it is the
 *    edit entry. `Sidebar` reads exactly that param to decide its finish button
 *    (`isConfigMode` → `handleSave`, `startDeployment({ saveConfigOnly: true })`,
 *    label "Save changes", and the cloud/clone/domain deploy gates skipped),
 *    then returns to the Runtime tab. So creating an environment landed the user
 *    in a screen that could only save and go back — never deploy the environment
 *    they had just asked for.
 *
 *    `DraftProjectView` already draws the line this got wrong: `goToConfig` uses
 *    `?mode=config` for "edit my settings", while `handleDeploy` — the button a
 *    never-deployed project actually needs — pushes the bare
 *    `/deploy/{encodeProjectSlug(id)}` with NO mode, so the wizard hydrates from
 *    the saved rows and its finish button stays "Deploy". A just-created
 *    environment is a draft, so it takes the draft's deploy entry.
 */

/**
 * The wizard entry for an environment that exists but has never deployed.
 *
 * Deliberately mode-less. The project-slug path hydrates from the DB rows
 * (`decodeSlug` → `{kind:"project"}` → `initializeFromProject`), so the wizard
 * still opens on the saved config — it just finishes with "Deploy" instead of
 * "Save changes". Same entry `DraftProjectView.handleDeploy` uses.
 */
export function environmentWizardHref(env: { id: string; projectSlug?: string }): string {
  return `/deploy/${encodeProjectSlug(env.id)}`;
}

/** What to show the operator when the create is refused — the SERVER's reason. */
export function environmentErrorMessage(error: unknown, fallback: string): string {
  return getApiErrorMessage(error, fallback);
}
