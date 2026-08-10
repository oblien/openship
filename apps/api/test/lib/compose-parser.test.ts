import { describe, expect, it } from "vitest";
import { parseComposeEnvFile, parseComposeFile } from "../../src/lib/compose-parser";

describe("parseComposeFile", () => {
  it("resolves Docker Compose environment interpolation from .env content", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    image: node:\${NODE_VERSION:-22}
    environment:
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:-change-me-in-production}
      DATABASE_URL: postgres://\${POSTGRES_USER:-postgres}:\${POSTGRES_PASSWORD:-postgres}@db:5432/app
      EMPTY_DEFAULT: \${EMPTY_VALUE:-fallback}
      EMPTY_NO_COLON: \${EMPTY_VALUE-fallback}
`,
      {
        envFileContent: `
NODE_VERSION=20
BETTER_AUTH_SECRET=from-env
POSTGRES_USER=openship
POSTGRES_PASSWORD=secret
EMPTY_VALUE=
`,
      },
    );

    expect(parsed.services[0]?.image).toBe("node:20");
    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "from-env",
      DATABASE_URL: "postgres://openship:secret@db:5432/app",
      EMPTY_DEFAULT: "fallback",
      EMPTY_NO_COLON: "",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "env-file",
      variable: "BETTER_AUTH_SECRET",
      resolvedValue: "from-env",
    });
    expect(parsed.services[0]?.environmentMeta?.EMPTY_DEFAULT).toMatchObject({
      source: "default",
      variable: "EMPTY_VALUE",
      defaultValue: "fallback",
      resolvedValue: "fallback",
    });
  });

  it("uses compose defaults when .env does not define the variable", () => {
    const parsed = parseComposeFile(`
services:
  app:
    environment:
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:-change-me-in-production}
      GOOGLE_GENERATIVE_AI_API_KEY: \${GOOGLE_GENERATIVE_AI_API_KEY}
      GEMINI_MODEL: \${GEMINI_MODEL:-gemini-2.5-flash}
      PLAIN_MISSING: \${PLAIN_MISSING}
`);

    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "change-me-in-production",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_MODEL: "gemini-2.5-flash",
      PLAIN_MISSING: "",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "default",
      variable: "BETTER_AUTH_SECRET",
      defaultValue: "change-me-in-production",
      resolvedValue: "change-me-in-production",
    });
    expect(parsed.services[0]?.environmentMeta?.PLAIN_MISSING).toMatchObject({
      source: "missing",
      variable: "PLAIN_MISSING",
      resolvedValue: "",
    });
    expect(parsed.services[0]?.environmentMeta?.GOOGLE_GENERATIVE_AI_API_KEY).toMatchObject({
      source: "missing",
      variable: "GOOGLE_GENERATIVE_AI_API_KEY",
      resolvedValue: "",
    });
    expect(parsed.services[0]?.environmentMeta?.GEMINI_MODEL).toMatchObject({
      source: "default",
      variable: "GEMINI_MODEL",
      defaultValue: "gemini-2.5-flash",
      resolvedValue: "gemini-2.5-flash",
    });
  });

  it("supports array env form and bare keys loaded from .env", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    environment:
      - BETTER_AUTH_SECRET
      - NODE_ENV=\${NODE_ENV:-production}
`,
      {
        envFileContent: `
BETTER_AUTH_SECRET=from-env
NODE_ENV=development
`,
      },
    );

    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "from-env",
      NODE_ENV: "development",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "env-file",
      variable: "BETTER_AUTH_SECRET",
      resolvedValue: "from-env",
    });
  });

  it("keeps escaped dollars literal", () => {
    const parsed = parseComposeFile(`
services:
  app:
    command: echo $$BETTER_AUTH_SECRET
    environment:
      LITERAL: $$BETTER_AUTH_SECRET
`);

    expect(parsed.services[0]?.command).toBe("echo $BETTER_AUTH_SECRET");
    expect(parsed.services[0]?.environment.LITERAL).toBe("$BETTER_AUTH_SECRET");
  });

  it("does not re-interpolate a '$' inside a resolved value embedded in a larger string", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    environment:
      DIRECT: \${DB_PASS}
      EMBEDDED: postgres://user:\${DB_PASS}@db:5432/app
`,
      { envFileContent: `DB_PASS='p$ss'\n` },
    );

    expect(parsed.services[0]?.environment).toEqual({
      DIRECT: "p$ss",
      EMBEDDED: "postgres://user:p$ss@db:5432/app",
    });
  });
});

// ─── parseComposeEnvFile - direct .env content scenarios ─────────────────────

describe("parseComposeEnvFile - quoting, escapes, comments, edge cases", () => {
  it("parses simple KEY=value lines", () => {
    expect(parseComposeEnvFile("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and comments", () => {
    expect(parseComposeEnvFile(`
# A leading comment
FOO=bar

  # An indented comment
BAZ=qux
`)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips trailing inline comments outside quotes", () => {
    expect(parseComposeEnvFile(`URL=https://example.com   # the api`)).toEqual({
      URL: "https://example.com",
    });
  });

  it("preserves '#' inside double-quoted values", () => {
    expect(parseComposeEnvFile(`PWD="p@ss#word"`)).toEqual({ PWD: "p@ss#word" });
  });

  it("preserves '#' inside single-quoted values (no escape processing)", () => {
    expect(parseComposeEnvFile(`PWD='p@ss#word'`)).toEqual({ PWD: "p@ss#word" });
  });

  it("decodes common escape sequences inside double-quoted values", () => {
    expect(parseComposeEnvFile(`MSG="line1\\nline2\\ttab"`)).toEqual({
      MSG: "line1\nline2\ttab",
    });
  });

  it("does NOT process escapes inside single-quoted values", () => {
    expect(parseComposeEnvFile(`MSG='line1\\nline2'`)).toEqual({ MSG: "line1\\nline2" });
  });

  it("treats an escaped backslash as a literal `\\` before the next char", () => {
    expect(parseComposeEnvFile(String.raw`WINPATH="C:\\nginx\\conf"`)).toEqual({
      WINPATH: "C:\\nginx\\conf",
    });
    expect(parseComposeEnvFile(String.raw`X="a\\nb"`)).toEqual({ X: "a\\nb" });
    expect(parseComposeEnvFile(String.raw`Y="a\nb"`)).toEqual({ Y: "a\nb" });
  });

  it("accepts 'export' prefix (POSIX shell convention)", () => {
    expect(parseComposeEnvFile(`export FOO=bar\nexport BAZ="qux qux"`)).toEqual({
      FOO: "bar",
      BAZ: "qux qux",
    });
  });

  it("strips UTF-8 BOM from the start of the file", () => {
    expect(parseComposeEnvFile(`﻿FOO=bar`)).toEqual({ FOO: "bar" });
  });

  it("rejects keys that don't start with a letter or underscore", () => {
    // POSIX env var rules: must start with [A-Za-z_], rest [A-Za-z0-9_].
    expect(parseComposeEnvFile(`9FOO=bar\nFOO-BAR=baz\nfoo bar=baz`)).toEqual({});
  });

  it("accepts keys starting with underscore", () => {
    expect(parseComposeEnvFile(`_PRIVATE=val\n__DOUBLE=val`)).toEqual({
      _PRIVATE: "val",
      __DOUBLE: "val",
    });
  });

  it("treats empty values as empty strings, not missing", () => {
    expect(parseComposeEnvFile(`EMPTY=\nFOO=bar`)).toEqual({ EMPTY: "", FOO: "bar" });
  });

  it("interpolates ${VAR} between entries (second uses the first)", () => {
    expect(parseComposeEnvFile(`BASE=foo\nFULL=\${BASE}-bar`)).toEqual({
      BASE: "foo",
      FULL: "foo-bar",
    });
  });

  it("interpolates $VAR (bare) between entries", () => {
    expect(parseComposeEnvFile(`BASE=foo\nFULL=$BASE-bar`)).toEqual({
      BASE: "foo",
      FULL: "foo-bar",
    });
  });

  it("does NOT interpolate inside single-quoted values (literal)", () => {
    expect(parseComposeEnvFile(`BASE=foo\nA='$BASE-bar'\nB='\${BASE}-bar'`)).toEqual({
      BASE: "foo",
      A: "$BASE-bar",
      B: "${BASE}-bar",
    });
  });

  it("does not re-interpolate a literal '$' carried in by an interpolated entry", () => {
    expect(parseComposeEnvFile(`PW='a$bc'\nURL=x\${PW}y`)).toEqual({
      PW: "a$bc",
      URL: "xa$bcy",
    });
  });

  it("keeps '$$' literal inside single-quoted values (no un-escaping)", () => {
    expect(parseComposeEnvFile(`PWD='p@$$w0rd'`)).toEqual({ PWD: "p@$$w0rd" });
  });

  it("handles CRLF line endings", () => {
    expect(parseComposeEnvFile("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores lines without '=' (no implicit value-from-env)", () => {
    expect(parseComposeEnvFile(`SOLO_KEY\nFOO=bar`)).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around keys but preserves intentional value content", () => {
    expect(parseComposeEnvFile(`  KEY  =  value with trailing\nNEXT=ok`)).toEqual({
      KEY: "value with trailing",
      NEXT: "ok",
    });
  });

  it("returns empty object for empty or whitespace-only input", () => {
    expect(parseComposeEnvFile("")).toEqual({});
    expect(parseComposeEnvFile("\n\n   \n")).toEqual({});
  });

  it("parses a quoted value that spans multiple lines", () => {
    expect(
      parseComposeEnvFile(
        'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\n-----END PRIVATE KEY-----"\nNODE_ENV=production',
      ),
    ).toEqual({
      JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\n-----END PRIVATE KEY-----",
      NODE_ENV: "production",
    });
  });

  it("does not treat a KEY=value line inside a quoted block as its own entry", () => {
    expect(
      parseComposeEnvFile(
        'CERT="-----BEGIN CERTIFICATE-----\nKEY=notreallyakey\n-----END CERTIFICATE-----"',
      ),
    ).toEqual({
      CERT: "-----BEGIN CERTIFICATE-----\nKEY=notreallyakey\n-----END CERTIFICATE-----",
    });
  });

  it("interpolates inside a multi-line double-quoted value but not a single-quoted one", () => {
    expect(parseComposeEnvFile("BASE=foo\nD=\"a\n${BASE}\nb\"\nS='a\n${BASE}\nb'")).toEqual({
      BASE: "foo",
      D: "a\nfoo\nb",
      S: "a\n${BASE}\nb",
    });
  });

  it("falls back to single-line parsing when a quote is never closed", () => {
    expect(parseComposeEnvFile('BLOCK="never closed\nAFTER=ok')).toEqual({
      BLOCK: "never closed",
      AFTER: "ok",
    });
  });

  it("realistic project .env - database, secrets, runtime config", () => {
    const result = parseComposeEnvFile(`
# Database
DATABASE_URL=postgres://user:pass@db:5432/app
DATABASE_POOL_SIZE=20

# Auth secrets - change in production
SESSION_SECRET="a-long-random-string-with-special-#chars"
JWT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\\nAB...XY=='

# Runtime
NODE_ENV=production
LOG_LEVEL=info
PORT=4000
`);
    expect(result.DATABASE_URL).toBe("postgres://user:pass@db:5432/app");
    expect(result.DATABASE_POOL_SIZE).toBe("20");
    expect(result.SESSION_SECRET).toBe("a-long-random-string-with-special-#chars");
    expect(result.JWT_PRIVATE_KEY).toBe("-----BEGIN PRIVATE KEY-----\\nAB...XY==");
    expect(result.NODE_ENV).toBe("production");
    expect(result.PORT).toBe("4000");
  });
});

// ─── parseComposeFile - service surface area we rely on ──────────────────────

describe("parseComposeFile - service shape extraction", () => {
  it("extracts build context and dockerfile paths", () => {
    const parsed = parseComposeFile(`
services:
  api:
    build:
      context: ./services/api
      dockerfile: Dockerfile.prod
  worker:
    build: ./services/worker
`);
    expect(parsed.services).toHaveLength(2);
    const api = parsed.services.find((s) => s.name === "api");
    const worker = parsed.services.find((s) => s.name === "worker");
    expect(api?.build).toBe("./services/api");
    expect(api?.dockerfile).toBe("Dockerfile.prod");
    expect(worker?.build).toBe("./services/worker");
  });

  it("extracts image-only services (no build, just image)", () => {
    const parsed = parseComposeFile(`
services:
  cache:
    image: redis:7-alpine
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
`);
    const cache = parsed.services.find((s) => s.name === "cache");
    const db = parsed.services.find((s) => s.name === "db");
    expect(cache?.image).toBe("redis:7-alpine");
    expect(cache?.build).toBeUndefined();
    expect(db?.image).toBe("postgres:16");
    expect(db?.environment).toEqual({ POSTGRES_DB: "app" });
  });

  it("extracts ports in short syntax (HOST:CONTAINER)", () => {
    const parsed = parseComposeFile(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
      - "443:443"
`);
    expect(parsed.services[0]?.ports).toEqual(["80:80", "443:443"]);
  });

  it("folds long-form `host_ip` into the leading `<ip>:` (loopback publish stays private)", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres
    ports:
      - target: 5432
        host_ip: 127.0.0.1
        published: 5432
      - target: 80
        host_ip: 127.0.0.1
        published: 8080
        protocol: tcp
`);
    // Dropping host_ip would collapse these to "5432:5432" / "8080:80", which
    // bind 0.0.0.0 — publishing to the whole internet a service the config
    // pinned to loopback. The ip must survive as the leading short-form segment
    // that the docker runtime honors ("127.0.0.1:8080:80").
    expect(parsed.services[0]?.ports).toEqual(["127.0.0.1:5432:5432", "127.0.0.1:8080:80"]);
  });

  it("keeps host_ip when published is omitted, and omits it when absent", () => {
    const parsed = parseComposeFile(`
services:
  x:
    image: nginx
    ports:
      - target: 80
        host_ip: 127.0.0.1
      - target: 443
        published: 8443
      - target: 53
        host_ip: 0.0.0.0
        published: 53
        protocol: udp
`);
    // host_ip with no published → ip-scoped random host port ("127.0.0.1::80");
    // published with no host_ip → unchanged; protocol suffix still applies.
    expect(parsed.services[0]?.ports).toEqual(["127.0.0.1::80", "8443:443", "0.0.0.0:53:53/udp"]);
  });

  it("extracts depends_on as array", () => {
    const parsed = parseComposeFile(`
services:
  api:
    image: myorg/api
    depends_on:
      - db
      - cache
`);
    expect(parsed.services[0]?.dependsOn).toEqual(["db", "cache"]);
  });

  it("extracts restart policy", () => {
    const parsed = parseComposeFile(`
services:
  api:
    image: myorg/api
    restart: unless-stopped
`);
    expect(parsed.services[0]?.restart).toBe("unless-stopped");
  });

  it("extracts a string command as display text AND structured argv (#332)", () => {
    const parsed = parseComposeFile(`
services:
  worker:
    image: node:22
    command: node worker.js --concurrency 4
`);
    expect(parsed.services[0]?.command).toBe("node worker.js --concurrency 4");
    // #332: string is shell-word-split to argv (no implicit sh -c).
    expect(parsed.services[0]?.commandArgv).toEqual(["node", "worker.js", "--concurrency", "4"]);
  });

  it("keeps a LIST command as argv verbatim — not flattened (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: ghcr.io/acme/app:1
    command: ["serve", "--host", "0.0.0.0"]
`);
    // display join for the text column…
    expect(parsed.services[0]?.command).toBe("serve --host 0.0.0.0");
    // …but the structured argv is verbatim, which is what the runtime uses.
    expect(parsed.services[0]?.commandArgv).toEqual(["serve", "--host", "0.0.0.0"]);
  });

  it("preserves an explicit shell command as argv (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: node:22
    command: sh -c "node server.js && tail -f /dev/null"
`);
    expect(parsed.services[0]?.commandArgv).toEqual([
      "sh",
      "-c",
      "node server.js && tail -f /dev/null",
    ]);
  });

  it("no command → no commandArgv (image CMD preserved) (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: node:22
`);
    expect(parsed.services[0]?.command).toBeUndefined();
    expect(parsed.services[0]?.commandArgv == null).toBe(true);
  });

  it("interpolates ${VAR} BEFORE splitting a string command into argv (#332)", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    image: node:22
    command: node app.js --token \${API_TOKEN} --port \${PORT:-3000}
`,
      { envFileContent: "API_TOKEN=abc123\n" },
    );
    // interpolation resolves first, THEN shell-split → argv (no sh -c).
    expect(parsed.services[0]?.commandArgv).toEqual(["node", "app.js", "--token", "abc123", "--port", "3000"]);
  });

  it("empty list command → [] (clears image CMD) (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: redis:7
    command: []
`);
    expect(parsed.services[0]?.commandArgv).toEqual([]);
  });

  it("empty string command → [] (clears image CMD) (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: redis:7
    command: ""
`);
    expect(parsed.services[0]?.commandArgv).toEqual([]);
  });

  it("a list arg with spaces is preserved as ONE argv element (#332)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: node:22
    command: ["node", "-e", "console.log('a b')"]
`);
    expect(parsed.services[0]?.commandArgv).toEqual(["node", "-e", "console.log('a b')"]);
  });

  it("extracts volumes list", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
`);
    expect(parsed.services[0]?.volumes).toEqual([
      "pgdata:/var/lib/postgresql/data",
      "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
    ]);
  });

  it("folds long-form `read_only: true` into a :ro bind (read-only intent survives)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /host/config
        target: /etc/nginx/conf.d
        read_only: true
      - type: volume
        source: cache
        target: /var/cache
`);
    // read_only must produce the ":ro" suffix downstream honors — dropping it
    // would create a writable mount despite the config declaring read-only.
    expect(parsed.services[0]?.volumes).toEqual([
      "/host/config:/etc/nginx/conf.d:ro",
      "cache:/var/cache",
    ]);
  });

  it("folds long-form `bind.selinux` and `volume.nocopy` into their mode suffix", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /host/data
        target: /data
        bind:
          selinux: Z
      - type: volume
        source: cache
        target: /cache
        volume:
          nocopy: true
`);
    // Dropping these would collapse both to their bare "source:target" — the
    // MODE_SUFFIX regex downstream (volume-namespace.ts) already recognizes
    // z/Z/nocopy, same as :ro; the long form just never emitted them.
    expect(parsed.services[0]?.volumes).toEqual(["/host/data:/data:Z", "cache:/cache:nocopy"]);
  });

  it("throws on invalid YAML (callers wrap in try/catch)", () => {
    // An unusable FILE is the only thing parseComposeFile throws for — a missing
    // variable value is reported, not thrown (#472). prepare.service.ts turns this
    // one into "Could not parse the Docker Compose file: …".
    expect(() => parseComposeFile(`this: is: not: valid: yaml`)).toThrow();
  });

  it("returns an empty services array when 'services' key is missing", () => {
    const parsed = parseComposeFile(`version: "3.9"\nnetworks:\n  default:\n`);
    expect(parsed.services).toEqual([]);
  });

  it("resolves `<<` merge keys so an anchored environment block reaches the service", () => {
    const parsed = parseComposeFile(`
x-environment: &shared
  DB_HOST: postgres
  RAILS_ENV: production
  SETTINGS__APP_COMPONENT: base

services:
  web:
    image: app:latest
    environment:
      <<: *shared
      SETTINGS__APP_COMPONENT: web
`);
    // The yaml package parses as YAML 1.2, where `<<` is an ordinary key unless
    // merge support is enabled. Left off, every anchored var is dropped and the
    // unresolved anchor lands as a literal "<<" var stringified to
    // "[object Object]" - which deploy.service.ts then spreads into the
    // container environment. An explicit key still wins over the merged one.
    expect(parsed.services[0]?.environment).toEqual({
      DB_HOST: "postgres",
      RAILS_ENV: "production",
      SETTINGS__APP_COMPONENT: "web",
    });
  });
});

