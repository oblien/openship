// ── Containerized mail engine ────────────────────────────────────────────────
//
// The mail engine (Postfix/Dovecot/Amavis/ClamAV/SpamAssassin/iRedAPD/fail2ban,
// under s6) runs as a host-networked container beside `openship-edge`, with its
// vmail database in a pinned `postgres:16-alpine` SIDECAR. This mirrors the edge's
// container model (`openresty-lua.ts` EDGE_CONTAINER_MOUNTS / EDGE_HOST_PATHS):
// raw `docker run` over the target executor, ALL mutable state on host bind mounts
// (never named volumes) so host tooling — the admin layer's `exec.writeFile`, cert
// readers, backup tar — keeps working and an image pull never touches data.
//
// Why host networking (not bridge + published ports): a bridge userland-proxy
// SNATs the client source IP to the docker gateway, which silently defeats
// Postfix RBL/greylisting, iRedAPD throttling, and fail2ban (they'd see one
// internal IP for every connection) and breaks PTR/SPF alignment on egress. Host
// net preserves the real client IP. fail2ban then needs NET_ADMIN to touch the
// host firewall from inside the container.

/** The mail engine container, and its Postgres sidecar. */
export const MAIL_CONTAINER = "openship-mail";
export const MAIL_DB_CONTAINER = "openship-mail-db";

/** Root for mail state on the host. Siblings the edge's /var/lib/openship/edge. */
export const MAIL_HOST_STATE_DIR = "/var/lib/openship/mail";

/**
 * The listening ports the engine binds on the host NIC. Used to open the inbound
 * firewall and to verify the container is actually serving after launch.
 *   25  SMTP (inbound MX)      465 SMTPS       587 submission
 *   143 IMAP+STARTTLS          993 IMAPS
 *   110 POP3   995 POP3S       4190 ManageSieve
 */
export const MAIL_PORTS = [25, 465, 587, 143, 993, 110, 995, 4190] as const;

export interface MailMount {
  host: string;
  container: string;
  /** Mounted read-only (the shared cert store — the engine only reads it). */
  readonly?: boolean;
  /**
   * The entrypoint must seed this mount from the image's baked defaults when it's
   * empty on first boot, then never overwrite operator edits. True for config dirs
   * we bind-mount whole (so the baked config isn't hidden by an empty host dir);
   * false for pure data dirs (maildir, queue, keys, DB).
   */
  seed?: boolean;
}

/**
 * Engine state on the HOST and where it mounts in the container. Bind mounts only.
 *
 * `/etc/letsencrypt` keeps the SAME path on both sides and is SHARED (read-only)
 * with the edge that issues the cert — the engine's Postfix/Dovecot read
 * `/etc/letsencrypt/live/mail.<domain>/…` directly, no symlink dance.
 */
export const MAIL_CONTAINER_MOUNTS: ReadonlyArray<MailMount> = [
  { host: `${MAIL_HOST_STATE_DIR}/vmail`, container: "/var/vmail" },
  // The Postfix queue. A recreate on an ephemeral layer would drop in-flight and
  // deferred mail without this — keep it on the host.
  { host: `${MAIL_HOST_STATE_DIR}/spool`, container: "/var/spool/postfix" },
  // DKIM private keys. NEVER baked, never regenerated on pull — a fresh selector
  // breaks DMARC until DNS repropagates.
  { host: `${MAIL_HOST_STATE_DIR}/dkim`, container: "/var/lib/dkim" },
  // Mutable daemon config the admin layer edits (sasl_passwd, relayhost maps,
  // amavis 50-user). Seeded from baked defaults on first boot.
  { host: `${MAIL_HOST_STATE_DIR}/config/postfix`, container: "/etc/postfix", seed: true },
  { host: `${MAIL_HOST_STATE_DIR}/config/dovecot`, container: "/etc/dovecot", seed: true },
  { host: `${MAIL_HOST_STATE_DIR}/config/amavis`, container: "/etc/amavis/conf.d", seed: true },
  // ClamAV signatures — bind-mounted so a pull doesn't force a multi-hundred-MB
  // freshclam re-download and delay readiness.
  { host: `${MAIL_HOST_STATE_DIR}/clamav`, container: "/var/lib/clamav" },
  { host: "/etc/letsencrypt", container: "/etc/letsencrypt", readonly: true },
];

/**
 * The Postgres sidecar's data dir on the host. PGDATA points at the `pgdata`
 * SUBDIR of the mount (the postgres:16-alpine convention — a fresh dir initializes
 * cleanly, and a pre-existing one is reused) so the mount root can hold other
 * bookkeeping without confusing initdb.
 */
export const MAIL_DB_HOST_DATA_DIR = `${MAIL_HOST_STATE_DIR}/pgdata`;
export const MAIL_DB_CONTAINER_DATA_DIR = "/var/lib/postgresql/data";
export const MAIL_DB_PGDATA = `${MAIL_DB_CONTAINER_DATA_DIR}/pgdata`;
export const MAIL_DB_NAME = "vmail";
export const MAIL_DB_USER = "vmail";
/** Loopback only — the host-networked engine reaches it at 127.0.0.1:5432. */
export const MAIL_DB_HOST_BIND = "127.0.0.1";
export const MAIL_DB_PORT = 5432;

/**
 * Host-side paths for the files the admin layer writes with `exec.writeFile`
 * (SFTP, no shell — preserves the SASL-password security invariant). These are the
 * HOST sides of the bind mounts above, so a write lands inside the container FS;
 * the matching `postmap`/reload then runs via `docker exec` (the .db is built by
 * the container's Postfix). Mirrors EDGE_HOST_PATHS' deliberate host/container mix.
 */
export const MAIL_HOST_PATHS = {
  saslPasswd: `${MAIL_HOST_STATE_DIR}/config/postfix/sasl_passwd`,
  senderRelayhost: `${MAIL_HOST_STATE_DIR}/config/postfix/sender_relayhost`,
  amavisUserConf: `${MAIL_HOST_STATE_DIR}/config/amavis/50-user`,
} as const;
