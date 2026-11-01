import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildHelperScript } from "@repo/platform/engine/lib/git-forwarding/relay";

const execFileAsync = promisify(execFile);

describe("git credential relay helper", () => {
  it("derives an in-memory Basic header before Git's first HTTP request", async () => {
    let received = "";
    let resolveRequest!: (request: string) => void;
    const requestReceived = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        received += chunk;
        if (!received.includes("\n\n")) return;
        resolveRequest(received);
        socket.end("username=x-access-token\npassword=gho_test-only\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const dir = await mkdtemp(join(tmpdir(), "openship-relay-test-"));
    const script = join(dir, "credential-helper.sh");
    try {
      const port = (server.address() as AddressInfo).port;
      await writeFile(script, buildHelperScript(port, "test-nonce"), "utf8");
      await chmod(script, 0o700);

      const { stdout, stderr } = await execFileAsync("bash", [
        script,
        "auth-header",
        "https",
        "github.com",
        "oblien/openship.git",
      ]);

      expect(stderr).toBe("");
      expect(stdout).toBe(
        `Authorization: Basic ${Buffer.from("x-access-token:gho_test-only").toString("base64")}`,
      );
      await expect(requestReceived).resolves.toBe(
        "test-nonce\nprotocol=https\nhost=github.com\npath=oblien/openship.git\n\n",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