describe("parseComposeFile - mandatory variable operators (:? and ?)", () => {
  // #472: these are a hard stop for `docker compose up`, but this parser only
  // ever INSPECTS a file — during an import scan the user hasn't supplied any
  // values yet. Throwing took the whole repo load down ("Failed to Load
  // Repository: Could not parse the Docker Compose file: set POSTGRES_PASSWORD
  // in .env") with no way to continue, so an unsatisfied mandatory variable is
  // now REPORTED: "" like any other unset variable, flagged `required` per key,
  // and listed in `missingRequired` for the caller to prompt for.
  const compose = (expr: string) => `
services:
  app:
    image: node:\${${expr}}
`;

  it(":? reports instead of throwing when the variable is unset", () => {
    const parsed = parseComposeFile(compose("NODE_VERSION:?NODE_VERSION is required"));
    expect(parsed.services[0]?.image).toBe("node:");
    expect(parsed.missingRequired).toEqual([
      { variable: "NODE_VERSION", message: "NODE_VERSION is required" },
    ]);
  });

  it(":? reports when the variable is set but empty", () => {
    const parsed = parseComposeFile(compose("NODE_VERSION:?NODE_VERSION is required"), {
      envFileContent: "NODE_VERSION=\n",
    });
    expect(parsed.missingRequired.map((m) => m.variable)).toEqual(["NODE_VERSION"]);
  });

  it(":? passes the value through when non-empty, reporting nothing", () => {
    const parsed = parseComposeFile(compose("NODE_VERSION:?NODE_VERSION is required"), {
      envFileContent: "NODE_VERSION=22\n",
    });
    expect(parsed.services[0]?.image).toBe("node:22");
    expect(parsed.missingRequired).toEqual([]);
  });

  it("? reports only when the variable is unset", () => {
    expect(
      parseComposeFile(compose("NODE_VERSION?NODE_VERSION is required")).missingRequired,
    ).toEqual([{ variable: "NODE_VERSION", message: "NODE_VERSION is required" }]);
  });

  it("? accepts an explicitly empty value (set-but-empty is not missing)", () => {
    const parsed = parseComposeFile(compose("NODE_VERSION?NODE_VERSION is required"), {
      envFileContent: "NODE_VERSION=\n",
    });
    expect(parsed.services[0]?.image).toBe("node:");
    expect(parsed.missingRequired).toEqual([]);
  });

  it("keeps the author's message verbatim, punctuation and all", () => {
    expect(parseComposeFile(compose("DB_URL:?DB_URL must be set (see README)")).missingRequired)
      .toEqual([{ variable: "DB_URL", message: "DB_URL must be set (see README)" }]);
  });

  it("flags the env row as required + missing so the wizard can prompt for it", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
`);
    expect(parsed.services[0]?.environment.POSTGRES_PASSWORD).toBe("");
    expect(parsed.services[0]?.environmentMeta?.POSTGRES_PASSWORD).toMatchObject({
      source: "missing",
      variable: "POSTGRES_PASSWORD",
      required: true,
    });
    expect(parsed.missingRequired).toEqual([
      { variable: "POSTGRES_PASSWORD", message: "set POSTGRES_PASSWORD in .env" },
    ]);
  });

  it("reports each required variable once, however many services demand it", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD:?needed}
  api:
    image: api:latest
    environment:
      DATABASE_PASSWORD: \${DB_PASSWORD:?needed}
      API_KEY: \${API_KEY:?also needed}
`);
    expect(parsed.missingRequired.map((m) => m.variable)).toEqual(["DB_PASSWORD", "API_KEY"]);
  });

  it("satisfies a required variable from the caller-supplied env (#383)", () => {
    const parsed = parseComposeFile(compose("NODE_VERSION:?required"), {
      env: { NODE_VERSION: "24" },
    });
    expect(parsed.services[0]?.image).toBe("node:24");
    expect(parsed.missingRequired).toEqual([]);
  });
});

