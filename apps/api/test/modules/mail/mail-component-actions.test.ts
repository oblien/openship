import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two lies this surface used to tell (issue #565):
 *
 *  1. The logs drawer's header. The container engine's read is supervisord's
 *     per-program log, but the payload carried no record of that, so the drawer
 *     printed a `journalctl -u …` string naming a log the engine has not got.
 *  2. "ClamAV restarted". supervisorctl prints `ERROR (abnormal termination)` and
 *     still exits 0 — it propagates an exit code for its OWN failures, not the
 *     program's — so grading on the exit code alone reported a daemon that never came
 *     up as a success.
 *
 * `components.service.ts` reaches the box only through `runMailCommand`, so the real
 * builders and parsers stay live and only that one function is stubbed.
 */

const runMailCommand = vi.fn();
vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/platform/engine/modules/mail/mail-engine")>()),
  runMailCommand: (...args: unknown[]) => runMailCommand(...args),
}));
import { mailFail2banBanCommand, mailFail2banUnbanCommand } from "@repo/platform/engine/modules/mail/mail-engine";

import {
  banFail2banIp,
  getComponentLogs,
  getFail2banStatus,
  runComponentAction,
  unbanFail2banIp,
  MailComponentActionError,
  parseFail2banStatus,
  parseFail2banJailStatus,
} from "../../../src/modules/mail/admin/components.service";

/** Answer each build() with a canned output, marker appended as the real shell would. */
function replies(...outputs: string[]) {
  let i = 0;
  runMailCommand.mockImplementation(
    async (_target: unknown, build: (f: string) => string) => {
      const command = build("container");
      const output = outputs[i++] ?? "";
      return {
        flavor: "container",
        output: command.includes("__EXIT=") ? `${output}\n__EXIT=0__` : output,
        command,
      };
    },
  );
}

/**
 * `runComponentAction` waits out a settle delay before re-probing. Driving that with
 * fake timers keeps the suite fast, but the action has to be STARTED before the clock
 * is advanced — hence the split await rather than a plain one.
 */
async function act(...args: Parameters<typeof runComponentAction>) {
  const pending = runComponentAction(...args);
  // A refused action rejects BEFORE it ever reaches the settle timer, so the rejection
  // would be unattached for the length of the advance below. Park it.
  pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(2_000);
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getComponentLogs", () => {
  it("reports the read it actually performed, not journalctl", async () => {
    replies("line one\nline two");

    const logs = await getComponentLogs("srv_1", "clamav", 300);

    expect(logs.source).toBe(
      "docker exec openship-mail tail -n 300 /var/log/supervisor/clamav-daemon.log",
    );
    expect(logs.source).not.toContain("journalctl");
    expect(logs.lines).toEqual(["line one", "line two"]);
  });

  it("names the sidecar's container for the DB row", async () => {
    replies("");

    expect((await getComponentLogs("srv_1", "postgresql")).source).toBe(
      "docker logs --tail 200 openship-mail-db",
    );
  });
});

describe("runComponentAction", () => {
  it("fails a restart supervisorctl refused while exiting 0", async () => {
    replies("clamav-daemon: ERROR (abnormal termination)");

    await expect(act("srv_1", "clamav", "restart")).rejects.toBeInstanceOf(
      MailComponentActionError,
    );
  });

  it("reports the settled state rather than the acknowledgement", async () => {
    replies(
      "clamav-daemon: started",
      "clamav-daemon   FATAL   Exited too quickly (process log may have details)",
    );

    const res = await act("srv_1", "clamav", "restart");

    expect(res.settled?.status).toBe("failed");
    expect(res.settled?.subState).toBe("fatal");
  });

  // `ERROR (not running)` after a stop means we are already where we asked to be, so
  // it rides back in `output` for the panel to show instead of failing the call.
  it("surfaces a benign refusal in the output instead of swallowing it", async () => {
    replies("clamav-daemon: ERROR (not running)", "clamav-daemon   STOPPED   Not started");

    const res = await act("srv_1", "clamav", "stop");

    expect(res.output).toContain("ERROR (not running)");
    expect(res.settled?.status).toBe("inactive");
  });

  // A transitional state is not a disagreement: `systemctl --no-block restart dovecot`
  // returns instantly and the unit sits in `activating` for up to 90s. Reporting that
  // as "has not come up" would cry wolf on every healthy slow restart, so the settle
  // probe withholds a verdict instead.
  it("withholds a verdict while the daemon is still starting", async () => {
    replies("dovecot: started", "dovecot   STARTING   pid 41, uptime 0:00:01");

    const res = await act("srv_1", "dovecot", "restart");

    expect(res.settled).toBeUndefined();
  });

  it("treats a daemon this box does not ship as a no-op, not a refusal", async () => {
    replies("iredapd: ERROR (no such process)", "iredapd: ERROR (no such process)");

    const res = await act("srv_1", "iredapd", "restart");

    expect(res.settled?.status).toBe("missing");
  });
});

