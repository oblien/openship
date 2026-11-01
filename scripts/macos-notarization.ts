import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

interface NotaryContext {
  commit: string;
  runId: string;
  appleId: string;
  password: string;
  teamId: string;
}

interface NotaryTools {
  run: (args: string[]) => Promise<CommandResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

const tools: NotaryTools = {
  run: (args) => new Promise((resolve) => {
    // Never print execFile's Error.message: it includes the credential arguments.
    const timeout = args[0] === "notarytool" && args[1] === "submit" ? 600_000 : 120_000;
    execFile("xcrun", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr, timedOut: error?.killed });
    });
  }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  log: console.info,
};

const submissionId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function auth(context: NotaryContext): string[] {
  if (!context.appleId || !context.password || !context.teamId)
    throw new Error("Apple notarization credentials are incomplete.");
  if (!/^[a-f\d]{40}$/.test(context.commit) || !/^[1-9]\d*$/.test(context.runId))
    throw new Error("Notarization requires the release commit and workflow run ID.");
  return ["--apple-id", context.appleId, "--password", context.password, "--team-id", context.teamId];
}

function diagnostic(result: CommandResult, context: NotaryContext): string {
  let output = `${result.stdout}\n${result.stderr}`.trim();
  for (const secret of [context.password, context.appleId, context.teamId]) {
    if (secret) output = output.replaceAll(secret, "[redacted]");
  }
  return output.slice(0, 4_000);
}

function transient(result: CommandResult): boolean {
  return Boolean(result.timedOut || /(?:network connection was lost|timed? out|temporar(?:y|ily)|Code=-100[159]|HTTP(?: status)?(?: code)?[\s:=]+(?:408|429|5\d\d)\b)/i.test(`${result.stderr}\n${result.stdout}`));
}

function response(result: CommandResult): { id?: string; status?: string } {
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === "object") return value;
  } catch { /* Fail closed if the tool returned a non-JSON response. */ }
  throw new Error("Apple notarization returned an invalid response.");
}

/** Upload once, without waiting. CI saves this receipt independently
 * of Apple's processing, so a polling failure never requires another build. */
export async function submitNotarization(
  path: string, context: NotaryContext, runner: NotaryTools = tools,
): Promise<void> {
  const credentials = auth(context);
  const sha256 = await checksum(path);
  const result = await runner.run(["notarytool", "submit", path, ...credentials, "--no-wait", "--output-format", "json"]);
  if (result.code !== 0) throw new Error(`Apple notarization upload failed: ${diagnostic(result, context)}`);
  const { id } = response(result);
  if (typeof id !== "string" || !submissionId.test(id))
    throw new Error("Apple did not return a valid notarization submission ID.");
  await writeFile(`${path}.notary.json`, JSON.stringify({
    version: 1, id, file: basename(path), sha256, commit: context.commit, runId: context.runId,
  }, null, 2));
  runner.log(`Submitted ${basename(path)} to Apple: ${id}. Processing continues independently of this job.`);
}

/** Poll the saved submission, then staple only an accepted image. Transient
 * network failures retry status checks, never resubmit or bypass notarization. */
export async function finishNotarization(
  path: string, context: NotaryContext, runner: NotaryTools = tools,
  timeoutMs = 60 * 60_000,
): Promise<void> {
  const credentials = auth(context);
  const receipt = JSON.parse(await readFile(`${path}.notary.json`, "utf8"));
  if (
    receipt?.version !== 1 || typeof receipt.id !== "string" || !submissionId.test(receipt.id) ||
    receipt.file !== basename(path) || receipt.commit !== context.commit ||
    receipt.runId !== context.runId || receipt.sha256 !== await checksum(path)
  ) throw new Error("The notarization receipt does not match this installer and release run.");

  const deadline = runner.now() + timeoutMs;
  let consecutiveErrors = 0;
  let accepted = false;
  while (runner.now() < deadline) {
    const result = await runner.run(["notarytool", "info", receipt.id, ...credentials, "--output-format", "json"]);
    if (result.code !== 0) {
      if (!transient(result) || ++consecutiveErrors > 5)
        throw new Error(`Could not check Apple submission ${receipt.id}. Retry this notarization job to resume. ${diagnostic(result, context)}`);
      runner.log(`Apple status check interrupted; retrying submission ${receipt.id} (${consecutiveErrors}/5).`);
      await runner.sleep(Math.min(5_000 * 2 ** (consecutiveErrors - 1), 60_000));
      continue;
    }
    consecutiveErrors = 0;
    const { id, status } = response(result);
    if (id !== receipt.id) throw new Error("Apple returned a different notarization submission ID.");
    if (status === "Accepted") {
      accepted = true;
      break;
    }
    if (status !== "In Progress") {
      const log = await runner.run(["notarytool", "log", receipt.id, ...credentials]);
      throw new Error(`Apple rejected submission ${receipt.id} (${status ?? "unknown status"}). ${diagnostic(log, context)}`);
    }
    runner.log(`Apple is processing ${basename(path)} (${receipt.id}); checking again in 30 seconds.`);
    await runner.sleep(30_000);
  }
  if (!accepted)
    throw new Error(`Apple is still processing submission ${receipt.id}. Rerun this notarization job later; the installer and submission are saved.`);

  // A freshly accepted ticket can take a moment to reach Apple's CDN.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await runner.run(["stapler", "staple", path]);
    if (result.code === 0) break;
    if (attempt === 3) throw new Error(`Could not staple ${basename(path)}: ${diagnostic(result, context)}`);
    await runner.sleep(10_000);
  }
  const validation = await runner.run(["stapler", "validate", path]);
  if (validation.code !== 0)
    throw new Error(`The notarization ticket is invalid: ${diagnostic(validation, context)}`);
  runner.log(`Notarized and validated ${basename(path)} (${receipt.id}).`);
}

if (import.meta.main) {
  const [operation, path] = process.argv.slice(2);
  try {
    if (!path || !["submit", "finish"].includes(operation ?? ""))
      throw new Error("Usage: bun scripts/macos-notarization.ts <submit|finish> <installer.dmg>");
    const context = {
      commit: process.env.GITHUB_SHA ?? "", runId: process.env.GITHUB_RUN_ID ?? "",
      appleId: process.env.APPLE_ID ?? "", password: process.env.APPLE_PASSWORD ?? "",
      teamId: process.env.APPLE_TEAM_ID ?? "",
    };
    await (operation === "submit" ? submitNotarization : finishNotarization)(path, context);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Notarization failed.");
    process.exitCode = 1;
  }
}
