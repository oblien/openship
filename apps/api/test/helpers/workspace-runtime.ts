import { shellQuote } from "@repo/core";
import type { CommandExecutor } from "@repo/adapters";

/** Provider transport fixture. Commands and files still use a real, isolated SSH host. */
export function workspaceRuntime(executor: CommandExecutor) {
  return {
    exec: {
      run: async (args: string[]) => ({
        stdout: await executor.exec(args.map(shellQuote).join(" ")),
        exit_code: 0,
      }),
      stream: async function* (args: string[]) {
        const child = await executor.rawExec!(args.map(shellQuote).join(" "));
        const errors: Buffer[] = [];
        child.stderr.on("data", (bytes: Buffer) => errors.push(bytes));
        for await (const bytes of child.stdout)
          yield { event: "stdout", data: Buffer.from(bytes).toString("base64") };
        if (errors.length)
          yield { event: "stderr", data: Buffer.concat(errors).toString("base64") };
        yield { event: "exit", exit_code: await child.onClose };
      },
    },
    files: {
      write: async ({ fullPath, content }: { fullPath: string; content: string }) => {
        await executor.writeFile(fullPath, content);
        return { success: true };
      },
      read: async ({ filePath }: { filePath: string }) => ({
        success: true,
        content: await executor.readFile(filePath),
      }),
      delete: async ({ path }: { path: string }) => {
        await executor.rm(path);
        return { success: true };
      },
    },
  };
}
