import { spawn } from "node:child_process";

/** No shell interpolation or credentials in argv. Native engine tools own the
 * data format; all commands have the owning Job's cancellation deadline. */
export async function databaseCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  env = process.env,
) {
  signal.throwIfAborted();
  const child = spawn(command, args, { signal, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const receive = (data: Buffer) => {
    output = (output + data.toString()).slice(-4000);
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} could not finish (${code}): ${output}`)),
    );
  });
  return output;
}
