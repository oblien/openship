import type { Runtime } from "oblien";
import { AppError, type ManagedCommandRef } from "@repo/core";
import { CLOUD_EXEC_CANCEL } from "./exec-framing";
import { recoverCloudDockerRequest } from "./docker-request";

export async function releaseTask(runtime: Runtime, id: string) {
  try {
    if ((await runtime.exec.kill(id)).success !== true)
      throw new Error("The server did not confirm removal of the command task");
  } catch (error) {
    if ((error as { status?: number })?.status !== 404) throw error;
  }
}

/** A task's wrapper can exit while its child still runs. Verify the process
 * group separately, including commands whose creation response was lost. */
export async function stopCommand(runtime: Runtime, marker: string, taskId?: string) {
  if (!/^openship-exec-[a-f0-9-]{36}:$/.test(marker)) throw new Error("Invalid command recovery identity");
  try {
    const result = await runtime.exec.run(["python3", "-u", "-c", CLOUD_EXEC_CANCEL, marker], {
      execMode: "direct", timeoutSeconds: 15, keepLogs: false,
    });
    try {
      if (result.stdout?.trim() !== `stopped:${marker}`)
        throw new Error("The server did not confirm that the command's processes stopped");
    } finally {
      if (result.id) await releaseTask(runtime, result.id);
    }
    if (taskId) await releaseTask(runtime, taskId);
    // Keep the cancellation tombstone: a lost/late creation request must also
    // observe it before spawning. Completed wrappers remove their own marker.
  } catch (cause) {
    throw Object.assign(new AppError("Could not confirm the server command stopped. Retry the interrupted operation to recover it before changing this server.",
      503, "CLOUD_COMMAND_EXIT_UNCONFIRMED"), { cause });
  }
}

/** Close only terminals created by this operation, including a lost create response. */
export async function recoverManagedCommand(runtime: Runtime, command: ManagedCommandRef) {
  if (command.kind === "docker") return recoverCloudDockerRequest(runtime, command);
  await stopCommand(runtime, command.marker, command.taskId);
  if (command.kind !== "terminal") return;
  const terminals = await runtime.terminal.list();
  const owned = terminals.filter(terminal => terminal.command?.includes(command.marker));
  if (command.terminalId && terminals.some(terminal => terminal.id === command.terminalId && !owned.includes(terminal)))
    throw new AppError("Terminal recovery identity changed", 409, "CLOUD_SERVER_IDENTITY_MISMATCH");
  for (const terminal of owned) {
    try {
      if ((await runtime.terminal.close(terminal.id)).success !== true)
        throw new Error("The server did not acknowledge terminal closure");
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }
  }
  if ((await runtime.terminal.list()).some(terminal => terminal.command?.includes(command.marker) && terminal.alive !== false))
    throw new AppError("The server terminal has not confirmed its exit", 503, "CLOUD_COMMAND_EXIT_UNCONFIRMED");
}
