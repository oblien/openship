// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ComposeReviewDialog } from "./ComposeReviewDialog";

vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
const copy = baseDictionary.projects.redeploy.composeReview;
const revision = "a".repeat(64);
const review = {
  projectId: "project",
  composeRevision: revision,
  composeChanges: { added: [], changed: ["worker"], removed: [] },
  composeDiff: [
    {
      name: "worker",
      kind: "changed" as const,
      fields: [{ path: "image", before: "worker:1", after: "worker:2" }],
    },
  ],
};
let root: Root, el: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  return [...el.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

it("renders the actual before/after values and keeps Configure optional", async () => {
  const apply = vi.fn(),
    close = vi.fn(),
    configure = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={apply}
        onClose={close}
        onConfigure={configure}
      />,
    ),
  );
  expect(el.textContent).toContain("worker:1");
  expect(el.textContent).toContain("worker:2");
  await act(async () => button(copy.configure).click());
  expect(configure).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("allows only one in-flight deployment and passes the reviewed revision", async () => {
  let resolve!: () => void;
  const apply = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    ),
    close = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={apply}
        onClose={close}
        onConfigure={() => {}}
      />,
    ),
  );
  await act(async () => {
    button(copy.apply).click();
    button(copy.apply).click();
  });
  expect(apply).toHaveBeenCalledExactlyOnceWith(revision);
  expect(button(copy.applying).disabled).toBe(true);
  expect(button(copy.cancel).disabled).toBe(true);
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
});

it("requires a second explicit acceptance if the source changed while reviewing", async () => {
  const next = {
    ...review,
    composeRevision: "b".repeat(64),
    composeDiff: [
      {
        ...review.composeDiff[0]!,
        fields: [{ path: "image", before: "worker:1", after: "worker:3" }],
      },
    ],
  };
  const apply = vi
    .fn()
    .mockRejectedValueOnce({ body: { code: "COMPOSE_REVIEW_REQUIRED", ...next } })
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={apply}
        onClose={close}
        onConfigure={() => {}}
      />,
    ),
  );
  await act(async () => button(copy.apply).click());
  expect(el.textContent).toContain(copy.changedAgain);
  expect(el.textContent).toContain("worker:3");
  expect(close).not.toHaveBeenCalled();
  expect(apply).toHaveBeenCalledOnce();
  await act(async () => button(copy.apply).click());
  expect(apply).toHaveBeenLastCalledWith(next.composeRevision);
});

it("keeps the diff and Configure available when deployment preflight refuses", async () => {
  const apply = vi.fn().mockRejectedValue(new Error("Missing required variable: DATABASE_URL")),
    close = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={apply}
        onClose={close}
        onConfigure={() => {}}
      />,
    ),
  );
  await act(async () => button(copy.apply).click());
  expect(el.querySelector('[role="alert"]')?.textContent).toContain("DATABASE_URL");
  expect(button(copy.configure).disabled).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

it("does not offer blind acceptance for an older API without an exact revision", async () => {
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={{ composeChanges: review.composeChanges }}
        onApply={vi.fn()}
        onClose={() => {}}
        onConfigure={() => {}}
      />,
    ),
  );
  expect(button(copy.apply)).toBeUndefined();
  expect(button(copy.configure)).toBeDefined();
});

it.each([false, null])("keeps a refused deployment visible (%s)", async (result) => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={async () => result}
        onClose={close}
        onConfigure={() => {}}
      />,
    ),
  );
  await act(async () => button(copy.apply).click());
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.applyFailed);
  expect(close).not.toHaveBeenCalled();
});

it("keeps keyboard focus inside the review and allows cancelling with Escape", async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <ComposeReviewDialog
        review={review}
        onApply={vi.fn()}
        onClose={close}
        onConfigure={() => {}}
      />,
    ),
  );
  expect(document.activeElement).toBe(el.querySelector('[role="dialog"]'));
  button(copy.apply).focus();
  await act(async () =>
    button(copy.apply).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement).toBe(el.querySelector("button"));
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
