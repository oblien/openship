// No DOM needed: renderToStaticMarkup runs no effects, and the card is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import type { ContainerApplyActive, ContainerApplyStep } from "@/lib/api/system";
import type { ApplyOutcome } from "@/lib/infra-apply-status";
import { InfraFleetCard } from "./InfraFleetCard";

type Counts = {
  attention: number;
  updates: number;
  healthy: number;
  stopped: number;
  behind: number;
  applying: number;
};

const IDLE: Counts = { attention: 0, updates: 0, healthy: 3, stopped: 0, behind: 0, applying: 0 };

function steps(running: ContainerApplyStep["id"] | null): ContainerApplyStep[] {
  return (["pull", "recreate", "verify"] as const).map((id, i) => ({
    id,
    label: id,
    status:
      running === null
        ? "pending"
        : i < (["pull", "recreate", "verify"] as const).indexOf(running)
          ? "done"
          : id === running
            ? "running"
            : "pending",
  }));
}

function target(over: Partial<ContainerApplyActive> = {}): ContainerApplyActive {
  return {
    serverId: "srv_1",
    serverName: "web-1",
    component: "edge",
    state: "running",
    intent: "update",
    sessionId: "capp_1",
    steps: steps("pull"),
    ...over,
  };
}

function render(
  over: {
    counts?: Partial<Counts>;
    active?: ContainerApplyActive[];
    outcome?: ApplyOutcome | null;
    onViewLogs?: (t: ContainerApplyActive) => void;
  } = {},
) {
  return renderToStaticMarkup(
    <I18nProvider>
      <InfraFleetCard
        counts={{ ...IDLE, ...over.counts }}
        scanning={false}
        applying={null}
        active={over.active ?? []}
        outcome={over.outcome ?? null}
        onScan={() => {}}
        onApply={() => {}}
        onViewLogs={over.onViewLogs ?? (() => {})}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("resting state", () => {
  it("says everything is up to date when there is nothing to do", () => {
    const out = text(render());
    expect(out).toContain("All components up to date");
    expect(out).not.toContain("Updating");
  });

  it("offers the bulk actions for work that is not underway", () => {
    const out = text(
      render({ counts: { updates: 1, behind: 2, stopped: 1, healthy: 2, attention: 1 } }),
    );
    expect(out).toContain("Update all (2)");
    expect(out).toContain("Restart stopped (1)");
    expect(out).toContain("1 with updates");
  });

  it("agrees with itself at one — never '1 need attention'", () => {
    const out = text(render({ counts: { attention: 1, healthy: 2 } }));
    expect(out).toContain("1 needs attention");
    expect(out).not.toContain("1 need attention");
  });
});

describe("in flight", () => {
  it("reports the run, its phase and its percentage", () => {
    const out = text(render({ counts: { applying: 1 }, active: [target()] }));
    expect(out).toContain("Updating 1 component");
    expect(out).toContain("Pulling image");
    expect(out).toContain("17%");
    expect(out).toContain("web-1");
  });

  it("does not claim everything is up to date while a swap is running", () => {
    const out = text(render({ counts: { applying: 1 }, active: [target()] }));
    expect(out).not.toContain("All components up to date");
  });

  it("follows the step model", () => {
    expect(text(render({ active: [target({ steps: steps("recreate") })] }))).toContain("Recreating");
    expect(text(render({ active: [target({ steps: steps("verify") })] }))).toContain("Verifying");
  });

  it("calls a restart a restart, and never narrates a pull for one", () => {
    const out = text(
      render({ active: [target({ intent: "repair", steps: steps(null) })] }),
    );
    expect(out).toContain("Restarting 1 component");
    expect(out).not.toContain("Pulling image");
  });

  it("shows a queued target as queued, with no log to open", () => {
    const out = render({
      active: [target({ state: "queued", sessionId: undefined, steps: undefined })],
    });
    expect(text(out)).toContain("Queued");
    expect(text(out)).not.toContain("View logs");
  });

  it("offers the live log for a running target", () => {
    expect(text(render({ active: [target()] }))).toContain("View logs");
  });

  it("collapses a long queue instead of growing the card", () => {
    const many = ["srv_1", "srv_2", "srv_3", "srv_4", "srv_5"].map((id) =>
      target({ serverId: id, serverName: id }),
    );
    const out = text(render({ active: many }));
    expect(out).toContain("Updating 5 components");
    expect(out).toContain("+2 more");
    expect(out).not.toContain("srv_5");
  });

  it("keeps the counts for work it is NOT doing, and disables the actions", () => {
    const html = render({
      counts: { attention: 2, updates: 1, applying: 1, behind: 1 },
      active: [target()],
    });
    expect(text(html)).toContain("2 need attention");
    expect(text(html)).toContain("Updating 1 component");
    // A second bulk while one is running re-queues containers already accepted.
    expect(html).toContain("disabled");
  });
});

describe("settled", () => {
  it("reports the finish the counts can never carry", () => {
    const out = text(render({ outcome: { done: 1, failed: 0 } }));
    expect(out).toContain("1 component updated");
    expect(out).not.toContain("All components up to date");
  });

  it("names a failure and its reason", () => {
    const out = text(
      render({
        counts: { updates: 1, behind: 1 },
        outcome: { done: 0, failed: 1, error: "could not pull the image" },
      }),
    );
    expect(out).toContain("1 component didn't finish");
    expect(out).toContain("could not pull the image");
  });

  it("stays quiet about the last run while a new one is going", () => {
    const out = text(render({ active: [target()], outcome: { done: 1, failed: 0 } }));
    expect(out).not.toContain("1 component updated");
  });
});
