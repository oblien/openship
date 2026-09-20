import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import type { MailPortReachability } from "@/lib/api";
import en from "@/i18n/locales/en/emailsAdmin.json";
import { ReachabilitySection } from "./health-tab";

const warning =
  "Inbound TCP 25 could not be verified. Test receiving independently; an SMTP relay handles outgoing mail only.";

function reading(status: "fail" | "unknown"): MailPortReachability {
  return {
    hostname: "mail.example.com",
    address: "203.0.113.10",
    checkedAt: 0,
    status,
    ...(status === "unknown" ? { detail: warning } : {}),
    ports: [
      {
        key: "smtp",
        port: 25,
        label: "SMTP inbound",
        status: "blocked",
        listening: true,
        exposed: true,
        reachable: false,
        failure: status === "unknown" ? "timeout" : "refused",
        detail: status === "unknown" ? "no response within 1500ms" : "ECONNREFUSED",
      },
      ...(["smtps", "submission", "imaps"] as const).map((key, index) => ({
        key,
        port: [465, 587, 993][index],
        label: key,
        status: "reachable" as const,
        listening: true,
        exposed: true,
        reachable: true,
      })),
    ],
  };
}

function render(reachability: MailPortReachability) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ReachabilitySection
        reachability={reachability}
        error={null}
        refreshing={false}
        onRefresh={() => {}}
      />
    </I18nProvider>,
  );
}

describe("mail public reachability", () => {
  it("shows the inbound warning and raw timeout without diagnosing a firewall failure", () => {
    const html = render(reading("unknown"));

    expect(html).toContain(warning);
    expect(html).toContain("no response within 1500ms");
    expect(html).toContain(en.health.reachability.status.unknown);
    expect(html).not.toContain(en.health.reachability.status.blocked);
    expect(html).not.toContain(en.health.reachability.remediation);
  });

  it("keeps a refused SMTP connection visibly blocked", () => {
    const html = render(reading("fail"));

    expect(html).toContain(en.health.reachability.status.blocked);
    expect(html).toContain(en.health.reachability.remediation);
    expect(html).not.toContain(warning);
  });

  it("keeps a blocked client port actionable even when SMTP also times out", () => {
    const reachability = reading("unknown");
    reachability.status = "fail";
    delete reachability.detail;
    reachability.ports[1] = {
      ...reachability.ports[1],
      status: "blocked",
      reachable: false,
      failure: "timeout",
    };
    const html = render(reachability);

    expect(html).toContain(en.health.reachability.status.blocked);
    expect(html).toContain(en.health.reachability.remediation);
    expect(html).not.toContain(en.health.reachability.status.unknown);
  });
});
