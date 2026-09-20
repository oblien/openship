// No DOM: renderToStaticMarkup runs no effects. The component reads only
// `config.configDiagnostics` off the deployment context, so a cast stub is enough.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { DeploymentContext } from "@/context/DeploymentContext";
import type { DeploymentContextType } from "@/context/deployment/types";
import { ConfigDiagnostics } from "./ConfigDiagnostics";

type Diagnostics = { errors: string[]; warnings: string[]; wholeFile?: true };

function render(configDiagnostics?: Diagnostics) {
  const value = { config: { configDiagnostics } } as unknown as DeploymentContextType;
  return renderToStaticMarkup(
    <I18nProvider>
      <DeploymentContext.Provider value={value}>
        <ConfigDiagnostics />
      </DeploymentContext.Provider>
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

describe("ConfigDiagnostics (#641)", () => {
  it("renders nothing when the config parsed clean", () => {
    // The overwhelmingly common case: the banner must not reserve any space.
    expect(render()).toBe("");
    expect(render({ errors: [], warnings: [] })).toBe("");
  });

  it("lists a refused field and says the rest still applied", () => {
    const html = render({ errors: ["framework: must be one of: nextjs, vite"], warnings: [] });
    expect(text(html)).toContain("framework: must be one of");
    expect(text(html)).toContain("Refused");
    expect(text(html)).toContain("the rest of the file was applied");
    expect(text(html)).not.toContain("None of it was applied");
  });

  it("lists an unrecognized key as a warning, separately from refusals", () => {
    const html = render({ errors: [], warnings: ['Unknown field "buildComand" (ignored)'] });
    expect(text(html)).toContain("Not recognized");
    expect(text(html)).toContain("buildComand");
    expect(text(html)).not.toContain("Refused");
  });

  it("says NOTHING applied for a whole-file failure", () => {
    // The severity that used to be wrong: with bad JSON the overlay applies
    // nothing, so copy promising "the rest was applied" would be a lie.
    const html = render({
      errors: ["openship.json is not valid JSON — run `openship config validate`"],
      warnings: [],
      wholeFile: true,
    });
    expect(text(html)).toContain("was ignored");
    expect(text(html)).toContain("None of it was applied");
    expect(text(html)).not.toContain("the rest of the file was applied");
  });

  it("renders repeated identical messages without collapsing them", () => {
    // Two bad entries in one array produce the same string twice; a key collision
    // would drop one and undercount what was refused.
    const dup = "services[0]: requires a `name`";
    const html = render({ errors: [dup, dup], warnings: [] });
    expect(text(html).match(/requires a `name`/g)).toHaveLength(2);
  });
});
