// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DropdownMenu from "./DropdownMenu";

/**
 * Project grid cards each carry a `z-20` menu wrapper in one stacking context,
 * so the next card's trigger painted over an open menu. The open wrapper must
 * outrank its closed siblings.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DropdownMenu stacking", () => {
  it("raises the open menu's wrapper above siblings with the same z-index", () => {
    act(() => {
      root.render(
        <>
          <DropdownMenu className="z-20" triggerLabel="first" actions={[{ id: "a", label: "A" }]} />
          <DropdownMenu
            className="z-20"
            triggerLabel="second"
            actions={[{ id: "b", label: "B" }]}
          />
        </>,
      );
    });
    const [first, second] = Array.from(container.querySelectorAll("button"));
    const wrapper = (el: Element) => el.parentElement!.className.split(/\s+/);

    expect(wrapper(first)).toContain("z-20");

    act(() => first.click());

    expect(wrapper(first)).toContain("z-50");
    expect(wrapper(first)).not.toContain("z-20");
    expect(wrapper(second)).toContain("z-20");
  });
});
