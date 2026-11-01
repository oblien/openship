import type { AppPrepareStep } from "@repo/core";
import type { ExecOnly } from "@repo/adapters";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared execution semantics for catalog setup. The deploy caller owns
 * persistence and whether an optional failure is a warning or a required failure. */
export async function runAppPrepareCommand(
  step: AppPrepareStep,
  executor: ExecOnly | null | undefined,
): Promise<string> {
  if (!executor) {
    if (step.mustSucceed) throw new Error("The runtime cannot execute the required app setup step");
    return "";
  }
  if (step.phase === "post-ready" && step.readiness) {
    const { test, interval = 3_000, retries = 10 } = step.readiness;
    let ready = false;
    for (let i = 0; i < retries; i++) {
      try {
        await executor.exec(test, { timeout: 15_000 });
        ready = true;
        break;
      } catch {
        // diagnostics-ignore: Readiness failures are expected during startup;
        // the final failed outcome is thrown and observed by the deploy caller.
        if (i + 1 < retries) await pause(interval);
      }
    }
    if (!ready) throw new Error("readiness probe never passed");
  }

  let stdout = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      stdout = await executor.exec(step.command, { timeout: 15_000 });
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await pause(3_000);
    }
  }
  const value = step.capturePattern
    ? (new RegExp(step.capturePattern).exec(stdout)?.[1] ?? "").trim()
    : stdout.trim();
  if (!value && step.mustSucceed) throw new Error("produced no output");
  return value;
}
