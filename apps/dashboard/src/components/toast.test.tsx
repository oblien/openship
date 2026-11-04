import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "./toast";

describe("Toast copy button", () => {
  it("renders a copy button for error toasts", () => {
    const html = renderToStaticMarkup(
      <ToastProvider
        initialToasts={[
          {
            id: "t1",
            type: "error",
            title: "Deploy Error",
            message: "Deployment failed unexpectedly",
          },
        ]}
      >
        <div>content</div>
      </ToastProvider>,
    );
    expect(html).toContain("Deploy Error");
    expect(html).toContain("Deployment failed unexpectedly");
    expect(html).toContain('title="Copy error message"');
    expect(html).toContain('aria-label="Copy error message"');
  });

  it("does not render a copy button for success or info toasts", () => {
    const html = renderToStaticMarkup(
      <ToastProvider
        initialToasts={[
          {
            id: "t2",
            type: "success",
            message: "Settings saved successfully",
          },
          {
            id: "t3",
            type: "info",
            message: "Update in progress",
          },
        ]}
      >
        <div>content</div>
      </ToastProvider>,
    );
    expect(html).toContain("Settings saved successfully");
    expect(html).toContain("Update in progress");
    expect(html).not.toContain("Copy error message");
  });
});
