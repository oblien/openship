"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Official ProcessChannel + DictionaryContextData wire format. The job payload
// includes credentials; the bridge must preserve them in IPC and nowhere else.
function frame(patch = {}) {
  const body = Buffer.from(
    JSON.stringify({
      contextData: {
        github: {
          t: 2,
          d: Object.entries({
            repository: "owner/private",
            repository_id: "41",
            run_id: "42",
            run_attempt: "2",
          }).map(([k, v]) => ({ k, v })),
        },
      },
      credentials: { token: "canary-secret-never-log-or-persist" },
      ...patch,
    }),
    "utf16le",
  );
  const header = Buffer.alloc(8);
  header.writeInt32LE(1, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function launch(t) {
  const directory = mkdtempSync(join(tmpdir(), "openship-github-gate-"));
  const worker = join(directory, "worker");
  const marker = join(directory, "started");
  // Read and echo the original IPC bytes, as the unmodified Worker would. An
  // executable marker proves a denial never reached the worker entry point.
  writeFileSync(
    worker,
    `#!${process.execPath}\n` +
      `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(marker)}, 'started');
    const input = fs.createReadStream(null, { fd: 3 });
    let data = Buffer.alloc(0);
    input.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 8 && data.length === data.readInt32LE(4) + 8) {
        fs.writeSync(4, data);
        process.exit(0);
      }
    });
  `,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [join(__dirname, "github-gate.cjs"), directory, worker, "spawnclient", "3", "4"],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  let logs = "";
  const output = [];
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("data", (data) => output.push(data));
  const done = once(child, "close");
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    marker,
    child,
    done,
    logs: () => logs,
    output: () => Buffer.concat(output),
    async pending() {
      const file = join(directory, "github-admission.json");
      for (let i = 0; i < 200 && !existsSync(file); i++) {
        if (child.exitCode !== null) throw new Error(`Gate exited early: ${logs}`);
        await delay(10);
      }
      return JSON.parse(readFileSync(file, "utf8"));
    },
    decide(value) {
      writeFileSync(join(directory, "github-admission-decision.json"), JSON.stringify(value));
    },
  };
}

test(
  "waits before launching Worker, then forwards a fragmented authenticated payload unchanged",
  { timeout: 10000 },
  async (t) => {
    const gate = launch(t);
    const payload = frame({ padding: "x".repeat(100_000) });
    gate.child.stdio[3].write(payload.subarray(0, 3));
    await delay(20);
    gate.child.stdio[3].write(payload.subarray(3, 7));
    gate.child.stdio[3].write(payload.subarray(7));
    const request = await gate.pending();
    assert.deepEqual(
      { ...request, id: "nonce" },
      { id: "nonce", repository: "owner/private", repositoryId: "41", runId: "42", attempt: 2 },
    );
    await delay(250);
    assert.equal(existsSync(gate.marker), false);
    assert.match(request.id, /^[a-f0-9]{64}$/);
    for (const name of readdirSync(gate.directory).filter((name) => name.endsWith(".json")))
      assert.equal(
        readFileSync(join(gate.directory, name), "utf8").includes("canary-secret"),
        false,
      );
    gate.decide({ id: request.id, allow: true });
    assert.deepEqual(await gate.done, [0, null]);
    assert.equal(existsSync(gate.marker), true);
    assert.deepEqual(gate.output(), payload);
    assert.equal(gate.logs().includes("canary-secret"), false);
  },
);

for (const reason of [
  "deny",
  "wrong nonce",
  "cancel IPC",
  "cancel marker",
  "EOF",
  "signal",
  "oversized decision",
]) {
  test(`never starts Worker after ${reason}`, { timeout: 10000 }, async (t) => {
    const gate = launch(t);
    gate.child.stdio[3].write(frame());
    const request = await gate.pending();
    if (reason === "deny") gate.decide({ id: request.id, allow: false });
    if (reason === "wrong nonce") gate.decide({ id: "a".repeat(64), allow: true });
    if (reason === "cancel IPC") {
      const cancel = Buffer.alloc(8);
      cancel.writeInt32LE(2);
      gate.child.stdio[3].write(cancel);
    }
    if (reason === "cancel marker") {
      writeFileSync(join(gate.directory, "cancel"), "cancel");
      gate.decide({ id: request.id, allow: true });
    }
    if (reason === "EOF") gate.child.stdio[3].end();
    if (reason === "signal") gate.child.kill("SIGTERM");
    if (reason === "oversized decision")
      gate.decide({ id: request.id, allow: true, padding: "x".repeat(4096) });
    const [code] = await gate.done;
    assert.notEqual(code, 0);
    assert.equal(existsSync(gate.marker), false);
    assert.equal(gate.logs().includes("canary-secret"), false);
  });
}
for (const [name, payload] of [
  [
    "editable environment cannot replace assignment identity",
    frame({ contextData: {}, environmentVariables: { GITHUB_RUN_ID: "42" } }),
  ],
  [
    "missing attempt",
    frame({ contextData: { github: { t: 2, d: [{ k: "repository", v: "owner/private" }] } } }),
  ],
  [
    "changed IPC type",
    (() => {
      const data = frame();
      data.writeInt32LE(9);
      return data;
    })(),
  ],
  [
    "excessive frame",
    (() => {
      const data = Buffer.alloc(8);
      data.writeInt32LE(1);
      data.writeInt32LE(50_000_002, 4);
      return data;
    })(),
  ],
  ["truncated frame", frame().subarray(0, 20)],
]) {
  test(`fails closed: ${name}`, { timeout: 10000 }, async (t) => {
    const gate = launch(t);
    gate.child.stdio[3].end(payload);
    assert.notEqual((await gate.done)[0], 0);
    assert.equal(existsSync(gate.marker), false);
    assert.equal(gate.logs().includes("canary-secret"), false);
  });
}
