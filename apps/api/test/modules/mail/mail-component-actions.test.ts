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
vi.mock("../../../src/modules/mail/mail-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/mail/mail-engine")>()),
  runMailCommand: (...args: unknown[]) => runMailCommand(...args),
}));

import {
  getComponentLogs,
  runComponentAction,
  MailComponentActionError,
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
