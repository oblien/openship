// No DOM needed: renderToStaticMarkup runs no effects, and the list is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { MailServerList, type MailServerListItem } from "./mail-server-list";

function render(servers: MailServerListItem[]) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MailServerList
        servers={servers}
        onOpen={() => {}}
        onAddNew={() => {}}
        onRemove={() => {}}
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
    .replace(/&middot;|&#183;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

const base: MailServerListItem = {
  id: "s1",
  name: "hekai",
  host: "5.6.7.8",
  domain: "hekai.org",
  completed: false,
  active: false,
};

describe("MailServerList — status/issue line", () => {
  it("shows where an incomplete install stopped, with the step label", () => {
    const out = text(render([{ ...base, resumeStep: 6, resumeStepLabel: "Retrieve DKIM Keys" }]));
    expect(out).toContain("step 6");
    expect(out).toContain("Retrieve DKIM Keys");
  });

  it("shows nothing extra for a completed (running) server", () => {
    const out = text(
      render([{ ...base, id: "s2", domain: "oblien.com", completed: true, resumeStep: null }]),
    );
    expect(out.toLowerCase()).not.toContain("stopped");
  });

  it("shows nothing extra while an install is actively running", () => {
    // `active` (installing) shouldn't render the stopped line even if a stale
    // resumeStep is present — the pill already says "Installing".
    const out = text(render([{ ...base, active: true, resumeStep: 2 }]));
    expect(out.toLowerCase()).not.toContain("stopped");
  });
});
