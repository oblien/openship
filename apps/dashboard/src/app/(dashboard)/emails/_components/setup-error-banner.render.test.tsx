// No DOM needed: renderToStaticMarkup runs no effects, and the banner is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { SetupErrorBanner } from "./setup-error-banner";

function render(props: React.ComponentProps<typeof SetupErrorBanner>) {
  return renderToStaticMarkup(
    <I18nProvider>
      <SetupErrorBanner {...props} />
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

/**
 * #492: the message is the whole point of this banner — the reporter's real
 * cause (`Permission denied`) was reachable only through the api container's
 * logs. Whatever the server said has to reach the screen verbatim.
 */
describe("SetupErrorBanner", () => {
  it("shows the server's own failure text under the title", () => {
    const out = text(
      render({
        title: "Setup couldn't start",
        message:
          "Can't start mail setup: Permission denied (publickey,password). Openship could not run a single command on this server.",
      }),
    );
    expect(out).toContain("Setup couldn't start");
    expect(out).toContain("Permission denied (publickey,password)");
  });

  it("offers a retry when there is a step to resume from", () => {
    const out = text(
      render({ title: "Setup failed", message: "boom", resumeStep: 7, onResume: () => {} }),
    );
    expect(out).toContain("7");
    expect(out.toLowerCase()).toContain("retry");
  });

  it("offers no retry for a failure that never started a step", () => {
    // Nothing was attempted, so "retry from step N" would be a lie.
    const out = text(render({ title: "Setup couldn't start", message: "no route to host" }));
    expect(out.toLowerCase()).not.toContain("retry");
    expect(out).toContain("no route to host");
  });
});
