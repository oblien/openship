// SSR markup only: effects don't run, so ConnectionCard stays in its skeleton
// state — enough to assert the connect surface is (or isn't) mounted.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { ToastProvider } from "@/context/ToastContext";
import {
  CleanDeployProgressCard,
  installProgressPercent,
  installStepIndex,
} from "./CleanDeployProgress";
import type { StepStatus } from "@/components/deploy/InstallStepper";

type Props = React.ComponentProps<typeof CleanDeployProgressCard>;

const baseProps: Props = {
  appId: "grafana",
  title: "Grafana",
  phase: "installing",
  progress: 0,
  phaseLabel: "Queued…",
  liveUrl: null,
  errorMsg: "",
  deploymentId: "dep_1",
  onGoToProject: () => {},
  onViewBuild: () => {},
  onRetry: () => {},
};

function render(props: Partial<Props>) {
  return renderToStaticMarkup(
    <I18nProvider>
      <PlatformProvider>
        <ToastProvider>
          <CleanDeployProgressCard {...baseProps} {...props} />
        </ToastProvider>
      </PlatformProvider>
    </I18nProvider>,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x2026;|…/g, "…").replace(/\s+/g, " ").trim();
}

describe("CleanDeployProgressCard — installing", () => {
  it("with phases: renders the JSON-mapped stepper + foldable logs, not the legacy bar", () => {
    const html = render({
      phase: "installing",
      phases: { images: "done", services: "active" },
      services: [{ serviceName: "backend", serviceId: "s1", status: "running" }],
      logs: "hello",
    });
    const out = text(html);
    expect(out).toContain("Installation steps");
    expect(out).toContain("Preparing images");
    expect(out).toContain("Starting services");
    expect(out).toContain("backend"); // per-service sub-list
    expect(out).toContain("Hide logs"); // logs open by default → toggle offers "Hide"
    // The legacy CENTERED layout must be gone. Matched on its container, not on a
    // utility class: the stepper layout now has a progress bar of its own in the
    // aside, so "no bar" no longer identifies the layout at all.
    expect(html).not.toContain("mx-auto max-w-2xl");
    // images done → check icon; services active → spinner
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain("animate-spin");
  });

  it("shows the app-setup phase + its authored sub-steps only when present", () => {
    const withSetup = text(
      render({
        phase: "installing",
        phases: { services: "done", "app-setup": "active" },
        appSetupSteps: [{ id: "adminKey", label: "Generate admin key" }],
      }),
    );
    expect(withSetup).toContain("Finishing setup");
    expect(withSetup).toContain("Generate admin key");

    // Pull-only app (no prepare steps) never shows a stranded app-setup row.
    const noSetup = text(render({ phase: "installing", phases: { images: "skipped" } }));
    expect(noSetup).not.toContain("Finishing setup");
  });

  it("without phases (legacy mail wizard): renders the progress bar, no stepper", () => {
    const html = render({ phase: "installing", phases: undefined, logs: "x", progress: 40 });
    expect(html).toContain("mx-auto max-w-2xl"); // the legacy centered container
    expect(html).toContain("h-1.5 w-full"); // the numeric progress bar's track
    expect(text(html)).not.toContain("Installation steps");
  });
});

describe("CleanDeployProgressCard — install progress readout", () => {
  it("replaces the status pill with a bar, a step counter and the service tally", () => {
    const html = render({
      phase: "installing",
      phases: { images: "done", services: "active" },
      services: [
        { serviceName: "db", serviceId: "s1", status: "running" },
        { serviceName: "web", serviceId: "s2", status: "deploying" },
        { serviceName: "worker", serviceId: "s3", status: "pending" },
        { serviceName: "cache", serviceId: "s4", status: "pending" },
      ],
      phaseLabel: "Starting services",
      onStop: () => {},
    });
    const out = text(html);
    // 3 phases (this app has no app-setup) → images done (1) + services active at
    // 1/4 of its services (0.25), over 3 → 42%.
    expect(out).toContain("42%");
    expect(out).toContain("Step 2 of 3");
    expect(out).toContain("1 of 4 services ready");
    expect(html).toContain("animate-progress-sweep");
    // The dot the pill used to carry is gone from the aside.
    expect(html).not.toContain("bg-info-solid");
  });

  it("renders the chosen configuration as the aside read-out", () => {
    const out = text(
      render({
        phase: "installing",
        phases: { services: "active" },
        summary: [
          { id: "destination", label: "Destination", value: "prod-vps" },
          { id: "ep", label: "Web UI", value: "posthog.opsh.io", mono: true },
        ],
      }),
    );
    expect(out).toContain("Configuration");
    expect(out).toContain("Destination");
    expect(out).toContain("prod-vps");
    expect(out).toContain("posthog.opsh.io");
  });

  it("keeps the summary on the terminal screens, where the pill carries a glyph", () => {
    const html = render({
      phase: "done",
      phases: { ready: "done" },
      liveUrl: "https://x.example.com",
      summary: [{ id: "destination", label: "Destination", value: "prod-vps" }],
    });
    expect(text(html)).toContain("prod-vps");
    expect(text(html)).toContain("Live");
    expect(html).toContain("lucide-check");
    expect(html).not.toContain("animate-progress-sweep"); // no bar once it's settled
  });

  it("omits the summary card entirely when there's nothing configured to show", () => {
    const out = text(render({ phase: "installing", phases: {}, summary: [] }));
    expect(out).not.toContain("Configuration");
  });
});

