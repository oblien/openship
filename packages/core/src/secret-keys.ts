/**
 * "Does this environment variable's NAME say it holds a credential?"
 *
 * Used when env vars arrive in bulk with no per-variable intent attached — a pasted
 * `.env`, an uploaded file, a CLI deploy. Those paths stored every variable with
 * `isSecret: false`, so an `OPENAI_API_KEY` or a `DATABASE_URL` carrying a password was
 * flagged an ordinary value: returned in cleartext by `GET /projects/:id/env` and
 * rendered as readable text in the editor, to anyone with project read access (#587).
 *
 * A NAME is the only signal available at that point, so this is a heuristic and is
 * treated as one: it decides the DEFAULT for a variable nobody has classified yet, and
 * the editor's per-row secret toggle always wins. Callers must therefore preserve an
 * existing variable's stored flag rather than re-deriving it, or a later deploy would
 * silently overturn an operator's explicit choice.
 *
 * Deliberately biased toward marking things secret. A false positive costs one click to
 * undo and leaks nothing; a false negative publishes a live credential.
 *
 * HOW IT MATCHES: the key is normalized to space-delimited WORDS (`apiKey` → `API KEY`,
 * `SSH_KEY_PATH` → `SSH KEY PATH`) and every pattern is anchored on those spaces. Not
 * `\b` — `_` is a regex word character, so `\bPUBLIC\b` does not match inside
 * `_PUBLIC_KEY_` and every exclusion written that way silently never fires.
 */

/**
 * Words that mean "credential" on their own, whatever else the name says.
 *
 * These beat the exclusions below: `AWS_ACCESS_KEY_ID_SECRET` is a secret even though
 * `KEY ID` would otherwise clear it.
 */
const ALWAYS_SECRET = [
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "PRIVATEKEY",
  "APIKEY",
];

/**
 * Words that usually mean "credential" but are commonly reused to name something that
 * merely relates to one — so these are subject to {@link NOT_SECRET}.
 */
const USUALLY_SECRET = [
  "KEY",
  "TOKEN",
  "AUTH",
  "PASS",
  "SALT",
  "SIGNATURE",
  "CERT",
  "DSN",
];

/**
 * Names that contain a {@link USUALLY_SECRET} word but hold no credential — the
 * exclusions that keep the deliberate bias from becoming noise.
 *
 * `PUBLIC_KEY` is published by definition. A `_PATH`/`_FILE`/`_DIR` names a location on
 * disk, not the material. `KEY_PREFIX`/`KEY_ID` name an identifier. `AUTH_URL` and
 * `AUTH_ENABLED` configure where and whether to authenticate. `TOKEN_TTL` is a duration.
 */
const NOT_SECRET = [
  / PUBLIC /,
  / (PATH|FILE|FILEPATH|DIR|DIRECTORY|LOCATION) /,
  / KEY (PREFIX|ID|NAME|ALIAS|LENGTH|SIZE|ALGORITHM|ALGO|TYPE|VERSION) /,
  / AUTH (URL|URI|DOMAIN|HOST|PORT|ENABLED|DISABLED|MODE|TYPE|PROVIDER|REALM|METHOD|STRATEGY) /,
  / (TOKEN|SESSION|CACHE) (TTL|EXPIRY|EXPIRES|EXPIRATION|LIFETIME|TIMEOUT|MAX|MIN|WINDOW) /,
  / (ENABLE|ENABLED|DISABLE|DISABLED|REQUIRE|REQUIRED|VERIFY|USE|SKIP) /,
];

/**
 * Connection strings, whose values routinely embed `user:password@`.
 *
 * Checked FIRST and exempt from the exclusions: a `DATABASE_URL` is a credential, and
 * the `_URL`-adjacent rules would otherwise clear it.
 */
const CONNECTION_STRING = [
  / (DATABASE|DB|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MONGO|MONGODB|REDIS|AMQP|RABBITMQ|KAFKA|CLICKHOUSE|ELASTIC|ELASTICSEARCH|SMTP|BROKER) (URL|URI|CONNECTION|CONNECTIONSTRING|DSN) /,
  / CONNECTION STRING /,
];

/** `SSH_KEY_PATH` → ` SSH KEY PATH `, `apiKey` → ` API KEY `. Padded so every pattern
 *  can anchor on a leading and trailing space without special-casing the ends. */
function normalize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // split camelCase before folding case
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return ` ${spaced} `;
}

/**
 * True when `key` names a credential and should default to `isSecret: true`.
 *
 * Only the NAME is inspected — never the value, which may legitimately be short,
 * numeric or empty.
 */
export function looksLikeSecretKey(key: string): boolean {
  const words = normalize(key);
  if (words.trim() === "") return false;

  // Unpunctuated forms `normalize` cannot split: `APIKEY`, `PRIVATEKEY`. Only applied to
  // the unambiguous long words, so `PASSENGER_COUNT` never matches `PASS`.
  const compact = key.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();

  for (const re of CONNECTION_STRING) {
    if (re.test(words)) return true;
  }

  for (const word of ALWAYS_SECRET) {
    if (words.includes(` ${word} `)) return true;
    if (word.length >= 6 && compact.includes(word)) return true;
  }

  for (const re of NOT_SECRET) {
    if (re.test(words)) return false;
  }

  for (const word of USUALLY_SECRET) {
    if (words.includes(` ${word} `)) return true;
  }

  return false;
}
