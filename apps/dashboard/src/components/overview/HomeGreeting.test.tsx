// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import HomeGreeting from "./HomeGreeting";

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HomeGreeting", () => {
  it("hydrates from the server hour without an error, then uses the browser's local hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 20));
    const view = (
      <I18nProvider>
        <HomeGreeting displayName="Steve" initialHour={9} />
      </I18nProvider>
    );

    host.innerHTML = renderToString(view);
    expect(host.textContent).toBe("Good morning, Steve");

    const recoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(host, view, { onRecoverableError: recoverableError });
    });

    expect(recoverableError).not.toHaveBeenCalled();
    expect(host.textContent).toBe("Good evening, Steve");
  });
});
