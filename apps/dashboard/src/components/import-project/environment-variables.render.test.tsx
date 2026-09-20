// No DOM: renderToStaticMarkup runs no effects, and settings mode needs no
// DeploymentContext (toast has a default context value).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import EnvironmentVariables from "./EnvironmentVariables";

type Props = React.ComponentProps<typeof EnvironmentVariables>;

function render(props: Partial<Props> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <EnvironmentVariables
        mode="settings"
        isEditingMode={true}
        showSettingsActions={false}
        envVars={[]}
        onEnvVarsChange={() => {}}
        {...props}
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

const ROWS = [{ key: "PORT", value: "3000", visible: true }];

describe("EnvironmentVariables empty state", () => {
  it("puts Add Variable inside the empty state, not in a row below it", () => {
    const html = render();
    // The one dashed box, and the CTA lives in it — the bottom add row (the
    // full-width dashed variant) only exists once there are rows to add after.
    expect(html).toContain("border border-dashed");
    expect(html).toContain("bg-primary");
    expect(text(html)).toContain("Add Variable");
    expect(html).not.toContain("border-dashed border-border/60");
    // The hint used to tell the operator to click a button that was outside the
    // box; now the button is in the box, so it only covers paste / drop.
    expect(text(html)).not.toContain('Click "Add Variable"');
    expect(text(html)).toContain("Paste a .env block anywhere in this box");
    // …and only once: the duplicate paste line under the box is gone when empty.
    expect(text(html)).not.toContain("Paste a full .env block");
  });

  it("read-only empty state offers no add affordance", () => {
    const html = render({ isEditingMode: false });
    expect(text(html)).toContain("No environment variables");
    expect(text(html)).toContain('Click "Edit" to manage environment variables');
    expect(text(html)).not.toContain("Add Variable");
  });

  it("with rows, the add affordance becomes the full-width dashed row", () => {
    const html = render({ envVars: ROWS });
    expect(text(html)).not.toContain("No environment variables");
    expect(html).toContain("border-dashed border-border/60");
    expect(text(html)).toContain("Add Variable");
    expect(text(html)).toContain("Paste a full .env block");
  });
});

describe("EnvironmentVariables reveal affordance", () => {
  // The mask sentinel, shared with the API via @repo/core. A row holding it has no real
  // value in local state, so its eye is only meaningful when something can resolve it.
  const MASKED = [{ key: "POSTGRES_DB", value: "••••••••", visible: false }];

  /** The eye/eye-off toggle sits inside the value field's relative wrapper. */
  const eyeCount = (html: string) => (html.match(/class="absolute end-2\.5/g) ?? []).length;

  it("gives a masked row an eye when a reveal source is wired", () => {
    // The regression: an edit of an existing compose project wired no source, so rows
    // rendered as dots with no toggle — unreadable AND unrevealable.
    const html = render({ envVars: MASKED, onReveal: async () => ({}) });
    expect(eyeCount(html)).toBe(1);
  });

  it("omits it when nothing can resolve the sentinel", () => {
    // Deliberate: the toggle could only ever display the dots themselves as text.
    expect(eyeCount(render({ envVars: MASKED }))).toBe(0);
  });

  it("renders a preserved project secret as set without putting plaintext in state", () => {
    const html = render({
      envVars: [{ key: "AUTH_SECRET", value: "", visible: true, preserveValue: true }],
    });
    expect(html).toContain('placeholder="••••••••"');
    expect(eyeCount(html)).toBe(0);
  });

  it("gives a plaintext row an eye with or without a source", () => {
    // This asymmetry is what the operator saw as "some rows have no show button": an
    // empty or typed value isn't masked, so it kept its eye while masked neighbours in
    // the SAME list had none.
    expect(eyeCount(render({ envVars: ROWS }))).toBe(1);
    expect(
      eyeCount(render({ envVars: [{ key: "POSTGRES_PASSWORD", value: "", visible: false }] })),
    ).toBe(1);
  });

  it("gives every row in a mixed list an eye once a source is wired", () => {
    const html = render({
      envVars: [...MASKED, { key: "POSTGRES_PASSWORD", value: "", visible: false }],
      onReveal: async () => ({}),
    });
    expect(eyeCount(html)).toBe(2);
  });
});

describe("EnvironmentVariables hideTitle", () => {
  it("keeps the toolbar but drops the title a host header already shows", () => {
    const html = render({ hideTitle: true, borderless: true });
    const out = text(html);
    expect(out).not.toContain("None set");
    expect(out).toContain("Paste .env");
    expect(out).toContain("Upload .env");
    // The panel's own key badge goes with the title — the modal header has one.
    expect(html).not.toContain("bg-violet-500/10");
  });

  it("still renders the title by default", () => {
    const out = text(render());
    expect(out).toContain("Environment Variables");
    expect(out).toContain("None set");
  });
});

describe("EnvironmentVariables embedded Compose requirements (#673)", () => {
  it("marks a partially interpolated row as needing a value", () => {
    const value = "postgresql://user:@db/app";
    const html = render({
      envVars: [{ key: "DATABASE_URL", value, visible: true }],
      envMeta: {
        DATABASE_URL: {
          source: "interpolated",
          resolvedValue: value,
          required: true,
          unresolvedVariables: ["POSTGRES_PASSWORD"],
        },
      },
    });

    expect(text(html)).toContain("Needs value");
  });
});

describe("EnvironmentVariables showSecretToggle", () => {
  it("omits the secret toggle by default", () => {
    const html = render({ envVars: ROWS });
    expect(html).not.toContain("Mark as secret");
    expect(html).not.toContain("Marked secret");
  });

  it("renders the secret toggle when showSecretToggle is true", () => {
    const html = render({ envVars: ROWS, showSecretToggle: true });
    expect(html).toContain("Mark as secret");
  });

  it("marks a row as secret when isSecret is true", () => {
    const html = render({
      envVars: [{ key: "CUSTOM_VAR", value: "val", visible: false, isSecret: true }],
      showSecretToggle: true,
    });
    expect(html).toContain("Marked secret");
    expect(html).toContain("border-warning-border bg-warning-bg text-warning");
  });

  it("leaves a row un-marked when isSecret is explicitly false", () => {
    const html = render({
      envVars: [{ key: "API_KEY", value: "val", visible: true, isSecret: false }],
      showSecretToggle: true,
    });
    expect(html).toContain("Mark as secret");
    expect(html).toContain("border-border/60 bg-muted/30 text-muted-foreground");
  });

  it("falls back to looksLikeSecretKey when isSecret is undefined", () => {
    const html = render({
      envVars: [
        { key: "STRIPE_SECRET_KEY", value: "sk_live_123", visible: false },
        { key: "PORT", value: "3000", visible: true },
      ],
      showSecretToggle: true,
    });
    expect(html).toContain("Marked secret");
    expect(html).toContain("Mark as secret");
  });

  it("disables the secret toggle button when not in editing mode", () => {
    const html = render({
      envVars: ROWS,
      showSecretToggle: true,
      isEditingMode: false,
    });
    expect(html).toContain("disabled");
  });
});
