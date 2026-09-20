// No DOM needed: effects do not run during server rendering, which also pins
// the important missing-row state where the repair action must remain visible.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { MailboxesTab } from "./mailboxes-tab";

vi.mock("../../_lib/mail-section", () => ({
  useMailRailOwnsTabs: () => false,
}));

describe("MailboxesTab platform mailbox recovery", () => {
  it("shows the repair action even before a platform mailbox row is loaded", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModalProvider>
          <MailboxesTab
            serverId="srv_mail"
            primaryDomain="example.com"
            selectedDomain="example.com"
            onSelectDomain={() => {}}
          />
        </ModalProvider>
      </I18nProvider>,
    );

    expect(html).toContain("Rotate platform password");
    expect(html).toContain("Loading…");
  });
});