describe("parseComposeFile - nested interpolation expressions", () => {
  const env = (expr: string) => `
services:
  app:
    environment:
      VAL: '${expr}'
`;
  const value = (expr: string, envFileContent = "") =>
    parseComposeFile(env(expr), { envFileContent }).services[0]?.environment.VAL;

  it("uses the variable when it is set, without leaking the nested closing brace", () => {
    expect(value("${SET:-${OTHER}}", "SET=sv\nOTHER=ov\n")).toBe("sv");
  });

  it("resolves a nested default instead of emitting it literally", () => {
    expect(value("${MISSING:-${OTHER}}", "OTHER=ov\n")).toBe("ov");
    expect(value("${EMPTY:-${OTHER}}", "EMPTY=\nOTHER=ov\n")).toBe("ov");
    expect(value("${MISSING-${OTHER}}", "OTHER=ov\n")).toBe("ov");
    expect(value("${EMPTY-${OTHER}}", "EMPTY=\nOTHER=ov\n")).toBe("");
  });

  it("resolves a nested alternate for the :+ and + operators", () => {
    expect(value("${SET:+${OTHER}}", "SET=sv\nOTHER=ov\n")).toBe("ov");
    expect(value("${MISSING:+${OTHER}}", "OTHER=ov\n")).toBe("");
  });

  it("resolves defaults nested more than one level deep", () => {
    expect(value("${A:-${B:-${C}}}", "C=cv\n")).toBe("cv");
    expect(value("${A:-${B:-${C}}}", "B=bv\nC=cv\n")).toBe("bv");
    expect(value("${A:-${B:-fallback}}")).toBe("fallback");
  });

  it("resolves nested expressions embedded in a larger string", () => {
    expect(value("pre-${MISSING:-${OTHER}}-post", "OTHER=ov\n")).toBe("pre-ov-post");
    expect(value("${A:-${X}}/${B:-${Y}}", "X=xv\nY=yv\n")).toBe("xv/yv");
    expect(value("${MISSING:-${OTHER}/sub}", "OTHER=ov\n")).toBe("ov/sub");
  });

  it("treats a bare '{' in a default as a literal, not a nesting level", () => {
    expect(value("${A:-{literal}}")).toBe("{literal}");
    expect(value("${A:-x}y}")).toBe("xy}");
    expect(value("${A:-}}")).toBe("}");
  });

  it("reports a :? message verbatim, WITHOUT interpolating it", () => {
    // The message rides out to the client in a scan response, which is masked
    // precisely so env values can't. Interpolating `${B}` here would smuggle one
    // through the one field nobody thinks of as value-bearing.
    const parsed = parseComposeFile(env("${A:?need ${B}}"), { envFileContent: "B=bv\n" });
    expect(parsed.missingRequired).toEqual([{ variable: "A", message: "need ${B}" }]);
  });

  it("reports the outer variable in environmentMeta for a nested default", () => {
    const parsed = parseComposeFile(env("${MISSING:-${OTHER}}"), { envFileContent: "OTHER=ov\n" });
    expect(parsed.services[0]?.environmentMeta?.VAL).toMatchObject({
      source: "default",
      variable: "MISSING",
      defaultValue: "ov",
      resolvedValue: "ov",
    });
  });
});

