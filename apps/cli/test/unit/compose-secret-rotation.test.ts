import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * #488's refusal, and the remedy it prints.
 *
 * The gate itself (a missing generated secret + a surviving data volume = stop before
 * anything writes) is pinned in compose-env-preserve.test.ts. What is pinned HERE is the
 * advice, because the advice is what the operator acts on and there are three different
 * installs that reach it:
 *
 *   · ours, with the `.env` a previous run replaced still on disk → put that file back;
 *   · ours, with no backup → restore one / fix the permissions that hid it;
 *   · a stack we never created → there is no `.env` of ours and never was, so the values
 *     have to come out of the running container.
 *
 * The third is the one #509's own advice walks operators into: `docker/docker-compose.yml`
 * pins `name: openship`, the same compose project the CLI pins, so re-running
 * `openship up` on a raw-compose box ADOPTS that stack and its `openship_postgres_data`.
 * Telling that operator to "restore .env from a backup" points at a file that never
 * existed, and the only other thing on screen is `--reset-secrets`, which destroys every
 * environment variable stored in their database.
 */

const h = vi.hoisted(() => ({
  existing: new Set<string>(),
  written: new Map<string, string>(),
  composeCalls: [] as string[][],
  /** Postgres data volumes this box already has, by full volume name. */
  dbVolumes: new Set<string>(),
  /** `docker ps -a` label sweep rows: name\tproject\tconfig_files\tservice. */
  psAll: "",
}));

