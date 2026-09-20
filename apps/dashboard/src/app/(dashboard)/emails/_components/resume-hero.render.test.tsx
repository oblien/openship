// No DOM needed: renderToStaticMarkup runs no effects, and the hero is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { ResumeHero } from "./resume-hero";

function render(props: React.ComponentProps<typeof ResumeHero>) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ResumeHero {...props} />
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

/**
 * The hero is the resume-first CTA for a reopened incomplete install — it must
 * name the step to continue from and surface the halt reason so "Continue" is
 * the obvious action, not the demoted Reset in the log header.
 */
describe("ResumeHero", () => {
  it("names the paused step, its label, and offers continue-from-step", () => {
    const out = text(
      render({ stepId: 6, stepLabel: "Retrieve DKIM Keys", onResume: () => {} }),
    );
    expect(out).toContain("Step 6");
    expect(out).toContain("Retrieve DKIM Keys");
    expect(out.toLowerCase()).toContain("continue from step 6");
  });

  it("surfaces the halt reason when one is present", () => {
    const out = text(
      render({
        stepId: 6,
        stepLabel: "Retrieve DKIM Keys",
        error: "This server has no mail engine.",
        onResume: () => {},
      }),
    );
    expect(out).toContain("This server has no mail engine.");
  });

  it("shows the step number without a dangling colon when no label is known", () => {
    const out = text(render({ stepId: 3, onResume: () => {} }));
    expect(out).toContain("Step 3");
    expect(out).not.toContain("Step 3:");
  });
});
