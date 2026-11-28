import { Readable } from "node:stream";
import { AppError, shellQuote } from "@repo/core";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { z } from "zod";

export const customerProjectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);

// The admin token stays inside the selected deployment. The browser hostname is
// customer-editable and must never be a destination for control-plane credentials.
const localRequest = `const { path, body } = await Bun.stdin.json();
const token = process.env.OPENSHIP_SENDING_ADMIN_TOKEN;
if (!token) process.exit(1);
const response = await fetch("http://127.0.0.1:" + (process.env.PORT || 4080) + path, {
  method: body ? "PUT" : "GET", redirect: "error", signal: AbortSignal.timeout(8000),
  headers: { "content-type": "application/json", "x-openship-sending-token": token },
  body: body && JSON.stringify(body),
});
if (!response.ok) process.exit(1);
process.stdout.write(await response.text());`;

export function customerAppAdmin(serverId: string, projectId: string) {
  const project = customerProjectIdSchema.parse(projectId);
  return async <T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> => {
    const failure = () => new AppError("The dedicated Webmail app could not confirm its settings.", 502);
    const command = [
      "set -eu",
      `ids=$(docker ps --no-trunc --format '{{.ID}}' --filter ${shellQuote("label=openship.project=" + project)} --filter label=openship.service=webmail)`,
      // Refuse ambiguous containers during rolling deploys.
      'test "${#ids}" -eq 64',
      'case "$ids" in *[!0-9a-f]*) exit 1;; esac',
      `timeout 12 docker exec -i "$ids" bun -e ${shellQuote(localRequest)} 2>/dev/null | head -c 8193`,
    ].join("\n");
    try {
      const result = await sshManager.withExecutor(serverId, async exec =>
        exec.execWithInput?.(command, Readable.from([JSON.stringify({ path, body })])),
      );
      if (!result || result.code !== 0 || Buffer.byteLength(result.stdout) > 8192) throw failure();
      return schema.parse(JSON.parse(result.stdout));
    } catch {
      throw failure();
    }
  };
}
