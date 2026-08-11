// SSR markup only: effects don't run, so ConnectionCard stays in its skeleton
// state — enough to assert the connect surface is (or isn't) mounted.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { ToastProvider } from "@/context/ToastContext";
import { CleanDeployProgressCard } from "./CleanDeployProgress";

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
    // Legacy numeric progress bar must be gone in the stepper layout. Matched on
    // `h-1.5 w-full` (the bar's track), not bare `h-1.5` — that alone is a spacing
    // value the status pill's dot also uses, which made this assert on a
    // coincidence and let the legacy-path assertion below pass vacuously.
    expect(html).not.toContain("h-1.5 w-full");
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
    expect(html).toContain("h-1.5 w-full"); // the numeric progress bar's track
    expect(text(html)).not.toContain("Installation steps");
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
});
