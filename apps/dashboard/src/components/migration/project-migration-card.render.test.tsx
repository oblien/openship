// No DOM: renderToStaticMarkup runs no effects, so this covers the FIRST paint — the
// state an operator sees before the server list arrives, and the copy that must be on the
// card rather than buried in the confirm modal.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
// The REAL provider, not a mocked `useModal`: the card now raises its confirm through the
// app's shared modal hook, and a stub would stop these tests proving that it is wired to it.
import ModalProvider from "@/context/ModalContext";
import { ProjectMigrationCard } from "./ProjectMigrationCard";

// The shared `ServerSelector` is rendered for real (mocking it away would stop this file
// proving the card USES it) — so its two host dependencies are stubbed instead: the server
// list, and the add-server modal, whose `useModal` needs a provider this static render has
// no reason to stand up.
vi.mock("@/lib/api/system", () => ({ systemApi: { listServers: () => new Promise(() => {}) } }));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => () => {} }));
vi.mock("@/lib/api/services", () => ({ servicesApi: { list: () => new Promise(() => {}) } }));
// Deliberately EMPTY: the card must reach first paint, and open its confirm, without
// calling anything on this module. A stub with methods would hide a reintroduced
// plan-before-confirm fetch; an empty object makes it throw.
vi.mock("@/lib/api/server-migration", () => ({ dockerMigrationApi: {} }));

function render() {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModalProvider>
        <ProjectMigrationCard
          projectId="p1"
          projectName="clincai"
          sourceServerId="srv_a"
          sourceServerName="Server 1"
          onStarted={() => {}}
        />
      </ModalProvider>
    </I18nProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("ProjectMigrationCard first paint", () => {
  it("names the server the project is moving FROM", () => {
    // "From" is half the decision, and the card is the only place the move is made — the
    // operator should not have to remember which box this project is on.
    expect(text(render())).toContain("Server 1");
  });

  it("says Cloud is out of scope instead of silently offering only servers", () => {
    // Otherwise a missing Cloud option reads as a bug rather than a boundary.
    expect(text(render())).toContain("Openship Cloud");
  });

  it("renders no confirm dialog until a plan has been fetched", () => {
    // The modal is the consent step; nothing destructive may be one click away, and a
    // preview is a server round trip that has not happened at first paint.
    const out = text(render());
    expect(out).not.toContain("Start move");
    expect(out).not.toContain("To transfer");
  });

  it("uses the shared ServerSelector, not a hand-rolled picker", () => {
    // Its loading copy is the tell — `listServers` never resolves here, so the shared
    // component's own pending state is what renders. A private select would show none of
    // this, and would also lose the masked host line and the inline add-server row.
    expect(text(render())).toContain("Loading servers");
  });

  it("disables Migrate before a target is chosen", () => {
    // The button is reachable by keyboard from first paint, and posting with no target
    // would 400.
    expect(render()).toContain("disabled");
  });
});

/**
 * The COPY branch, rendered.
 *
 * This block exists because of a bug the other tests could not have caught: they only ever
 * render the default (`move`), so the service-scope JSX — which is the only place `scoped`,
 * `services` and `toggleService` are read — was never executed by a test at all. Pressing
 * Duplicate in the browser was the first thing to run it.
 *
 * `intent` is internal state with no prop, so it is driven the way a user does: find the
 * Duplicate pill's onClick in the rendered tree and call it, then re-render.
 */
describe("ProjectMigrationCard duplicate branch renders", () => {
  it("renders the service scope without throwing", () => {
    // renderToStaticMarkup cannot click, so assert the copy path compiles and evaluates by
    // rendering the component's own copy-mode subtree through a forced initial state.
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModalProvider>
          <ProjectMigrationCard
            projectId="p1"
            projectName="clincai"
            sourceServerId="srv_a"
            sourceServerName="Server 1"
            onStarted={() => {}}
            initialIntent="copy"
          />
        </ModalProvider>
      </I18nProvider>,
    );
    const out = text(html);
    expect(out).toContain("What to duplicate");
    // The duplicate hint replaces the move hint, and the action verb changes with it.
    expect(out).toContain("A second project is created");
    expect(out).toContain("Duplicate");
    expect(out).not.toContain("removed from the old server");
  });
});

describe("ProjectMigrationCard move vs duplicate", () => {
  it("offers both intents", () => {
    const out = text(render());
    expect(out).toContain("Move");
    expect(out).toContain("Duplicate");
  });

  it("defaults to Move, and says the old server is emptied", () => {
    // The default must be the one the card is titled for. And the hint has to state what
    // survives: "Move" alone does not tell an operator their old server gets cleared.
    const out = text(render());
    expect(out).toContain("removed from the old server");
    // The duplicate hint belongs to the other choice, so it must not be showing yet.
    expect(out).not.toContain("A second project is created");
  });

  it("labels the action button for the default intent", () => {
    expect(text(render())).toContain("Migrate");
  });

  it("hides the service scope while the intent is Move", () => {
    // A project is bound to ONE server, so a subset can't move — the server refuses a
    // scoped move, and not offering it is the same rule stated before the operator trips
    // over it.
    expect(text(render())).not.toContain("What to duplicate");
  });

  it("labels the from/to fields so the direction is unambiguous", () => {
    const out = text(render());
    expect(out).toContain("From");
    expect(out).toContain("To");
  });

  it("does not plan before the operator has agreed", () => {
    // The regression this guards: the action used to fetch a plan first, which meant an SSH
    // scan of the source — seconds on a good day, a dead "Checking…" button and a toast on an
    // unreachable host. The scan belongs to the run's `adopting` phase, where it is visible
    // in the session and the run can be retried.
    //
    // `dockerMigrationApi` is mocked as `{}`, so any call from the render path would throw.
    expect(() => render()).not.toThrow();
    // And the action is a plain opener — no loading label can appear before a confirm.
    expect(text(render())).not.toContain("Checking");
  });
});

/**
 * The confirm dialog goes through `showModal` — the shared hook every other destructive
 * confirm uses (remove server, disconnect GitHub, delete a draft project). Its config is
 * built in a click handler, so no static render reaches it; asserted in source.
 */
describe("the confirm dialog", () => {
  const src = readFileSync(new URL("./ProjectMigrationCard.tsx", import.meta.url), "utf8");
  const confirm = src.slice(src.indexOf("const confirm ="), src.indexOf("return ("));

  it("constrains its own width", () => {
    // The renderer's default is 80vw, sized for the WIDE content modals (a service table, a
    // log tail). A confirm that inherits it stretches to ~2300px on a desktop, and its two
    // buttons stretch with it. Every other confirm in the app passes a width for this reason.
    expect(confirm).toContain("maxWidth:");
  });

  it("carries the weight of the action in the button VARIANT", () => {
    // A move removes containers from the old server; a duplicate touches nothing that exists.
    // Two different acts must not look identical, which is what the hand-rolled dialog got
    // wrong by giving both the same primary button.
    expect(confirm).toContain('variant: intent === "move" ? "danger" : "primary"');
  });

  it("uses the shared hook rather than a hand-rolled dialog", () => {
    expect(confirm).toContain("showModal({");
    // No second Modal implementation in this card — the shared renderer owns the padding,
    // the title and the close behaviour.
    expect(src).not.toContain("<Modal");
  });
});
