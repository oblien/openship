/**
 * May this project route `mail.<domain>` — the mail server's own hostname?
 *
 * The mail install records `mail.<base>` as a domain row with `ownerType='mail'` and
 * `project_id = NULL`, purely so the renewal sweep can find the certificate
 * (`recordMailCertDomain`). Nothing owns it in the project sense, and the two hijack
 * guards both compare `owner.projectId !== projectId` — which `NULL` never satisfies. So
 * no project could ever claim a mail-owned hostname, including the webmail the mail
 * module itself deploys onto that exact host (issue #566). The install died with "already
 * connected to another project"; the deploy skipped the route and left the container
 * running with no vhost.
 *
 * Deploying webmail on `mail.<domain>` is the sanctioned configuration — same box, same
 * certificate, no second DNS record, no port conflict (mail is on 25/465/587/143/993,
 * webmail on 443). This is the one predicate that says so.
 *
 * ROUTE IT, OWN NOTHING. A caller that gets `true` registers the vhost and creates NO
 * domain row: the mail row keeps `ownerType='mail', project_id=NULL`. That is not
 * tidiness, it is the whole safety argument. `domain.project_id` cascades on project
 * delete, so stamping this project onto the mail row would make deleting the webmail
 * delete the mail host's only renewal record — silent IMAP/SMTP TLS expiry about 90 days
 * later, with no hook anywhere to restore it.
 *
 * THE LINK IS THE AUTHORIZATION. `mail_servers.webmail_project_id` must already point at
 * the claiming project; a webmail-shaped project is not enough, because "some project in
 * this org that looks like a webmail" would let an ordinary service edit take over the
 * mail hostname. The webmail installer therefore stamps that link BEFORE it applies the
 * mail-host route (see `runWebmailInstall`), which is also what keeps the box correct:
 * `startWebmailDeploy` refuses `mail.<domain>` on any server other than the mail server
 * itself, so the only project that can hold the link is one deploying onto that box.
 */

import { mailHostBaseDomain } from "@repo/core";
import { repos } from "@repo/db";
import type { Domain } from "@repo/db";

import { MAIL_DOMAIN_OWNER } from "./domain-ssl";

/**
 * True when `hostname` is the mail host of a mail server whose webmail IS this project.
 *
 * Never throws: it is consulted on the way to an error, and a failed lookup must leave
 * the caller's existing refusal in place rather than replace it with a 500.
 *
 * @param row The already-fetched domain row for this hostname, when the caller has one.
 *   Pass it to avoid a second query. Its absence is legitimate — `recordMailCertDomain`
 *   is best-effort, so the mail row can be missing, and this must still answer `true`
 *   there or the caller mints a project-owned row for the mail host and the next mail
 *   install refuses to record the certificate against it.
 */
export async function mailHostRoutableByProject(
  hostname: string,
  projectId: string,
  row?: Domain | null,
): Promise<boolean> {
  try {
    // `mailHostBaseDomain` (@repo/core) rather than a local `/^mail\./` strip: the mail
    // host label is defined once, and the build and the parse derive from the same
    // constant. A private regex here is how a prefix change makes this predicate
    // silently answer `false` and webmail-on-the-mail-host stops routing with no error.
    const base = mailHostBaseDomain(hostname);
    if (!base) return false;

    // A row that exists must be the mail install's own. Another project's row is a real
    // conflict, and a project-owned row for this host means someone already minted what
    // this predicate exists to prevent — either way, not ours to route.
    if (row && (row.ownerType !== MAIL_DOMAIN_OWNER || row.projectId !== null)) return false;

    const mail = await repos.mailServer.findByDomain(base);
    if (!mail || mail.webmailProjectId !== projectId) return false;

    // Org authority comes from the SERVER row, never from the link alone: the link is a
    // pointer the mail module writes, and a cross-org pointer must not authorize a route.
    const [server, project] = await Promise.all([
      repos.server.get(mail.serverId),
      repos.project.findById(projectId),
    ]);
    if (!server?.organizationId || !project) return false;
    return server.organizationId === project.organizationId;
  } catch {
    return false;
  }
}
