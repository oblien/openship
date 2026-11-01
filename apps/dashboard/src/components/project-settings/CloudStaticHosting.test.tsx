// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { CloudStaticHosting } from "./CloudStaticHosting";
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));

it("lets the operator opt into server hosting and return to Pages, disabling changes during save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes = vi.fn();
  function Form({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState<"pages" | "server">("pages");
    return (
      <CloudStaticHosting
        value={value}
        disabled={disabled}
        onChange={(next) => {
          changes(next);
          setValue(next);
        }}
      />
    );
  }
  try {
    await act(async () => root.render(<Form />));
    const page = host.querySelector<HTMLButtonElement>('button[value="pages"]')!;
    const server = host.querySelector<HTMLButtonElement>('button[value="server"]')!;
    expect(page.getAttribute("aria-pressed")).toBe("true");
    await act(async () => server.click());
    expect(changes).toHaveBeenLastCalledWith("server");
    expect(server.getAttribute("aria-pressed")).toBe("true");
    await act(async () => page.click());
    expect(changes).toHaveBeenLastCalledWith("pages");
    await act(async () => root.render(<Form disabled />));
    expect(server.disabled).toBe(true);
    const count = changes.mock.calls.length;
    await act(async () => server.click());
    expect(changes).toHaveBeenCalledTimes(count);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