describe("installProgressPercent", () => {
  const row = (status: StepStatus, subs: StepStatus[] = []) => ({ status, subs });

  it("weighs phases equally and sub-steps inside the active phase", () => {
    expect(installProgressPercent([])).toBe(0);
    // Nothing started yet → the visible floor, not 0.
    expect(installProgressPercent([row("pending"), row("pending")])).toBe(4);
    // A sub-list-less active phase is worth half of it.
    expect(installProgressPercent([row("done"), row("active"), row("pending"), row("pending")])).toBe(38);
    // Services advance inside their own phase: 5/10 up → 1.5/4.
    expect(
      installProgressPercent([
        row("done"),
        row("active", [
          ...Array<StepStatus>(5).fill("done"),
          ...Array<StepStatus>(5).fill("pending"),
        ]),
        row("pending"),
        row("pending"),
      ]),
    ).toBe(38);
    // A skipped phase counts as passed (a pull-only app skips image prep).
    expect(installProgressPercent([row("skipped"), row("done")])).toBe(99);
  });

  it("never reaches 100 while the install is still running", () => {
    expect(installProgressPercent([row("done"), row("active", ["done", "done"])])).toBeLessThan(100);
  });
});

describe("installStepIndex", () => {
  it("points at the phase in flight, or the last settled one while queued", () => {
    expect(installStepIndex([{ status: "done" }, { status: "active" }, { status: "pending" }])).toBe(2);
    expect(installStepIndex([{ status: "done" }, { status: "done" }, { status: "pending" }])).toBe(2);
    // Queued: nothing settled, nothing active → still "step 1".
    expect(installStepIndex([{ status: "pending" }, { status: "pending" }])).toBe(1);
  });
});

describe("CleanDeployProgressCard — Stop / status pill / header", () => {
  it("offers a Stop button while installing when onStop is wired", () => {
    const out = text(render({ phase: "installing", phases: { services: "active" }, onStop: () => {} }));
    expect(out).toContain("Stop install");
    expect(out).toContain("Installing"); // aside status pill
    expect(out).toContain("Apps"); // breadcrumb back to the catalog
  });

  it("shows a stopping state while the cancel is in flight", () => {
    const out = text(
      render({ phase: "installing", phases: {}, onStop: () => {}, isStopping: true }),
    );
    expect(out).toContain("Stopping…");
    expect(out).not.toContain("Stop install");
  });

  it("reads the done screen as Live in the status pill", () => {
    const out = text(render({ phase: "done", phases: {}, liveUrl: "https://x.example.com" }));
    expect(out).toContain("Live");
  });
});

describe("CleanDeployProgressCard — done", () => {
  it("shows the first-login card with the authored default credentials", () => {
    const out = text(
      render({
        phase: "done",
        phases: {},
        liveUrl: "https://grafana.example.com",
        firstLogin: { username: "admin", password: "admin", note: "Change it soon." },
      }),
    );
    expect(out).toContain("First login");
    expect(out).toContain("Username");
    expect(out).toContain("Password");
    expect(out).toContain("admin");
    expect(out).toContain("Change it soon.");
    expect(out).toContain("Open app"); // liveUrl CTA
  });

  it("mounts the connect card only when a project id is given", () => {
    const withConnect = render({
      phase: "done",
      phases: {},
      connect: { projectId: "proj_1", appTemplateId: "grafana" },
    });
    expect(withConnect).toContain("w-44"); // ConnectionCard skeleton marker

    const withoutConnect = render({ phase: "done", phases: {} });
    expect(withoutConnect).not.toContain("w-44");
  });
});