vi.mock("node:child_process", () => ({
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "compose") h.composeCalls.push(args);
    if (cmd === "docker" && args[0] === "volume") {
      return { status: h.dbVolumes.has(String(args[2])) ? 0 : 1, stdout: "", stderr: "" };
    }
    // The label sweep (adopted-stack evidence, orphaned stacks, the edge reclaim).
    if (cmd === "docker" && args[0] === "ps" && !args.some((a) => a.includes("{{.Ports}}"))) {
      return { status: 0, stdout: h.psAll, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  chmodSync: () => undefined,
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  realpathSync: (p: string) => String(p),
  readFileSync: (p: string) => {
    const v = h.written.get(String(p));
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return v;
  },
  rmSync: () => undefined,
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
  renameSync: (from: string, to: string) => {
    h.written.set(String(to), h.written.get(String(from)) ?? "");
    h.existing.add(String(to));
    h.written.delete(String(from));
    h.existing.delete(String(from));
  },
}));

vi.mock("../../src/lib/source-install", () => ({ readSourceInstall: () => null }));
vi.mock("@repo/adapters/proxy", () => ({ sanitizeEdgeVhosts: async () => {} }));
vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  const { dockerSocketMock } = await import("../helpers/harness");
  return {
    ...dockerSocketMock,
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import {
  adoptedStackOrigin,
  composePaths,
  composePlan,
  composeUp,
  renderSecretRotationRefusal,
} from "../../src/lib/compose";

const OURS = composePaths.file;
const RAW_COMPOSE = "/root/openship/docker/docker-compose.yml";
const PROJECT = "openship";
const VOLUME = `${PROJECT}_postgres_data`;
const ROTATION = { volume: VOLUME, keys: ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET"] };

/** One sweep row, in the format the reader asks docker for. */
const row = (name: string, project: string, configFiles: string, service = "") =>
  [name, project, configFiles, service].join("\t");

/** The adopted shape: a raw-compose stack running under the project name we pin. */
const adoptedRows = () =>
  [
    row("openship-postgres-1", PROJECT, RAW_COMPOSE, "postgres"),
    row("openship-api-1", PROJECT, RAW_COMPOSE, "api"),
    row("unrelated-app", "other", "/srv/other/compose.yml", "web"),
  ].join("\n");

function seedEnv(env: Record<string, string>): void {
  h.written.set(
    composePaths.env,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
  h.existing.add(composePaths.env);
  h.existing.add(composePaths.file);
}

beforeEach(() => {
  // An ordinary rootful box: the daemon socket is where the mount defaults to, so the
  // #482 detection has nothing to report here.
  h.existing = new Set(["/var/run/docker.sock"]);
  h.written = new Map();
  h.composeCalls = [];
  h.dbVolumes = new Set();
  h.psAll = "";
});

/**
 * The evidence, not a marker: compose's own labels already say which compose file
 * created a container, and that is the only thing on the box that distinguishes an
 * install of ours whose `.env` went bad from a stack we are about to take over.
 */
describe("adoptedStackOrigin", () => {
  it("reports a stack under our project name created from another compose file", () => {
    expect(adoptedStackOrigin(adoptedRows(), PROJECT)).toEqual({
      project: PROJECT,
      configFiles: RAW_COMPOSE,
      apiContainer: "openship-api-1",
    });
  });

  it("is null when the stack is ours (compose relabels what it adopts)", () => {
    const rows = [
      row("openship-postgres-1", PROJECT, OURS, "postgres"),
      row("openship-api-1", PROJECT, OURS, "api"),
    ].join("\n");
    expect(adoptedStackOrigin(rows, PROJECT)).toBeNull();
  });

  it("is null when a single row is ours — a half-adopted stack is still ours", () => {
    // `up` recreates services one at a time; if any container already carries our
    // config_files label, this install is one we created and the backup advice applies.
    const rows = [
      row("openship-postgres-1", PROJECT, RAW_COMPOSE, "postgres"),
      row("openship-api-1", PROJECT, OURS, "api"),
    ].join("\n");
    expect(adoptedStackOrigin(rows, PROJECT)).toBeNull();
  });

  it("is null when nothing runs under our project name", () => {
    expect(adoptedStackOrigin(row("unrelated-app", "other", "/srv/x.yml", "web"), PROJECT)).toBeNull();
    expect(adoptedStackOrigin("", PROJECT)).toBeNull();
  });

  it("falls back to compose's own naming when rows carry no service label", () => {
    // A label-less `docker run` stack, or an older compose that didn't set the label:
    // there is still an api container to read, and its name is derivable.
    const out = adoptedStackOrigin(row("something", PROJECT, ""), PROJECT);
    expect(out).toEqual({ project: PROJECT, configFiles: "", apiContainer: "openship-api-1" });
  });

  it("ignores containers belonging to other projects when picking the api", () => {
    const rows = [
      row("other-api-1", "other", "/srv/other.yml", "api"),
      row("openship-api-1", PROJECT, RAW_COMPOSE, "api"),
    ].join("\n");
    expect(adoptedStackOrigin(rows, PROJECT)?.apiContainer).toBe("openship-api-1");
  });
});

describe("renderSecretRotationRefusal — an install WE created", () => {
  it("points at the .env a previous run replaced, when there is one", () => {
    h.existing.add(composePaths.envBackup);
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain(`cp ${composePaths.envBackup} ${composePaths.env}`);
    expect(msg).toContain("POSTGRES_PASSWORD, BETTER_AUTH_SECRET");
    expect(msg).toContain(VOLUME);
  });

  it("asks for a restore + the permissions case when there is no backup", () => {
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain(`restore ${composePaths.env} from a backup`);
    expect(msg).toContain("re-run as the user that owns it");
    expect(msg).not.toContain("cp ");
  });
});

/**
 * The branch that used to be wrong: an adopted stack has no `.env` of ours and no backup
 * of one, so the recovery has to come out of the container that still holds the values.
 */
describe("renderSecretRotationRefusal — a stack we did NOT create", () => {
  beforeEach(() => {
    h.psAll = adoptedRows();
  });

  it("never tells the operator to restore a file that never existed", () => {
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).not.toContain("from a backup");
    expect(msg).not.toContain(composePaths.envBackup);
  });

  it("names the compose file the stack really came from, and ours as the difference", () => {
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain(RAW_COMPOSE);
    expect(msg).toContain(composePaths.file);
    expect(msg).toContain("ADOPT");
  });

  it("reads the missing keys out of the api container's own environment", () => {
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain("docker inspect openship-api-1");
    expect(msg).toContain("{{range .Config.Env}}{{println .}}{{end}}");
    // Exactly the keys that are missing — not a fixed list that could drift from the gate.
    expect(msg).toContain("grep -E '^(POSTGRES_PASSWORD|BETTER_AUTH_SECRET)='");
    expect(msg).toContain(`>> ${composePaths.env}`);
  });

  it("carries the project name too — it is the volume prefix", () => {
    // Appending only the secrets leaves COMPOSE_PROJECT_NAME unset, and composeProjectName
    // then reads a non-empty `.env` as a legacy install and returns "compose" — a different
    // volume prefix, so the adopted data would sit unmounted beside an empty new database.
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain(`echo 'COMPOSE_PROJECT_NAME=${PROJECT}' >> ${composePaths.env}`);
    expect(msg).toContain("volume prefix");
  });

  it("frames --reset-secrets as the destructive last resort, not an option", () => {
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain("openship up --reset-secrets");
    expect(msg).toContain("DESTROYS");
    expect(msg).toContain("permanently unreadable");
  });

  it("wins over a stale .env.bak — the backup cannot hold this stack's secrets", () => {
    h.existing.add(composePaths.envBackup);
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain("docker inspect openship-api-1");
    expect(msg).not.toContain(`cp ${composePaths.envBackup}`);
  });

  it("says so even when the container carries no compose labels at all", () => {
    h.psAll = row("openship-api-1", PROJECT, "");
    const msg = renderSecretRotationRefusal(ROTATION);
    expect(msg).toContain("an unlabelled `docker run`");
    expect(msg).toContain("docker inspect openship-api-1");
  });
});

/**
 * #488's original complaint was a preview that described one thing and a run that did
 * another, so the refusal is rendered once and read twice — only the tense differs.
 */
describe("renderSecretRotationRefusal — dry run and real run agree", () => {
  it("differs from the real run only in the tense of the first line", () => {
    h.psAll = adoptedRows();
    const real = renderSecretRotationRefusal(ROTATION);
    const dry = renderSecretRotationRefusal(ROTATION, { dryRun: true });
    expect(dry).toContain("A real run would REFUSE here");
    expect(real).toContain("Refusing to continue");
    const tail = (s: string) => s.slice(s.indexOf("\n\n"));
    expect(tail(dry)).toBe(tail(real));
  });
});

describe("composeUp — the adopted stack refusal, end to end", () => {
  it("stops without writing and prints the container recovery", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The reported shape: no `.env` of ours at all (this box was only ever brought up
    // with the raw compose file), our project name, its data volume.
    h.existing.add(composePaths.file);
    h.dbVolumes.add(VOLUME);
    h.psAll = adoptedRows();

    const res = await composeUp({});

    expect(res.ok).toBe(false);
    expect(res.refused).toBe(true);
    // Nothing pulled, nothing recreated, and no `.env` written — which is what keeps the
    // adopted stack's own secrets readable out of its containers.
    expect(h.composeCalls).toHaveLength(0);
    expect(h.written.has(composePaths.env)).toBe(false);

    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain(RAW_COMPOSE);
    expect(msg).toContain("docker inspect openship-api-1");
    expect(msg).not.toContain("from a backup");
    err.mockRestore();
  });

  it("the dry-run plan reports the same rotation the run refuses on", () => {
    h.existing.add(composePaths.file);
    h.dbVolumes.add(VOLUME);
    h.psAll = adoptedRows();
    expect(composePlan({}).secretRotation).toEqual({
      volume: VOLUME,
      keys: ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "INTERNAL_TOKEN"],
    });
  });

  it("does not fire once the operator has copied the secrets in", async () => {
    // The remedy's end state: the project name and the recovered secrets in our `.env`.
    seedEnv({
      COMPOSE_PROJECT_NAME: PROJECT,
      POSTGRES_PASSWORD: "recovered-pg",
      BETTER_AUTH_SECRET: "recovered-auth",
      INTERNAL_TOKEN: "recovered-token",
    });
    h.dbVolumes.add(VOLUME);
    h.psAll = adoptedRows();

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    const env = h.written.get(composePaths.env) ?? "";
    expect(env).toContain("POSTGRES_PASSWORD=recovered-pg");
    // The project name has to survive the regenerate, or the volume prefix moves.
    expect(env).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
  });
});
