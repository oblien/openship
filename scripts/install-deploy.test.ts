import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const installer = resolve(import.meta.dir, "install.sh");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openship-install-deploy-"));
  directories.push(directory);
  mkdirSync(join(directory, "bin"));
  writeFileSync(
    join(directory, "bin", "openship"),
    `#!/bin/sh
if [ "$2" = "--help" ]; then exit 0; fi
[ -t 0 ] || { echo "NOT_A_TTY"; exit 91; }
printf '%s\\n' "$@" > "$OPENSHIP_HOME/arguments"
echo "TERMINAL_HANDOFF_OK"
exit "\${TEST_LAUNCH_STATUS:-0}"
`,
    { mode: 0o755 },
  );
  // Unexpected downloading fails the test before it could touch an installation.
  writeFileSync(
    join(directory, "bin", "curl"),
    "#!/bin/sh\necho UNEXPECTED_DOWNLOAD >&2\nexit 97\n",
    { mode: 0o755 },
  );
  return {
    directory,
    env: {
      ...process.env,
      OPENSHIP_HOME: directory,
      PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    },
  };
}

// A real controlling terminal, with the script arriving on a separate pipe as
// in curl|sh. No Docker, server, network or actual OpenShip installation is used.
const pipedTerminal = String.raw`
import errno, json, os, pty, sys
script = open(sys.argv[1], 'rb').read()
r, w = os.pipe()
pid, terminal = pty.fork()
if pid == 0:
    os.close(w)
    os.dup2(r, 0)
    os.close(r)
    os.execv('/bin/sh', ['sh', '-s', '--'] + sys.argv[2:])
os.close(r)
offset = 0
while offset < len(script):
    offset += os.write(w, script[offset:])
os.close(w)
output = b''
while True:
    try:
        data = os.read(terminal, 4096)
        if not data: break
        output += data
    except OSError as error:
        if error.errno == errno.EIO: break
        raise
_, status = os.waitpid(pid, 0)
os.close(terminal)
print(json.dumps({'status': os.waitstatus_to_exitcode(status), 'output': output.decode()}))
`;

describe("deploy link installer handoff", () => {
  test("reuses a compatible CLI and restores terminal input after curl|sh", () => {
    const { directory, env } = fixture();
    const result = spawnSync(
      "python3",
      [
        "-c",
        pipedTerminal,
        installer,
        "--repo",
        "https://github.com/owner/repo",
        "--branch",
        "release/v2",
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const child = JSON.parse(result.stdout);
    expect(child).toEqual({ status: 0, output: "TERMINAL_HANDOFF_OK\r\n" });
    expect(readFileSync(join(directory, "arguments"), "utf8")).toBe(
      "launch\n--repo\nhttps://github.com/owner/repo\n--branch\nrelease/v2\n",
    );
  });
  test("passes arguments literally and preserves launch failures", () => {
    const { directory, env } = fixture();
    const result = spawnSync(
      "python3",
      ["-c", pipedTerminal, installer, "--app", "not-valid; $(echo unsafe)"],
      { env: { ...env, TEST_LAUNCH_STATUS: "23" }, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe(23);
    expect(readFileSync(join(directory, "arguments"), "utf8")).toBe(
      "launch\n--app\nnot-valid; $(echo unsafe)\n",
    );
  });
  test.each([
    ["--app"],
    ["--repo"],
    ["--app", "n8n", "--repo", "https://github.com/a/b"],
    ["--branch", "main"],
    ["--app", "n8n", "--app", "redis"],
    ["--unknown"],
  ])("rejects invalid arguments before installation: %j", (...args) => {
    const { env } = fixture();
    const result = spawnSync("/bin/sh", [installer, ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("UNEXPECTED_DOWNLOAD");
  });
  test("refuses unattended deployment setup before downloading", () => {
    const { env } = fixture();
    // Start a new session without a controlling terminal even if the test runner has one.
    const result = spawnSync("/bin/sh", [installer, "--app", "n8n"], {
      env,
      encoding: "utf8",
      detached: true,
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("interactive terminal");
    expect(result.stderr).not.toContain("UNEXPECTED_DOWNLOAD");
  });
});
