import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishNotarization, submitNotarization } from "./macos-notarization";

const id = "11111111-2222-4333-8444-555555555555";
const context = {
  commit: "a".repeat(40), runId: "123", appleId: "release@example.invalid",
  password: "test-notary-secret", teamId: "TESTTEAM",
};
type Runner = NonNullable<Parameters<typeof finishNotarization>[2]>;
type Result = Awaited<ReturnType<Runner["run"]>>;
const ok = { code: 0, stdout: "", stderr: "" };
const status = (value: string): Result => ({ ...ok, stdout: JSON.stringify({ id, status: value }) });
const networkError = {
  code: 1, stdout: "", stderr: 'NSURLErrorDomain Code=-1005 "The network connection was lost."',
};

let directory: string;
let path: string;
let calls: string[][];
let messages: string[];
let runner: Runner;
let responses: Result[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-notary-test-"));
  path = join(directory, "Openship-arm64.dmg");
  await writeFile(path, "signed installer fixture");
  calls = [];
  messages = [];
  responses = [];
  let time = 0;
  runner = {
    run: async (args) => {
      calls.push(args);
      if (args[1] === "submit") return { ...ok, stdout: JSON.stringify({ id }) };
      if (args[1] === "info") return responses.shift() ?? status("Accepted");
      return ok;
    },
    sleep: async (ms) => { time += ms; },
    now: () => time,
    log: (message) => { messages.push(message); },
  };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("resumable macOS notarization", () => {
  it("saves a submission without waiting and binds it to the exact installer and release run", async () => {
    await submitNotarization(path, context, runner);
    const receipt = JSON.parse(await readFile(`${path}.notary.json`, "utf8"));
    expect(receipt).toMatchObject({ version: 1, id, commit: context.commit, runId: "123", file: "Openship-arm64.dmg" });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--no-wait");
    expect(JSON.stringify(receipt)).not.toContain(context.password);
  });

  it("recovers a lost polling connection without uploading or rebuilding again", async () => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    responses.push(networkError, status("In Progress"), status("Accepted"));
    await finishNotarization(path, context, runner);
    expect(calls.map((args) => args[1])).toEqual(["info", "info", "info", "staple", "validate"]);
    expect(calls.slice(0, 3).every((args) => args[2] === id)).toBe(true);
    expect(messages.some((message) => message.includes("retrying submission"))).toBe(true);
  });

  it("resumes a timed-out job from its persisted receipt", async () => {
    await submitNotarization(path, context, runner);
    responses.push(status("In Progress"));
    await expect(finishNotarization(path, context, runner, 1_000)).rejects.toThrow("installer and submission are saved");
    calls.length = 0;
    await finishNotarization(path, context, runner);
    expect(calls.map((args) => args[1])).toEqual(["info", "staple", "validate"]);
  });

  it.each(["commit", "runId", "file", "sha256", "id"])("rejects a mismatched %s before contacting Apple", async (field) => {
    await submitNotarization(path, context, runner);
    const receipt = JSON.parse(await readFile(`${path}.notary.json`, "utf8"));
    receipt[field] = "different";
    await writeFile(`${path}.notary.json`, JSON.stringify(receipt));
    calls.length = 0;
    await expect(finishNotarization(path, context, runner)).rejects.toThrow("does not match");
    expect(calls).toHaveLength(0);
  });

  it("rejects modified installer bytes before polling or stapling", async () => {
    await submitNotarization(path, context, runner);
    await writeFile(path, "different installer");
    calls.length = 0;
    await expect(finishNotarization(path, context, runner)).rejects.toThrow("does not match");
    expect(calls).toHaveLength(0);
  });

  it("fails rejected notarization without attempting to staple", async () => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    responses.push(status("Invalid"));
    await expect(finishNotarization(path, context, runner)).rejects.toThrow("Apple rejected");
    expect(calls.map((args) => args[1])).toEqual(["info", "log"]);
  });

  it.each([
    { ...ok, stdout: "not json" },
    { ...ok, stdout: JSON.stringify({ id: "another-submission", status: "Accepted" }) },
  ])("does not accept an invalid Apple response", async (result) => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    responses.push(result);
    await expect(finishNotarization(path, context, runner)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("limits repeated network failures and keeps the receipt for the next retry", async () => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    responses.push(...Array.from({ length: 6 }, () => networkError));
    await expect(finishNotarization(path, context, runner)).rejects.toThrow("Retry this notarization job to resume");
    expect(calls).toHaveLength(6);
    expect(JSON.parse(await readFile(`${path}.notary.json`, "utf8")).id).toBe(id);
  });

  it("does not retry invalid credentials or print secrets in errors", async () => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    responses.push({ code: 1, stdout: "", stderr: `HTTP status code: 401 ${context.appleId} ${context.password}` });
    const error = await finishNotarization(path, context, runner).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(context.password);
    expect((error as Error).message).not.toContain(context.appleId);
    expect(calls).toHaveLength(1);
  });

  it("requires a valid ticket even after Apple has accepted the submission", async () => {
    await submitNotarization(path, context, runner);
    const run = runner.run;
    runner.run = async (args) => args[1] === "validate"
      ? { code: 1, stdout: "", stderr: "invalid ticket" }
      : run(args);
    await expect(finishNotarization(path, context, runner)).rejects.toThrow("ticket is invalid");
    expect(messages.some((message) => message.startsWith("Notarized and validated"))).toBe(false);
  });

  it("retries a ticket that has not propagated yet and then validates it", async () => {
    await submitNotarization(path, context, runner);
    calls.length = 0;
    const run = runner.run;
    let staples = 0;
    runner.run = async (args) => {
      const result = await run(args);
      return args[1] === "staple" && ++staples === 1
        ? { code: 1, stdout: "", stderr: "Ticket not available yet" }
        : result;
    };
    await finishNotarization(path, context, runner);
    expect(calls.map((args) => args[1])).toEqual(["info", "staple", "staple", "validate"]);
  });

  it("does not invent a receipt or retry an uncertain upload", async () => {
    runner.run = async (args) => { calls.push(args); return networkError; };
    await expect(submitNotarization(path, context, runner)).rejects.toThrow("upload failed");
    expect(calls).toHaveLength(1);
    await expect(readFile(`${path}.notary.json`, "utf8")).rejects.toThrow();
  });

  it("rejects missing credentials before uploading", async () => {
    await expect(submitNotarization(path, { ...context, password: "" }, runner)).rejects.toThrow("credentials are incomplete");
    expect(calls).toHaveLength(0);
  });

  it("retains build and submission jobs and publishes only finished installers", async () => {
    const workflow = Bun.YAML.parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as any;
    const jobs = workflow.jobs;
    expect(jobs["submit-desktop-macos"].needs).toBe("build-desktop-macos");
    expect(jobs["notarize-desktop-macos"].needs).toBe("submit-desktop-macos");
    expect(jobs.publish.needs).toContain("notarize-desktop-macos");
    for (const job of ["build-desktop-macos", "submit-desktop-macos"]) {
      const uploads = jobs[job].steps.filter((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
      expect(uploads.length).toBeGreaterThan(0);
      expect(uploads.every((step: any) => !step.with.name.startsWith("desktop-"))).toBe(true);
    }
    expect(jobs["notarize-desktop-macos"].steps.some((step: any) => step["continue-on-error"])).toBe(false);
    const upload = jobs["notarize-desktop-macos"].steps.at(-1);
    expect(upload.with.name.startsWith("desktop-")).toBe(true);
    expect(upload.if).toBeUndefined(); // Failed polling/stapling cannot upload a final artifact.
  });
});