// #333: an uploaded compose file's own limits were parsed nowhere and silently
// dropped — a service asking for 4 GB got whatever the project was set to.
describe("parseComposeFile — service resource limits", () => {
  const svc = (body: string) => `services:\n  api:\n    image: nginx\n${body}`;

  it("parses the short form (mem_limit + cpus)", () => {
    const parsed = parseComposeFile(svc("    mem_limit: 4g\n    cpus: 2.5\n"));
    expect(parsed.services[0]?.advanced?.resources).toEqual({ cpuCores: 2.5, memoryMb: 4096 });
  });

  it("parses the swarm form (deploy.resources.limits)", () => {
    const parsed = parseComposeFile(
      svc("    deploy:\n      resources:\n        limits:\n          memory: 3072M\n          cpus: '1.5'\n"),
    );
    expect(parsed.services[0]?.advanced?.resources).toEqual({ cpuCores: 1.5, memoryMb: 3072 });
  });

  it("lets the more specific deploy block win over the short form", () => {
    const parsed = parseComposeFile(
      svc("    mem_limit: 512m\n    deploy:\n      resources:\n        limits:\n          memory: 8g\n"),
    );
    expect(parsed.services[0]?.advanced?.resources?.memoryMb).toBe(8192);
  });

  it("accepts every byte-suffix spelling compose allows", () => {
    const mem = (v: string) =>
      parseComposeFile(svc(`    mem_limit: ${v}\n`)).services[0]?.advanced?.resources?.memoryMb;
    expect(mem("512m")).toBe(512);
    expect(mem("512mb")).toBe(512);
    expect(mem("2g")).toBe(2048);
    expect(mem("2GB")).toBe(2048);
    expect(mem("1048576k")).toBe(1024);
    expect(mem("1073741824")).toBe(1024); // bare number = bytes
  });

  it("interpolates a limit from the env file", () => {
    const parsed = parseComposeFile(svc("    mem_limit: ${API_MEM}\n"), {
      envFileContent: "API_MEM=6g\n",
    });
    expect(parsed.services[0]?.advanced?.resources?.memoryMb).toBe(6144);
  });

  it("omits resources entirely when the service declares none", () => {
    const parsed = parseComposeFile(svc("    ports:\n      - '80:80'\n"));
    expect(parsed.services[0]?.advanced?.resources).toBeUndefined();
  });

  // A malformed limit must not silently become a tiny cap — that's the failure
  // mode this whole change exists to remove.
  it("drops an unparseable limit rather than guessing a small one", () => {
    const parsed = parseComposeFile(svc("    mem_limit: lots\n    cpus: many\n"));
    expect(parsed.services[0]?.advanced?.resources).toBeUndefined();
  });

  it("keeps a healthcheck and resources side by side in one advanced blob", () => {
    const parsed = parseComposeFile(
      svc("    mem_limit: 1g\n    healthcheck:\n      test: 'curl -f localhost'\n"),
    );
    expect(parsed.services[0]?.advanced?.resources?.memoryMb).toBe(1024);
    expect(parsed.services[0]?.advanced?.healthcheck?.test).toBe("curl -f localhost");
  });
});
