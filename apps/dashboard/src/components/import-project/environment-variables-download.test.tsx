// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { parseDotenv } from "@/lib/dotenv";
import EnvironmentVariables from "./EnvironmentVariables";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: toast }) }));

type Props = ComponentProps<typeof EnvironmentVariables>;
let host: HTMLDivElement;
let root: Root;
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn();
let download: { filename: string; href: string } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  createObjectURL.mockReturnValue("blob:env-download");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  download = undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    download = { filename: this.download, href: this.href };
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await vi.runOnlyPendingTimersAsync();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(props: Partial<Props>) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <EnvironmentVariables
          mode="settings"
          hideTitle
          isEditingMode
          showSettingsActions={false}
          {...props}
        />
      </I18nProvider>,
    ),
  );
}

function downloadButton() {
  return [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Download .env"),
  )!;
}

describe("environment download", () => {
  it("exports current edits and real saved secrets without exposing or changing the form", async () => {
    const envVars = [
      { key: "PORT", value: "4000", visible: true },
      { key: "TOKEN", value: ENV_MASK, visible: false },
      { key: "EDITED_SECRET", value: "typed-secret", visible: false, isSecret: true },
      { key: "RENAMED", originalKey: "SAVED", value: "", visible: false, preserveValue: true },
      { key: "", value: "", visible: true },
    ];
    const onEnvVarsChange = vi.fn();
    const onReveal = vi
      .fn()
      .mockResolvedValue({ TOKEN: "saved-token", SAVED: "saved-value", EXTRA: "ignore" });
    await render({ envVars, onEnvVarsChange, onReveal, isEditingMode: false });
    expect(downloadButton().previousElementSibling?.textContent).toBe("Upload .env");
    await act(async () => downloadButton().click());

    expect(onReveal).toHaveBeenCalledExactlyOnceWith(["TOKEN", "SAVED"]);
    expect(download).toEqual({ filename: ".env", href: "blob:env-download" });
    const content = await createObjectURL.mock.calls[0]![0].text();
    expect(parseDotenv(content)).toEqual([
      { key: "PORT", value: "4000" },
      { key: "TOKEN", value: "saved-token" },
      { key: "EDITED_SECRET", value: "typed-secret" },
      { key: "RENAMED", value: "saved-value" },
    ]);
    expect(onEnvVarsChange).not.toHaveBeenCalled();
    expect(envVars[1]!.value).toBe(ENV_MASK);
    expect(host.innerHTML).not.toContain("saved-token");
    expect(host.querySelector("a[download]")).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:env-download");
  });

  it("downloads a file that Upload .env can import without losing complex values", async () => {
    const envVars = [
      { key: "MESSAGE", value: `  'quoted' and "double" # text  `, visible: true },
      { key: "PRIVATE_KEY", value: "first\r\nNEXT=part of the key\nlast", visible: false },
      { key: "PASSWORD", value: "user's${PASSWORD} $$ literal", visible: false },
      { key: "PATH_VALUE", value: "  C:\\new\\folder\\", visible: true },
      { key: "EMPTY", value: "", visible: true },
    ];
    await render({ envVars });
    await act(async () => downloadButton().click());
    const content = await createObjectURL.mock.calls[0]![0].text();
    const onEnvVarsChange = vi.fn();
    await render({ envVars: [], onEnvVarsChange });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File([content], ".env")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(onEnvVarsChange).toHaveBeenCalledOnce());
    });
    expect(onEnvVarsChange.mock.calls[0]![0]).toEqual(
      envVars.map((row) => ({ ...row, visible: true })),
    );
  });

  it.each(["missing", "masked", "denied", "unavailable"])(
    "does not download an incomplete file when a saved value is %s",
    async (scenario) => {
      const onReveal =
        scenario === "unavailable"
          ? undefined
          : vi.fn(async (): Promise<Record<string, string>> => {
              if (scenario === "denied") throw new Error("Forbidden");
              return scenario === "masked" ? { TOKEN: ENV_MASK } : {};
            });
      await render({ envVars: [{ key: "TOKEN", value: ENV_MASK, visible: false }], onReveal });
      await act(async () => downloadButton().click());
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        "Couldn’t download environment variables.",
        "error",
        "Environment Variables",
      );
    },
  );

  it("disables empty downloads and prevents duplicate requests while secrets are loading", async () => {
    await render({ envVars: [{ key: " ", value: "", visible: true }] });
    expect(downloadButton().disabled).toBe(true);
    let resolve!: (values: Record<string, string>) => void;
    const onReveal = vi.fn(
      () =>
        new Promise<Record<string, string>>((done) => {
          resolve = done;
        }),
    );
    await render({ envVars: [{ key: "TOKEN", value: ENV_MASK, visible: false }], onReveal });
    await act(async () => {
      downloadButton().click();
      downloadButton().click();
    });
    expect(onReveal).toHaveBeenCalledOnce();
    expect(downloadButton().disabled).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    await act(async () => resolve({ TOKEN: "saved-token" }));
    expect(downloadButton().disabled).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "invalid key", envVars: [{ key: "BAD\nINJECTED", value: "secret", visible: false }] },
    { name: "duplicate keys", envVars: [{ key: "SAME", value: "first", visible: true }, { key: " SAME ", value: "second", visible: true }] },
    { name: "null byte", envVars: [{ key: "TOKEN", value: "before\0after", visible: false }] },
  ])("does not offer a partial download for $name", async ({ envVars }) => {
    await render({ envVars });
    await act(async () => downloadButton().click());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(download).toBeUndefined();
    expect(downloadButton().disabled).toBe(false);
    expect(toast).toHaveBeenCalledWith("Couldn’t download environment variables.", "error", "Environment Variables");
  });

  it("keeps one consistent snapshot if the editor changes while a reveal is pending", async () => {
    let resolve!: (values: Record<string, string>) => void;
    const onReveal = vi.fn(() => new Promise<Record<string, string>>((done) => { resolve = done; }));
    const onEnvVarsChange = vi.fn();
    await render({ envVars: [
      { key: "VERSION", value: "first", visible: true },
      { key: "TOKEN", value: ENV_MASK, visible: false },
    ], onReveal, onEnvVarsChange });
    await act(async () => downloadButton().click());
    await render({ envVars: [
      { key: "VERSION", value: "second", visible: true },
      { key: "DIFFERENT_TOKEN", value: ENV_MASK, visible: false },
    ], onReveal, onEnvVarsChange });
    const secret = "user's$TOKEN \\n \"private\"";
    await act(async () => resolve({ TOKEN: secret }));
    expect(onReveal).toHaveBeenCalledExactlyOnceWith(["TOKEN"]);
    expect(parseDotenv(await createObjectURL.mock.calls[0]![0].text())).toEqual([
      { key: "VERSION", value: "first" }, { key: "TOKEN", value: secret },
    ]);
    expect(onEnvVarsChange).not.toHaveBeenCalled();
    expect(host.innerHTML).not.toContain(secret);
  });

  it("cleans up the download URL and allows retry if the browser refuses the download", async () => {
    await render({ envVars: [{ key: "PORT", value: "3000", visible: true }] });
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw new Error("Download refused"); });
    await act(async () => downloadButton().click());
    expect(host.querySelector("a[download]")).toBeNull();
    expect(downloadButton().disabled).toBe(false);
    expect(download).toBeUndefined();
    await vi.runOnlyPendingTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    await act(async () => downloadButton().click());
    expect(download).toEqual({ filename: ".env", href: "blob:env-download" });
  });

  it("does not download while environment changes are being saved", async () => {
    await render({ envVars: [{ key: "TOKEN", value: ENV_MASK, visible: false }], isSaving: true });
    expect(downloadButton().disabled).toBe(true);
    await act(async () => downloadButton().click());
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
