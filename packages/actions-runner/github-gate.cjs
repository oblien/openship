"use strict";

// Admission boundary, not a workflow interpreter. Relay the official runner's
// ProcessChannel unchanged only after the controller authorizes its assignment.
// Upstream framing: actions/runner src/Runner.Common/{ProcessChannel,StreamString}.cs.
// Unexpected protocols, cancellation, timeouts and crashes never start Worker.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Socket } = require("node:net");

const MAX_FRAME = 50_000_000;
const fail = () => {
  process.stderr.write(
    "Openship blocked this runner assignment before workflow code executed. Check the run's access and approval settings.\n",
  );
  process.exit(1);
};

function field(object, name) {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw Error();
  const entries = Object.entries(object).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (entries.length !== 1) throw Error();
  return entries[0][1];
}
function contextValue(context, name) {
  if (field(context, "t") !== 2) throw Error();
  const entries = field(context, "d");
  if (!Array.isArray(entries)) throw Error();
  const matches = entries.filter(
    (item) => typeof item.k === "string" && item.k.toLowerCase() === name,
  );
  if (matches.length !== 1 || typeof matches[0].v !== "string") throw Error();
  return matches[0].v;
}
function assignment(body) {
  const github = field(field(body, "contextData"), "github");
  const repository = contextValue(github, "repository");
  const repositoryId = contextValue(github, "repository_id");
  const runId = contextValue(github, "run_id");
  const attempt = contextValue(github, "run_attempt");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    ![repositoryId, runId, attempt].every(
      (value) => /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)),
    )
  )
    throw Error();
  return {
    id: crypto.randomBytes(32).toString("hex"),
    repository,
    repositoryId,
    runId,
    attempt: Number(attempt),
  };
}
function writeRecord(file, value) {
  const staged = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.renameSync(staged, file);
}
function readDecision(file) {
  const fd = fs.openSync(file, "r");
  try {
    const data = Buffer.alloc(4097);
    const size = fs.readSync(fd, data, 0, data.length, 0);
    if (size > 4096) throw Error();
    return JSON.parse(data.subarray(0, size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const [directory, worker, command, pipeIn, pipeOut] = process.argv.slice(2);
  if (
    !path.isAbsolute(directory || "") ||
    !path.isAbsolute(worker || "") ||
    command !== "spawnclient" ||
    ![pipeIn, pipeOut].every((value) => /^[0-9]+$/.test(value) && Number(value) > 2)
  )
    throw Error();
  // libuv's pipe transport is cancellable. fs.ReadStream would leave a blocking
  // thread-pool read outstanding while an idle listener keeps its pipe open.
  const incoming = new Socket({ fd: Number(pipeIn), readable: true, writable: false });
  const outgoing = new Socket({ fd: Number(pipeOut), readable: false, writable: true });
  incoming.on("error", fail);
  outgoing.on("error", fail);
  let phase = "receiving";
  let buffer = Buffer.alloc(8);
  let offset = 0;
  let frame;
  let received;
  const ready = new Promise((resolve) => {
    received = resolve;
  });
  const consume = (chunk) => {
    try {
      if (phase === "waiting") return fail(); // Any subsequent message cancels admission.
      // Allocate the payload once after its bounded header, rather than copying
      // an increasingly large credential-bearing frame for every pipe chunk.
      if (offset < 8) {
        const count = Math.min(8 - offset, chunk.length);
        chunk.copy(buffer, offset, 0, count);
        offset += count;
        chunk = chunk.subarray(count);
        if (offset < 8) return;
        const kind = buffer.readInt32LE(0),
          length = buffer.readInt32LE(4);
        if (kind !== 1 || length <= 0 || length > MAX_FRAME || length % 2) return fail();
        const payload = Buffer.allocUnsafe(length + 8);
        buffer.copy(payload);
        buffer = payload;
      }
      if (chunk.length > buffer.length - offset) return fail();
      chunk.copy(buffer, offset);
      offset += chunk.length;
      if (offset < buffer.length) return;
      frame = buffer;
      buffer = null;
      phase = "waiting";
      received();
    } catch {
      fail();
    }
  };
  incoming.on("data", consume);
  incoming.on("end", () => {
    if (phase !== "running") fail();
  });
  const deadline = setTimeout(fail, 120_000);
  process.on("SIGTERM", fail);
  process.on("SIGINT", fail);
  await ready;
  const request = assignment(JSON.parse(frame.subarray(8).toString("utf16le")));
  writeRecord(path.join(directory, "github-admission.json"), request);
  let decision;
  while (!decision) {
    try {
      decision = readDecision(path.join(directory, "github-admission-decision.json"));
      if (decision.id !== request.id || decision.allow !== true) return fail();
    } catch (error) {
      if (error.code !== "ENOENT") return fail();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (
    incoming.readableEnded ||
    incoming.readableLength ||
    fs.existsSync(path.join(directory, "cancel"))
  )
    return fail();
  clearTimeout(deadline);
  // Approval has now been consumed for this one assignment. Only the original
  // authenticated payload is passed onward; never reconstruct job credentials.
  phase = "running";
  incoming.removeListener("data", consume);
  process.removeListener("SIGTERM", fail);
  process.removeListener("SIGINT", fail);
  const child = spawn(worker, ["spawnclient", "3", "4"], {
    stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
  });
  child.on("error", fail);
  const toWorker = child.stdio[3],
    fromWorker = child.stdio[4];
  toWorker.on("error", () => {}); // The official worker can close after completing.
  fromWorker.on("error", fail);
  toWorker.write(frame);
  frame = null;
  incoming.pipe(toWorker);
  fromWorker.pipe(outgoing);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("close", (code) => process.exit(code ?? 1));
}

main().catch(fail);