describe("CleanDeployProgressCard — error", () => {
  it("shows the failure copy, the message, and the view-details affordance", () => {
    const out = text(
      render({ phase: "error", phases: {}, errorMsg: "boom", logs: "trace", deploymentId: "dep_9" }),
    );
    expect(out).toContain("Install failed");
    expect(out).toContain("boom");
    expect(out).toContain("View technical details");
  });

  it("a user cancel reads as a neutral 'cancelled', not a failure", () => {
    const out = text(
      render({
        phase: "error",
        phases: {},
        cancelled: true,
        errorMsg: "Install cancelled",
        deploymentId: "dep_9",
      }),
    );
    expect(out).toContain("Install cancelled");
    expect(out).not.toContain("Install failed");
    expect(out).toContain("Cancelled"); // status pill, not "Failed"
    expect(out).not.toContain("Failed");
    expect(out).toContain("Start over"); // ghost action, not "Back"
  });

  // The regression this screen was built to kill: the heading said "Install
  // cancelled" and the line under it said "Install failed", because the wizard's
  // message fallback fires independently of the neutral-cancel flag.
  it("never prints a verdict as its own reason", () => {
    const cancelled = text(
      render({ phase: "error", phases: {}, cancelled: true, errorMsg: "Install failed" }),
    );
    expect(cancelled).toContain("Install cancelled");
    expect(cancelled).not.toContain("Install failed");

    // Same rule the other way: an errorMsg that merely echoes the verdict adds
    // nothing, so it is dropped. The two remaining occurrences are the header
    // status line and the card heading — the same pairing the done screen uses.
    const echo = text(render({ phase: "error", phases: {}, errorMsg: "Install failed" }));
    const silent = text(render({ phase: "error", phases: {}, errorMsg: "" }));
    expect(echo.match(/Install failed/g)).toHaveLength(
      (silent.match(/Install failed/g) ?? []).length,
    );
  });

  it("tells a cancelled operator what survived, so Start over isn't a guess", () => {
    const out = text(render({ phase: "error", phases: {}, cancelled: true }));
    expect(out).toContain("You stopped this install");
    expect(out).toContain("data volumes were kept");
    expect(out).not.toContain("Failed");
  });

  // A cancel the operator did NOT cause — the boot sweep cancels in-flight
  // deployments after an API restart and writes its own reason. Blaming that on
  // the user is the same species of lie as "Install failed" over a cancel, so the
  // attribution and the cleanup statement are separate strings.
  //
  // The cleanup claim goes with it: the sweep is a bare DB write that tears nothing
  // down (deployment.repo.ts sweepStaleInFlight), so "the containers were removed"
  // would be false on exactly this path. A server reason is the signal for both.
  it("does not blame the operator for a cancel they did not cause", () => {
    const out = text(
      render({
        phase: "error",
        phases: {},
        cancelled: true,
        errorMsg: "Interrupted by a server restart — redeploy to try again.",
      }),
    );
    expect(out).toContain("Interrupted by a server restart");
    expect(out).not.toContain("You stopped this install");
    // No teardown ran on this path, so the teardown copy must not appear.
    expect(out).not.toContain("data volumes were kept");
  });

  // A real reason displaces the generic stand-in rather than trailing it.
  it("does not pad a real failure reason with the generic fallback", () => {
    const out = text(render({ phase: "error", phases: {}, errorMsg: "clickhouse exited 1" }));
    expect(out).toContain("clickhouse exited 1");
    expect(out).not.toContain("It stopped before everything was running");
  });

  // A settled install must not mount a console that can only ever say "waiting".
  it("mounts no log panel when the install produced no output", () => {
    const empty = render({ phase: "error", phases: {}, cancelled: true, logs: "" });
    expect(empty).not.toContain("deploy logs");
    expect(text(empty)).not.toContain("Waiting for output");

    const withLogs = render({ phase: "error", phases: {}, logs: "boot: ok" });
    expect(withLogs).toContain("deploy logs");
    expect(text(withLogs)).toContain("boot: ok");
  });

  it("keeps the checklist on the terminal screen, with nothing left spinning", () => {
    const html = render({
      phase: "error",
      phases: { images: "done", services: "active" },
      services: [{ serviceId: "s1", serviceName: "clickhouse", status: "failed" } as never],
      cancelled: true,
      deploymentId: "dep_9",
    });
    const out = text(html);
    expect(out).toContain("Installation steps");
    expect(out).toContain("Stopped at Starting services");
    expect(out).toContain("clickhouse");
    // The in-flight phase settles to the neutral slash, not a spinner and not a
    // danger alert — a cancel is not a fault.
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("lucide-circle-slash");
    expect(html).not.toContain("lucide-circle-alert");
    expect(out).not.toContain("Failed");
  });

  it("marks the phase that broke as failed when it really did fail", () => {
    const html = render({
      phase: "error",
      phases: { images: "done", services: "active" },
      errorMsg: "clickhouse exited 1",
      deploymentId: "dep_9",
    });
    expect(text(html)).toContain("Stopped at Starting services");
    expect(html).toContain("lucide-circle-alert"); // the in-flight phase carries the fault
    expect(html).not.toContain("animate-spin");
  });

  // An install that never reported a phase (a resumed one — the status read
  // resolves before the SSE replay) has nothing to show, and an all-pending
  // checklist is filler.
  it("omits the checklist entirely when no phase ever moved", () => {
    const out = text(render({ phase: "error", phases: {}, cancelled: true }));
    expect(out).not.toContain("Installation steps");
    expect(out).not.toContain("Stopped at");
  });

  // partial_failure: the compose pipeline broadcasts `ready: done` before the
  // roll-up is written, and closes `services` as soon as ONE service came up. Taken
  // literally that put a green "Live" check and a green "Starting services" under
  // the heading "Install failed", above a red child.
  it("never shows a completed phase — or a live check — under a failure", () => {
    const html = render({
      phase: "error",
      phases: { images: "done", services: "done", ready: "done" },
      services: [
        { serviceId: "a", serviceName: "grafana", status: "running" },
        { serviceId: "b", serviceName: "clickhouse", status: "failed" },
      ] as never,
      errorMsg: "Some services failed to deploy",
    });
    const out = text(html);
    expect(out).toContain("Install failed");
    // The phase holding a failed service carries the fault, and `ready` is demoted
    // from done to unreached — an install that failed is not live.
    expect(out).toContain("Stopped at Starting services · 1 of 2 services ready");
    expect(html).toContain("lucide-circle-slash"); // `ready`, unreached
    expect(html).toContain("lucide-circle-alert"); // `services`, holding the failure
  });

  // A compose run can carry on past a failed phase (a partial image build still
  // deploys what built). Naming the first failure then contradicts the checklist
  // beside it, so the line is withheld and the checklist speaks alone.
  it("withholds the stopped-at line when the run continued past the break", () => {
    const out = text(
      render({
        phase: "error",
        phases: { images: "failed", services: "done" },
        services: [{ serviceId: "a", serviceName: "grafana", status: "running" }] as never,
      }),
    );
    expect(out).toContain("Installation steps");
    expect(out).not.toContain("Stopped at");
  });

  // Which placeholder each panel gets is the whole point of splitting them; without
  // this, swapping the two strings passes every other test.
  it("promises more output only while something is still streaming", () => {
    const installing = text(render({ phase: "installing", phases: { images: "active" }, logs: "" }));
    expect(installing).toContain("Waiting for output…");
    expect(installing).not.toContain("No output was captured");
  });

  // The LEGACY layout (mail wizard — no `phases`) had the same stutter and no test
  // at all. The verdict rule is computed above the layout split so both get it.
  it("legacy layout: does not print the verdict as its own reason either", () => {
    const echo = text(render({ phase: "error", errorMsg: "Install failed" }));
    const silent = text(render({ phase: "error", errorMsg: "" }));
    expect(echo).toContain("Install failed");
    expect(echo.match(/Install failed/g)).toHaveLength(
      (silent.match(/Install failed/g) ?? []).length,
    );

    // A real reason still shows.
    const real = text(render({ phase: "error", errorMsg: "imap host unreachable" }));
    expect(real).toContain("imap host unreachable");
  });

  it("legacy layout: still renders the centered bar, not the stepper", () => {
    const html = render({ phase: "error", errorMsg: "boom" });
    expect(html).toContain("mx-auto max-w-2xl");
    expect(text(html)).not.toContain("Installation steps");
  });
});
