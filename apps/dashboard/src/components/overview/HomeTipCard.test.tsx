// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HomeTipCard from "./HomeTipCard";

vi.mock("@repo/ui/icons", () => ({ Icon: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/context/GitHubContext", () => ({
  useGitHub: () => ({ connected: true, loading: false }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true }),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({
    t: {
      overview: {
        homeTip: {
          quickTip: "Quick Tip",
          connectText: "Connect GitHub",
          connectLabel: "Connect",
          createText: "Create your first project",
          createLabel: "New Project",
          tips: {},
        },
      },
    },
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("HomeTipCard (#947)", () => {
  it("links an empty connected workspace to the project library", async () => {
    await act(async () => root.render(<HomeTipCard projectCount={0} loading={false} />));

    expect(container.querySelector("a")?.getAttribute("href")).toBe("/library");
  });
});
