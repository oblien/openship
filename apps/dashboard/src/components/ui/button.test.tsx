// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button";

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
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function button() {
  const element = container.querySelector("button");
  expect(element).toBeInstanceOf(HTMLButtonElement);
  return element!;
}

describe("Button", () => {
  it("renders as a real button element with its children", async () => {
    await render(<Button>Deploy</Button>);
    expect(button().textContent).toBe("Deploy");
  });

  it("calls onClick when activated", async () => {
    const onClick = vi.fn();
    await render(<Button onClick={onClick}>Deploy</Button>);
    await act(async () => button().click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick while disabled", async () => {
    const onClick = vi.fn();
    await render(
      <Button disabled onClick={onClick}>
        Deploy
      </Button>,
    );
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the child element instead of a button when asChild is set", async () => {
    await render(
      <Button asChild>
        <a href="/projects">Projects</a>
      </Button>,
    );
    const link = container.querySelector("a");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.textContent).toBe("Projects");
    expect(link?.getAttribute("href")).toBe("/projects");
    expect(container.querySelector("button")).toBeNull();
  });

  it("still applies its styling to the slotted child", async () => {
    await render(
      <Button asChild>
        <a href="/projects">Projects</a>
      </Button>,
    );
    expect(container.querySelector("a")?.className.trim()).toBeTruthy();
  });

  it("forwards a ref to the underlying element", async () => {
    const ref = createRef<HTMLButtonElement>();
    await render(<Button ref={ref}>Deploy</Button>);
    expect(ref.current).toBe(button());
  });

  it("passes arbitrary button attributes through", async () => {
    await render(
      <Button type="submit" aria-label="Deploy project" data-testid="deploy">
        Deploy
      </Button>,
    );
    expect(button().type).toBe("submit");
    expect(button().getAttribute("aria-label")).toBe("Deploy project");
    expect(button().getAttribute("data-testid")).toBe("deploy");
  });

  it("keeps a caller-supplied className alongside the variant classes", async () => {
    await render(<Button className="custom-class">Deploy</Button>);
    expect(button().classList.contains("custom-class")).toBe(true);
    expect(button().classList.length).toBeGreaterThan(1);
  });

  it("produces different classes for different variants", async () => {
    await render(<Button variant="destructive">Delete</Button>);
    const destructive = button().className;
    await render(<Button variant="ghost">Delete</Button>);
    expect(button().className).not.toBe(destructive);
  });

  it("applies the default variant and size when none are given", async () => {
    await render(<Button>Deploy</Button>);
    const implicit = button().className;
    await render(
      <Button variant="default" size="default">
        Deploy
      </Button>,
    );
    expect(button().className).toBe(implicit);
  });
});
