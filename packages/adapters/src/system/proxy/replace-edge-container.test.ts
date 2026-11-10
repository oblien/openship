import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "../local-executor";
import { sq } from "../local-shell";
import { runReliable } from "../remote-journal";
import { SshDisconnectedError } from "../errors";
import type { CommandExecutor } from "../../types";
import { edgeReplacementCommand } from "./replace-edge-container";

const old = "a".repeat(64);
const next = "b".repeat(64);
const check = "c".repeat(64);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Execute the real transaction AND detached journal against a stateful Docker CLI.
// Unlike mocked exec strings, this exercises shell failure/EXIT traps and recovery.
async function fixture(mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "edge-replacement-"));
  roots.push(root);
  const file = join(root, "state.json");
  const events = join(root, "events.jsonl");
  const original = {
    name: "test-edge",
    running: true,
    image: "edge:old",
    labels: { "openship.service": "edge" },
    data: "original volumes and configuration",
  };
  await writeFile(file, JSON.stringify({ [old]: original }));
  await writeFile(
    join(root, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const file = ${JSON.stringify(file)}, events = ${JSON.stringify(events)}, mode = ${JSON.stringify(mode)};
const old = ${JSON.stringify(old)}, next = ${JSON.stringify(next)}, check = ${JSON.stringify(check)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(events, JSON.stringify(a) + '\\n');
const id = value => state[value] ? value : Object.keys(state).find(k => state[k].name === value);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const die = () => process.exit(1);
switch (a[0]) {
case 'inspect': {
  const key = id(a.at(-1)); if (!key) die();
  if (a[2] === '{{.Id}}') console.log(mode === 'identity-changed' ? 'c'.repeat(64) : key);
  else if (a[2] === '{{.Name}}') console.log('/' + state[key].name);
  else console.log(state[key].running ? 'running' : 'exited');
  break;
}
case 'create': {
  if (mode === 'candidate-reserved') die();
  const name = a[a.indexOf('--name')+1];
  if (mode === 'check-reserved' && name.endsWith('-check')) {
    state[check] = { name, ownedBy: 'another update' }; save(); die();
  }
  if (id(name)) die();
  const created = name.endsWith('-check') ? check : next;
  const labels = {};
  a.forEach((v,i) => { if(v === '--label') { const [k,...value] = a[i+1].split('='); labels[k] = value.join('='); } });
  state[created] = { name, running: false, image: a.at(-1), labels };
  save(); console.log(created); break;
}
case 'stop': {
  state[id(a.at(-1))].running = false; save();
  if (mode === 'disconnect') setTimeout(() => {}, 1800);
  break;
}
case 'rename': {
  const key = id(a[1]); if (!key || id(a[2])) die();
  state[key].name = a[2]; save(); break;
}
case 'start': {
  if (a[1] === '-a') { if (mode === 'invalid-config') die(); break; }
  const key = id(a[1]);
  if (!key || key === next && ['start-failure','rollback-failure'].includes(mode) || key === old && mode === 'rollback-failure') die();
  state[key].running = true; save(); break;
}
case 'exec': if (!state[id(a[1])]?.running || a[1] === next && mode === 'unhealthy') die(); break;
case 'rm': delete state[id(a.at(-1))]; save(); break;
default: throw new Error('Unexpected Docker command: ' + a.join(' '));
}
`,
    { mode: 0o755 },
  );
  const executor = new LocalExecutor();
  const command = edgeReplacementCommand({
    container: "test-edge",
    image: "edge:new",
    mounts: [],
    verifyTimeoutMs: 1,
    predecessor: {
      id: old,
      labels: {
        "openship.service": "edge",
        "com.docker.compose.project": "customer-project",
        "com.docker.compose.config-hash": "obsolete",
      },
    },
  });
  const run = (exec: CommandExecutor = executor) =>
    runReliable(async () => exec, "edge-fixture", command, {
      baseDir: join(root, "journal"),
      envPrefix: `export PATH=${sq(`${root}:${process.env.PATH}`)}; `,
      timeoutMs: 20_000,
      waitSecs: 1,
      reconnectMinMs: 1,
    });
  return {
    run,
    executor,
    original,
    state: async () => JSON.parse(await readFile(file, "utf8")),
    events: async (): Promise<string[][]> =>
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe("server-owned edge replacement", () => {
  it("refuses an overlapping cutover without deleting the other update's reservation", async () => {
    const f = await fixture("check-reserved");
    expect((await f.run()).code).toBe(10);
    const state = await f.state();
    expect(state[old]).toEqual(f.original);
    expect(state[next]).toBeUndefined();
    expect(state[check]).toMatchObject({ ownedBy: "another update" });
    expect((await f.events()).some((a) => a[0] === "stop")).toBe(false);
  });

  it("validates before stopping and removes the predecessor only after the new edge is healthy", async () => {
    const f = await fixture();
    expect((await f.run()).code).toBe(0);
    const state = await f.state();
    expect(Object.keys(state)).toEqual([next]);
    expect(state[next]).toMatchObject({
      name: "test-edge",
      running: true,
      image: "edge:new",
      labels: { "openship.service": "edge", "com.docker.compose.project": "customer-project" },
    });
    expect(state[next].labels).not.toHaveProperty("com.docker.compose.config-hash");
    const events = await f.events();
    expect(events.findIndex((a) => a[0] === "start" && a[1] === "-a")).toBeLessThan(
      events.findIndex((a) => a[0] === "stop"),
    );
    expect(events.findIndex((a) => a[0] === "exec")).toBeLessThan(
      events.findIndex((a) => a[0] === "rm" && a.at(-1) === old),
    );
  });

  it.each(["invalid-config", "identity-changed", "candidate-reserved"])(
    "leaves the original edge untouched on %s",
    async (mode) => {
      const f = await fixture(mode);
      expect((await f.run()).code).toBe(10);
      expect(await f.state()).toEqual({ [old]: f.original });
      expect((await f.events()).some((a) => a[0] === "stop")).toBe(false);
    },
  );

  it.each(["start-failure", "unhealthy"])(
    "restores the exact original container and data on %s",
    async (mode) => {
      const f = await fixture(mode);
      expect((await f.run()).code).toBe(20);
      expect(await f.state()).toEqual({ [old]: f.original });
    },
  );

  it("retains the predecessor and reports a failed recovery instead of success", async () => {
    const f = await fixture("rollback-failure");
    expect((await f.run()).code).toBe(21);
    expect(await f.state()).toEqual({ [old]: { ...f.original, running: false } });
  });

  it("finishes exactly once when the connection drops while the old edge is stopped", async () => {
    const f = await fixture("disconnect");
    let lost = false;
    const interrupted = Object.create(f.executor) as CommandExecutor;
    interrupted.exec = async (cmd, opts) => {
      const output = await f.executor.exec(cmd, opts);
      if (!lost && output.startsWith("OPSH-RUNNING") && !(await f.state())[old].running) {
        lost = true;
        throw new SshDisconnectedError();
      }
      return output;
    };
    expect((await f.run(interrupted)).code).toBe(0);
    expect(lost).toBe(true);
    expect(await f.state()).toMatchObject({ [next]: { name: "test-edge", running: true } });
    expect((await f.events()).filter((a) => a[0] === "stop")).toHaveLength(1);
    expect((await f.events()).filter((a) => a[0] === "create")).toHaveLength(2);
  });
});
