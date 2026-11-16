// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposeReview } from "./useComposeReview";
import { setApiResourceScope } from "@/lib/api/client";
const mocks = vi.hoisted(() => ({
  show: vi.fn(
    (_config: {
      customContent: React.ReactElement<{ onApply: (revision: string) => Promise<unknown> }>;
    }) => "review",
  ),
  hide: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: mocks.show, hideModal: mocks.hide }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
const cause = {
  body: {
    code: "COMPOSE_REVIEW_REQUIRED",
    projectId: "project",
    composeRevision: "a".repeat(64),
    composeChanges: { changed: ["worker"], added: [], removed: [] },
  },
};
let open: ReturnType<typeof useComposeReview>;
function Harness({ projectId = "project" }: { projectId?: string }) {
  open = useComposeReview(projectId);
  return null;
}
let root: Root, el: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  setApiResourceScope("account-1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  root = createRoot(el);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
it("blocks a confirmation after the account changes", async () => {
  const apply = vi.fn();
  open(cause, apply);
  const dialog = mocks.show.mock.calls[0]![0] as any;
  setApiResourceScope("account-2");
  await dialog.customContent.props.onApply("a".repeat(64));
  expect(apply).not.toHaveBeenCalled();
  expect(mocks.hide).toHaveBeenCalledWith("review");
});
it("closes old review on project navigation and refuses cross-project error data", async () => {
  const apply = vi.fn();
  open(cause, apply);
  const dialog = (mocks.show.mock.calls[0]![0] as any).customContent;
  await act(async () => root.render(<Harness projectId="other" />));
  await dialog.props.onApply("a".repeat(64));
  expect(apply).not.toHaveBeenCalled();
  expect(open(cause, apply)).toBe(false);
});
