// @vitest-environment happy-dom
/**
 * Deployment filters must survive a Back navigation.
 *
 * Reported repro: open /deployments, filter by one project, click a deployment, hit
 * Back — the list came back showing ALL projects. The filters were component state
 * only, and Back remounts this component, so every one of them reset to its default
 * and a deliberately narrowed list silently became the full one.
 *
 * The fix mirrors them into the query string, so this asserts both halves: changing
 * a filter writes the URL, and mounting with that URL restores the filter (which is
 * what a Back navigation actually does — it remounts at the previous URL).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/components/i18n-provider";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every URL the component asked the router to put in the address bar. */
let replaced: string[] = [];
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (url: string) => replaced.push(url),
    push: (url: string) => replaced.push(url),
    back: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/deployments",
  useSearchParams: () => searchParams,
}));

// The row's overflow menu is stubbed for ONE reason: it imports `@/utils/icons`,
// which is JSX inside a .js file that the test transform cannot parse, so pulling it
// in takes down any test that renders a deployment card (the monitoring suite
// documents the same constraint). Nothing here asserts on the menu; the card itself
// stays real, because the card is what proves a filter was applied.
vi.mock("./DeploymentMenu", () => ({ DeploymentMenu: () => null }));

const DEPLOYMENTS = [
  {
    id: "d1",
    projectId: "p1",
    projectName: "alpha",
    status: "success",
    createdAt: "2026-08-11T10:00:00Z",
  },
  {
    id: "d2",
    projectId: "p2",
    projectName: "beta",
    status: "failed",
    createdAt: "2026-08-11T11:00:00Z",
  },
];

function stubFetch() {
  return vi.fn(async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request)?.url ?? input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("deployments")) return json({ data: DEPLOYMENTS });
    return json({ data: [] });
  });
}

let container: HTMLDivElement;
let root: Root | undefined;
const errors: unknown[] = [];

beforeEach(() => {
  errors.length = 0;
  replaced = [];
  searchParams = new URLSearchParams();
  vi.stubGlobal("fetch", stubFetch());
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mountDeployments() {
  const { DeploymentsContent } = await import("./DeploymentsContent");
  await act(async () => {
    root = createRoot(container, {
      onUncaughtError: (e) => errors.push(e),
      onCaughtError: (e) => errors.push(e),
    });
    root.render(
      <I18nProvider>
        <DeploymentsContent />
      </I18nProvider>,
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Click the status-filter chip with this exact label. */
async function clickChip(label: RegExp) {
  const chip = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test((b.textContent ?? "").trim()),
  );
  expect(chip, `a filter chip matching ${label} should render`).toBeTruthy();
  await act(async () => {
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("deployments filters ↔ URL", () => {
  it("starts clean: no filter params for an unfiltered list", async () => {
    await mountDeployments();
    expect(errors).toEqual([]);
    // A default view must not rewrite the URL at all — otherwise every visit
    // pushes ?status=all and the 'is anything filtered' check drifts.
    expect(replaced).toEqual([]);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("beta");
  });

  it("writes the status filter to the URL when it changes", async () => {
    await mountDeployments();
    await clickChip(/^failed$/i);

    expect(errors).toEqual([]);
    expect(replaced.at(-1)).toBe("/deployments?status=failed");
  });

  /** The actual regression: this is the state a Back navigation remounts into. */
  it("restores the project filter from the URL on mount", async () => {
    searchParams = new URLSearchParams({ project: "p2" });
    await mountDeployments();

    expect(errors).toEqual([]);
    // Only the filtered project's deployment survives...
    expect(container.textContent).toContain("beta");
    expect(container.textContent).not.toContain("alpha");
    // ...and restoring must not itself rewrite the URL.
    expect(replaced).toEqual([]);
  });

  it("restores the status filter from the URL on mount", async () => {
    searchParams = new URLSearchParams({ status: "failed" });
    await mountDeployments();

    expect(errors).toEqual([]);
    expect(container.textContent).toContain("beta");
    expect(container.textContent).not.toContain("alpha");
    expect(replaced).toEqual([]);
  });

  it("ignores a status the filter doesn't have instead of emptying the list", async () => {
    searchParams = new URLSearchParams({ status: "not-a-status" });
    await mountDeployments();

    expect(errors).toEqual([]);
    // Falls back to "all" — a hand-edited or stale URL must not wedge the view on a
    // value nothing will ever match.
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("beta");
  });

  it("drops a filter param when it goes back to its default", async () => {
    searchParams = new URLSearchParams({ status: "failed" });
    await mountDeployments();
    await clickChip(/^all$/i);

    expect(errors).toEqual([]);
    // Back to the default → the param is removed, not left as ?status=all.
    expect(replaced.at(-1)).toBe("/deployments");
  });

  it("keeps unrelated query params intact", async () => {
    searchParams = new URLSearchParams({ ref: "email" });
    await mountDeployments();
    await clickChip(/^failed$/i);

    expect(errors).toEqual([]);
    expect(replaced.at(-1)).toBe("/deployments?ref=email&status=failed");
  });
});