describe("fail2ban operations", () => {
  it.each(["host", "container"] as const)("quotes addresses and jails through the shared %s engine builder", (flavor) => {
    expect(mailFail2banBanCommand(flavor, "2001:db8::1", "postfix-sasl")).toContain("fail2ban-client set 'postfix-sasl' banip '2001:db8::1'");
    expect(mailFail2banUnbanCommand(flavor, "203.0.113.10", "dovecot")).toContain("fail2ban-client set 'dovecot' unbanip '203.0.113.10'");
    expect(() => mailFail2banUnbanCommand(flavor, "--all")).toThrow();
  });
  it.each([banFail2banIp, unbanFail2banIp])("rejects invalid IPs before acquiring a mail connection", async (action) => {
    await expect(action("srv_1", "--all", "postfix")).rejects.toMatchObject({ statusCode: 400 });
    expect(runMailCommand).not.toHaveBeenCalled();
  });
  it("rejects malformed status and mismatched jail counts", () => {
    for (const text of ["", "not a status", "Number of jail: 1\nJail list:\n", "Number of jail: 0\nJail list: postfix", "Number of jail: 2\nJail list: postfix, postfix"]) {
      expect(() => parseFail2banStatus(text)).toThrow();
    }
    expect(parseFail2banStatus("Status\nNumber of jail: 0\nJail list:\n")).toEqual({ jails: [] });
    expect(() => parseFail2banJailStatus("postfix", "Status for the jail: postfix")).toThrow();
  });
  it("fails the status read when a listed jail cannot be inspected", async () => {
    runMailCommand.mockResolvedValueOnce({ flavor: "container", output: "Number of jail: 1\nJail list: postfix\n__EXIT=0__" }).mockRejectedValueOnce(new Error("connection lost"));
    await expect(getFail2banStatus("srv_1")).rejects.toThrow("connection lost");
  });
  it("does not treat an exit failure or missing exit marker as an empty list", async () => {
    for (const output of ["__EXIT=1__", "interrupted"]) {
      runMailCommand.mockResolvedValueOnce({ flavor: "container", output });
      await expect(getFail2banStatus("srv_1")).rejects.toBeInstanceOf(MailComponentActionError);
    }
  });
  it("parses overall status and individual jail stats", async () => {
    replies(
      "Status\n|- Number of jail:\t2\n`- Jail list:\tdovecot, postfix\n",
      "Status for the jail: dovecot\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t1\n`- Actions\n   |- Currently banned:\t0\n   |- Total banned:\t0\n   `- Banned IP list:\t\n",
      "Status for the jail: postfix\n|- Filter\n|  |- Currently failed:\t2\n|  |- Total failed:\t10\n`- Actions\n   |- Currently banned:\t1\n   |- Total banned:\t3\n   `- Banned IP list:\t89.168.41.226\n",
    );

    const res = await getFail2banStatus("srv_1");
    expect(res.jails).toEqual(["dovecot", "postfix"]);
    expect(res.details?.postfix.currentlyBanned).toBe(1);
    expect(res.details?.postfix.bannedIps).toEqual(["89.168.41.226"]);
    expect(res.details?.dovecot.currentlyBanned).toBe(0);
  });

  it("executes banip command on specified or default jail", async () => {
    replies("1");
    const res = await banFail2banIp("srv_1", "1.2.3.4", "postfix");
    expect(res.success).toBe(true);
    expect(res.output).toBe("1");
  });

  it("executes unbanip command across all jails or in specific jail", async () => {
    replies("1");
    const res = await unbanFail2banIp("srv_1", "89.168.41.226");
    expect(res.success).toBe(true);
    expect(res.output).toBe("1");
  });
});
