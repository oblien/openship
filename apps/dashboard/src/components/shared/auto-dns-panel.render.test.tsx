// No DOM needed: AutoDnsView is pure/presentational — renderToStaticMarkup runs
// no effects, so each plan status renders straight to markup we can assert on.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { AutoDnsView, type AutoDnsViewProps } from "./AutoDnsPanel";
import type { DnsPlanResult, DnsProvisionResult } from "@/lib/api/dns";

const noop = () => {};

function render(over: Partial<AutoDnsViewProps>) {
  const props: AutoDnsViewProps = {
    loading: false,
    plan: null,
    loadError: null,
    applying: false,
    result: null,
    applyError: null,
    onApply: noop,
    onReload: noop,
    ...over,
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <AutoDnsView {...props} />
    </I18nProvider>,
  );
}

/** Strip tags so assertions read against what the user actually sees. */
function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const matched = (records: DnsPlanResult["records"]): DnsPlanResult => ({
  status: "matched",
  provider: "cloudflare",
  zoneName: "example.com",
  records,
});

describe("AutoDnsView", () => {
  it("shows a checking state before the first plan arrives", () => {
    expect(text(render({ loading: true }))).toContain("Checking your DNS provider");
  });

  it("offers to connect a provider when none manages the zone — the CTA, not a button", () => {
    const html = render({ plan: { status: "none", records: [] } });
    expect(text(html)).toContain("Connect a DNS provider");
    expect(html).toContain("/settings?tab=dns");
    // Nothing is applyable, so no auto-configure button.
    expect(text(html)).not.toContain("Auto-configure DNS");
  });

  it("prompts a reconnect on an unauthorized token and surfaces the reason", () => {
    const html = render({
      plan: { status: "unauthorized", reason: "Token rejected by Cloudflare", records: [] },
    });
    expect(text(html)).toContain("Reconnect provider");
    expect(text(html)).toContain("Token rejected by Cloudflare");
    expect(html).toContain("/settings?tab=dns");
  });

  it("offers a retry when the provider was unreachable", () => {
    expect(text(render({ plan: { status: "unavailable", records: [] } }))).toContain("Retry");
  });

  it("names the managing provider and zone, and offers the button when there is work", () => {
    const html = render({
      plan: matched([
        { name: "app.example.com", type: "A", action: "create", desired: "192.0.2.1" },
      ]),
    });
    const out = text(html);
    expect(out).toContain("Cloudflare manages example.com");
    expect(out).toContain("Add"); // the "create" action badge
    expect(out).toContain("Auto-configure DNS");
  });

  it("disables the press and says so when every record is already in place", () => {
    const html = render({
      plan: matched([
        { name: "app.example.com", type: "A", action: "in-sync", desired: "192.0.2.1", current: "192.0.2.1" },
      ]),
    });
    const out = text(html);
    expect(out).toContain("All records in place");
    expect(out).not.toContain("Auto-configure DNS");
  });

  it("flags a conflict with the do-not-clobber note", () => {
    const out = text(
      render({
        plan: matched([
          { name: "example.com", type: "A", action: "conflict", desired: "192.0.2.1" },
        ]),
      }),
    );
    expect(out).toContain("Conflict");
    expect(out).toContain("Not managed by Openship");
  });

  it("renders the outcome log after apply, not the plan", () => {
    const result: DnsProvisionResult = {
      provisioned: false,
      records: [
        { name: "app.example.com", type: "A", outcome: "applied", action: "create" },
        {
          name: "example.com",
          type: "A",
          outcome: "failed",
          action: "conflict",
          error: "Existing records here are not managed by Openship.",
        },
      ],
    };
    const out = text(
      render({
        plan: matched([
          { name: "app.example.com", type: "A", action: "create", desired: "192.0.2.1" },
          { name: "example.com", type: "A", action: "conflict", desired: "192.0.2.1" },
        ]),
        result,
      }),
    );
    expect(out).toContain("Applied");
    expect(out).toContain("Failed");
    expect(out).toContain("not managed by Openship");
    // A partial apply reports it needs attention, not "done".
    expect(out).toContain("Some records need attention");
  });
});
