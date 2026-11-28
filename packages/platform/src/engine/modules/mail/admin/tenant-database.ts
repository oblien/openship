import { managedMailNamespacePattern } from "@repo/contracts/managed-mail";
import { execute, q } from "./psql-runner";

const customer = "openship_mail_customer";
const owned = "IN (SELECT domain FROM public.openship_domain_owner WHERE namespace = session_user::text)";
const ownDomain = `domain ${owned}`;
const mailboxAddress = "username ~ '^[^@/]+@[^@/]+$' AND split_part(username, '@', 2) = domain";
const mailboxPath = "split_part(maildir, '/', 1) = domain AND maildir ~ '^[^/]+/[^/]+(/[^/]+)*/?$' AND maildir !~ '(^|/)[.]{1,2}(/|$)'";
const quotaOwner = `split_part(username, '@', 2) ${owned}`;

// RLS policies bound to session_user also apply if a login assumes its group role.
// Grant only the columns the worker writes. In particular, a tenant cannot change
// a domain's transport or grant an administrator flag to an existing mailbox.
const tables = [
  {
    table: "openship_domain_owner", read: "namespace = session_user::text",
    privileges: "SELECT",
  },
  {
    table: "domain", read: ownDomain,
    privileges: "SELECT (domain, description, mailboxes, aliases, maxquota, active, created), INSERT (domain, description, mailboxes, aliases, maxquota, active, created, modified), UPDATE (description, mailboxes, aliases, maxquota, active, modified), DELETE",
  },
  {
    table: "mailbox", read: `${ownDomain} AND ${mailboxAddress}`,
    check: `${ownDomain} AND ${mailboxAddress} AND ${mailboxPath}
      AND storagebasedirectory = '/var/vmail' AND storagenode = 'vmail1'
      AND mailboxformat = 'maildir' AND mailboxfolder = 'Maildir' AND isadmin = 0 AND isglobaladmin = 0`,
    privileges: `SELECT (username, name, domain, quota, storagebasedirectory, storagenode, maildir, active, isadmin, isglobaladmin, created, passwordlastchange),
      INSERT (username, password, name, domain, quota, storagebasedirectory, storagenode, maildir, mailboxformat, mailboxfolder,
        enablesmtp, enablesmtpsecured, enableimap, enableimapsecured, enableimaptls, enablepop3, enablepop3secured, enablepop3tls,
        enabledeliver, enablelda, enablelmtp, enablemanagesieve, enablemanagesievesecured, enablesieve, enablesievesecured, enablesievetls,
        enableinternal, enabledoveadm, enabledsync, enablesogo, active, isadmin, isglobaladmin, created, modified, passwordlastchange),
      UPDATE (name, quota, active, password, passwordlastchange, modified), DELETE`,
  },
  {
    table: "forwardings", read: ownDomain,
    check: `${ownDomain} AND (address = domain OR (address ~ '^[^@/]+@[^@/]+$' AND split_part(address, '@', 2) = domain))
      AND forwarding ~ '^[^@/]+@[^@/]+$' AND split_part(forwarding, '@', 2) = dest_domain AND dest_domain ${owned}`,
    privileges: "SELECT, INSERT (address, forwarding, domain, dest_domain, is_maillist, is_list, is_forwarding, is_alias, active), UPDATE (active), DELETE",
  },
  { table: "used_quota", read: quotaOwner, privileges: "SELECT (username, bytes, messages), DELETE" },
  { table: "last_login", read: quotaOwner, privileges: "SELECT (username), DELETE" },
  {
    table: "deleted_mailboxes", read: ownDomain, check: `${ownDomain} AND ${mailboxAddress} AND ${mailboxPath}`,
    privileges: "SELECT (domain, username), INSERT (username, domain, maildir, admin, delete_date), DELETE",
  },
  { table: "domain_admins", read: ownDomain, privileges: "SELECT (domain), DELETE" },
];

// Database dumps include policy and grant references, while the role itself is
// cluster-local. Restore the same unprivileged group on a fresh sidecar.
export const ensureMailCustomerGroupSql = `DO $mail_group$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${customer}') THEN
    CREATE ROLE ${customer} NOLOGIN;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${customer}'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = '${customer}'::regrole)
    THEN RAISE EXCEPTION 'Unexpected privileges on shared mail group'; END IF;
END $mail_group$`;

function installPolicies() {
  return tables.map(({table, read, check, privileges}) => `
    ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY mail_customer ON public.${table} TO ${customer} USING (${read}) WITH CHECK (${check ?? read});
    ${table === "openship_domain_owner" ? "REVOKE ALL ON public.openship_domain_owner FROM PUBLIC, vmailadmin;" :
      `CREATE POLICY mail_daemon ON public.${table} TO vmail, vmailadmin USING (true) WITH CHECK (true);`}
    GRANT ${privileges} ON public.${table} TO ${customer};
  `).join("\n");
}

/** Operator-only enrollment on the PostgreSQL sidecar, including existing grants.
 * One transaction installs host policies before a customer login can be used. */
export function tenantDatabaseEnrollmentSql(namespace: string) {
  if (!managedMailNamespacePattern.test(namespace)) throw new Error("Invalid shared mail namespace.");
  return `BEGIN;
    SET LOCAL search_path = pg_catalog, public;
    SELECT pg_advisory_xact_lock(804028193);
    CREATE TABLE IF NOT EXISTS public.openship_mail_db_version (version int PRIMARY KEY);
    REVOKE ALL ON public.openship_mail_db_version FROM PUBLIC, vmailadmin;
    ${ensureMailCustomerGroupSql};
    DO ${q(`BEGIN
      IF NOT EXISTS (SELECT FROM public.openship_mail_db_version WHERE version = 1) THEN
        ${installPolicies()}
        GRANT USAGE ON SEQUENCE public.forwardings_id_seq, public.deleted_mailboxes_id_seq TO ${customer};
        INSERT INTO public.openship_mail_db_version VALUES (1);
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${q(namespace)}) THEN
        CREATE ROLE "${namespace}" LOGIN;
        GRANT ${customer} TO "${namespace}";
      END IF;
      IF NOT pg_has_role(${q(namespace)}, '${customer}', 'USAGE')
        OR has_schema_privilege(${q(namespace)}, 'public', 'CREATE')
        OR EXISTS (SELECT FROM pg_roles WHERE rolname IN ('${customer}', ${q(namespace)})
          AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
        OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname IN ('${customer}', ${q(namespace)}) AND
            (m.roleid <> '${customer}'::regrole OR m.admin_option))
        THEN RAISE EXCEPTION 'Unexpected privileges on shared mail login'; END IF;
    END`)};
    COMMIT;`;
}

export async function ensureTenantDatabase(serverId: string, namespace: string) {
  await execute(serverId, tenantDatabaseEnrollmentSql(namespace));
}
