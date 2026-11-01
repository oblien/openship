import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { MailEngineBanner } from "./engine-banner";

const fix = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useInfraFix", () => ({ useInfraFix: () => fix }));
vi.mock("@/hooks/useReattachActiveFix", () => ({ useReattachActiveFix: vi.fn() }));

it.each(["container", "host", "none"] as const)(
  "does not offer to repair %s mail when the latest observation is unavailable",
  (flavor) => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <MailEngineBanner
          serverId="mail-1"
          engine={{ flavor, running: false }}
          observationError="Connection lost"
          onRepaired={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain("Mail status unavailable");
    expect(html).toContain("Retry status");
    expect(html).not.toContain("bg-danger-solid");
    expect(html).not.toContain("force=wizard");
    expect(fix).not.toHaveBeenCalled();
  },
);
