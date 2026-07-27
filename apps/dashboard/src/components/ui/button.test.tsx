import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "./button";

/**
 * First component test in the dashboard, so it doubles as the reference
 * pattern for the ones that follow.
 *
 * Two conventions worth copying:
 *
 * 1. Query by accessible role, not by test id or class. `getByRole("button")`
 *    fails if the element stops being a real button, which is exactly the
 *    regression worth catching.
 * 2. Never assert an exact Tailwind class string. Those change on any cosmetic
 *    tweak and protect nothing. Assert behavior instead, and where a class
 *    genuinely matters (variants, className merging), assert the property that
 *    matters rather than the full string.
 */
describe("Button", () => {
  it("renders as a real button element with its children", () => {
    render(<Button>Deploy</Button>);

    const button = screen.getByRole("button", { name: "Deploy" });
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe("BUTTON");
  });

  it("calls onClick when activated", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Deploy</Button>);

    await user.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Deploy
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the child element instead of a button when asChild is set", () => {
    // asChild swaps the rendered element via Radix's Slot. Getting this wrong
    // produces a <button> nested inside an <a>, which is invalid HTML and
    // breaks keyboard and screen-reader navigation.
    render(
      <Button asChild>
        <a href="/projects">Projects</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Projects" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/projects");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still applies its styling to the slotted child", () => {
    // The point of asChild is to keep the button styling while changing the
    // element, so a slotted child that renders unstyled is a silent regression.
    render(
      <Button asChild>
        <a href="/projects">Projects</a>
      </Button>,
    );

    expect(screen.getByRole("link").className.trim()).not.toBe("");
  });

  it("forwards a ref to the underlying element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Deploy</Button>);

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toBe(screen.getByRole("button"));
  });

  it("passes arbitrary button attributes through", () => {
    render(
      <Button type="submit" aria-label="Deploy project" data-testid="deploy">
        Deploy
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Deploy project" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("data-testid", "deploy");
  });

  it("keeps a caller-supplied className alongside the variant classes", () => {
    render(<Button className="custom-class">Deploy</Button>);

    const button = screen.getByRole("button");
    expect(button).toHaveClass("custom-class");
    // The merge must not drop everything else in favour of the custom class.
    expect(button.className.split(/\s+/).length).toBeGreaterThan(1);
  });

  it("produces different classes for different variants and sizes", () => {
    // Deliberately compares variants against each other rather than asserting
    // literal Tailwind strings, so restyling does not break the test but
    // collapsing two variants into the same output does.
    const { unmount } = render(<Button variant="destructive">Delete</Button>);
    const destructive = screen.getByRole("button").className;
    unmount();

    render(<Button variant="ghost">Delete</Button>);
    const ghost = screen.getByRole("button").className;

    expect(destructive).not.toBe(ghost);
  });

  it("applies the default variant and size when none are given", () => {
    const { unmount } = render(<Button>Deploy</Button>);
    const implicit = screen.getByRole("button").className;
    unmount();

    render(
      <Button variant="default" size="default">
        Deploy
      </Button>,
    );

    expect(screen.getByRole("button").className).toBe(implicit);
  });
});
