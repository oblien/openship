import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyFrameNavigation,
  classifySelfHostNavigation,
  isAllowedFrameUrl,
  isAllowedUpdateAssetUrl,
  isRendererConfigKey,
  isSafeExternalUrl,
  buildDesktopCloudAuthorizeUrl,
  parseSelfHostedDashboardUrl,
  resolveDesktopCloudTarget,
} from "../src/main/security";

/**
 * Containment tests for the Electron shell (GHSA-753c-445r-289h).
 *
 * The property under test: a script-execution primitive in the loaded dashboard
 * must not be able to reach an off-origin page (which would inherit the preload
 * bridge, since `window.desktop` is not origin-scoped), hand a scheme to the OS
 * dispatcher, or read local SSH credentials off the config bridge.
 */

const LOCAL = ["http://localhost:3001", "http://localhost:4000"];

describe("isAllowedFrameUrl", () => {
  it("allows the local dashboard and API origins", () => {
    expect(isAllowedFrameUrl("http://localhost:3001/", LOCAL)).toBe(true);
    expect(isAllowedFrameUrl("http://localhost:3001/servers?x=1#y", LOCAL)).toBe(true);
    expect(isAllowedFrameUrl("http://localhost:4000/api/auth/desktop-login", LOCAL)).toBe(true);
  });

  it("blocks off-origin navigation (the escalation path)", () => {
    expect(isAllowedFrameUrl("https://attacker.tld/", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("https://localhost:3001/", LOCAL)).toBe(false); // scheme differs
    expect(isAllowedFrameUrl("http://localhost:9999/", LOCAL)).toBe(false); // port differs
    expect(isAllowedFrameUrl("http://evil.localhost/", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("http://localhost:3001.attacker.tld/", LOCAL)).toBe(false);
  });

  it("blocks data:/file:/javascript: rather than allowlisting the splash scheme", () => {
    // The boot splash is a data: URL, but it is loaded by main via loadURL, which
    // does not fire will-navigate. Allowlisting data: here would let the renderer
    // navigate to an attacker-authored document that inherits the bridge.
    expect(isAllowedFrameUrl("data:text/html,<script>1</script>", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("file:///etc/passwd", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("javascript:alert(1)", LOCAL)).toBe(false);
  });

  it("fails closed on unparseable input and an empty allowlist", () => {
    expect(isAllowedFrameUrl("not a url", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("", LOCAL)).toBe(false);
    expect(isAllowedFrameUrl("http://localhost:3001/", [])).toBe(false);
    expect(isAllowedFrameUrl("http://localhost:3001/", ["", "nonsense"])).toBe(false);
  });
});

describe("classifyFrameNavigation", () => {
  it("keeps our own origins in the frame", () => {
    expect(classifyFrameNavigation("http://localhost:3001/servers", LOCAL)).toBe("allow");
    expect(classifyFrameNavigation("http://localhost:4000/api/auth/desktop-login", LOCAL)).toBe(
      "allow",
    );
  });

  it("sends off-origin web content to the system browser instead of dropping it", () => {
    // Dashboard links to docs and github.com/settings/tokens/new carry no
    // target="_blank", so they arrive as main-frame navigations. They must still
    // reach the user — just not inside the frame that holds the native bridge.
    expect(classifyFrameNavigation("https://openship.io/docs", LOCAL)).toBe("external");
    expect(
      classifyFrameNavigation("https://github.com/settings/tokens/new?scopes=repo", LOCAL),
    ).toBe("external");
    expect(classifyFrameNavigation("https://attacker.tld/", LOCAL)).toBe("external");
  });

  it("blocks outright anything that isn't ordinary web content", () => {
    expect(classifyFrameNavigation("data:text/html,<script>1</script>", LOCAL)).toBe("block");
    expect(classifyFrameNavigation("file:///etc/passwd", LOCAL)).toBe("block");
    expect(classifyFrameNavigation("javascript:alert(1)", LOCAL)).toBe("block");
    expect(classifyFrameNavigation("httpevil://attacker.tld", LOCAL)).toBe("block");
    expect(classifyFrameNavigation("garbage", LOCAL)).toBe("block");
  });

  it("never returns 'allow' when the origin list is unusable", () => {
    expect(classifyFrameNavigation("http://localhost:3001/", [])).not.toBe("allow");
    expect(classifyFrameNavigation("http://localhost:3001/", ["", "nonsense"])).not.toBe("allow");
  });
});

describe("isSafeExternalUrl", () => {
  it("allows http and https", () => {
    expect(isSafeExternalUrl("https://github.com/oblien/openship")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3001/x")).toBe(true);
  });

  it("blocks schemes that reach a local handler", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("smb://attacker.tld/share")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("ms-msdt:/id")).toBe(false);
  });

  it("is not fooled by a scheme that merely starts with 'http'", () => {
    // Regression: the old check was `url.startsWith("http")`.
    expect(isSafeExternalUrl("httpevil://attacker.tld")).toBe(false);
  });

  it("treats a Windows UNC path as unsafe (SMB/NTLM-hash leak)", () => {
    expect(isSafeExternalUrl("\\\\attacker.tld\\share\\x")).toBe(false);
  });
});

describe("isRendererConfigKey", () => {
  it("allows the four update preferences the dashboard uses", () => {
    for (const key of [
      "autoUpdate",
      "updateNotifications",
      "dismissedAdvisoryIds",
      "lastSeenVersion",
    ]) {
      expect(isRendererConfigKey(key), key).toBe(true);
    }
  });

  it("refuses credential-bearing and origin keys", () => {
    for (const key of [
      "system",
      "tunnel",
      "apiUrl",
      "dashboardUrl",
      "onboardingComplete",
      "selfHostedDashboardUrl",
      "selfHostedActive",
    ]) {
      expect(isRendererConfigKey(key), key).toBe(false);
    }
  });

  it("refuses non-string and prototype-walking keys", () => {
    for (const key of [undefined, null, 0, {}, "__proto__", "constructor", "toString"]) {
      expect(isRendererConfigKey(key), String(key)).toBe(false);
    }
  });
});

describe("isAllowedUpdateAssetUrl", () => {
  it("allows GitHub release download hosts over https", () => {
    expect(
      isAllowedUpdateAssetUrl(
        "https://github.com/oblien/openship/releases/download/v0.6.1/Openship-arm64.dmg",
      ),
    ).toBe(true);
    expect(isAllowedUpdateAssetUrl("https://objects.githubusercontent.com/x")).toBe(true);
    expect(isAllowedUpdateAssetUrl("https://release-assets.githubusercontent.com/x")).toBe(true);
  });

  it("blocks other hosts, plaintext http, and host-suffix lookalikes", () => {
    expect(isAllowedUpdateAssetUrl("https://attacker.tld/Openship.dmg")).toBe(false);
    expect(isAllowedUpdateAssetUrl("http://github.com/x")).toBe(false);
    expect(isAllowedUpdateAssetUrl("https://github.com.attacker.tld/x")).toBe(false);
    expect(isAllowedUpdateAssetUrl("https://notgithub.com/x")).toBe(false);
    expect(isAllowedUpdateAssetUrl("file:///tmp/Openship.dmg")).toBe(false);
  });
});

describe("parseSelfHostedDashboardUrl", () => {
  it("accepts an https instance and keeps the path on that origin", () => {
    expect(parseSelfHostedDashboardUrl("https://ops.example.com")).toEqual({
      origin: "https://ops.example.com",
      href: "https://ops.example.com/",
    });
    expect(parseSelfHostedDashboardUrl("  ops.example.com/login  ")).toEqual({
      origin: "https://ops.example.com",
      href: "https://ops.example.com/login",
    });
  });

  it("allows http only for loopback", () => {
    expect(parseSelfHostedDashboardUrl("http://127.0.0.1:63794/projects")).toEqual({
      origin: "http://127.0.0.1:63794",
      href: "http://127.0.0.1:63794/projects",
    });
    expect(parseSelfHostedDashboardUrl("localhost:3001")).toEqual({
      origin: "http://localhost:3001",
      href: "http://localhost:3001/",
    });
    expect(parseSelfHostedDashboardUrl("http://[::1]:3001/")).toEqual({
      origin: "http://[::1]:3001",
      href: "http://[::1]:3001/",
    });
    expect(parseSelfHostedDashboardUrl("http://ops.example.com")).toBeNull();
    expect(parseSelfHostedDashboardUrl("http://8.8.8.8")).toBeNull();
  });

  it("rejects userinfo, non-web schemes, and empty input", () => {
    expect(parseSelfHostedDashboardUrl("https://user:pass@ops.example.com")).toBeNull();
    expect(parseSelfHostedDashboardUrl("javascript:alert(1)")).toBeNull();
    expect(parseSelfHostedDashboardUrl("file:///etc/passwd")).toBeNull();
    expect(parseSelfHostedDashboardUrl("")).toBeNull();
    expect(parseSelfHostedDashboardUrl("   ")).toBeNull();
  });
});

describe("classifySelfHostNavigation", () => {
  const origin = "https://ops.example.com";

  it("keeps the configured origin in the remote window", () => {
    expect(classifySelfHostNavigation("https://ops.example.com/login", origin)).toBe("allow");
    expect(classifySelfHostNavigation("https://ops.example.com/projects?x=1", origin)).toBe("allow");
  });

  it("sends other websites out and blocks non-web schemes", () => {
    expect(classifySelfHostNavigation("https://app.openship.io/login", origin)).toBe("external");
    expect(classifySelfHostNavigation("https://github.com/oblien/openship", origin)).toBe("external");
    expect(classifySelfHostNavigation("file:///etc/passwd", origin)).toBe("block");
    expect(classifySelfHostNavigation("javascript:alert(1)", origin)).toBe("block");
    expect(classifySelfHostNavigation("http://ops.example.com/", origin)).toBe("external");
  });

  it("does not allow a lookalike host", () => {
    expect(classifySelfHostNavigation("https://ops.example.com.attacker.tld/", origin)).toBe(
      "external",
    );
  });
});

/* ── Static scan: the dangerous surface stays gone ───────────────────────── */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const main = read("../src/main/index.ts");
const preload = read("../src/preload/index.ts");
const updateWindow = read("../src/main/update-window.ts");
const selfhost = read("../src/main/selfhost-window.ts");
const menu = read("../src/main/menu.ts");
const promptPreload = read("../src/preload/selfhost-prompt.ts");

describe("main process navigation containment", () => {
  it("guards main-frame navigation with both will-navigate and will-redirect", () => {
    expect(main).toMatch(/\.on\(\s*["']will-navigate["']/);
    expect(main).toMatch(/\.on\(\s*["']will-redirect["']/);
    expect(main).toContain("classifyFrameNavigation");
  });

  it("exposes no renderer-driven navigation channel", () => {
    // loadURL from main bypasses will-navigate entirely, so an IPC `navigate`
    // handler would defeat the allowlist above.
    expect(main).not.toMatch(/ipcMain\.handle\(\s*["']navigate["']/);
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*["']navigate["']/);
  });

  it("does not load a self-hosted origin in the preloaded main frame", () => {
    expect(main).toContain("beginDesktopCloudConnect");
    expect(main).toContain("shell.openExternal(cloudAuthUrl)");
    expect(main).not.toContain("shell.openExternal(target.href)");
    expect(main).not.toContain("openSelfHostedDashboard");
    expect(main).toContain("parseSelfHostedDashboardUrl");
    expect(main).not.toMatch(/mainWindow\.loadURL\(\s*(target|origin|raw)/);
    expect(menu).toContain("Connect self-hosted instance…");
    expect(menu).toContain("Use local instance");
  });

  it("keeps official cloud connect on the compiled host", () => {
    expect(resolveDesktopCloudTarget(undefined, "https://app.openship.io")).toEqual({
      dashboardOrigin: "https://app.openship.io",
    });
    expect(resolveDesktopCloudTarget("https://ops.example.com/login", "https://app.openship.io")).toEqual({
      dashboardOrigin: "https://ops.example.com",
      apiOrigin: "https://ops.example.com/api/proxy",
    });
    expect(resolveDesktopCloudTarget("http://evil.example", "https://app.openship.io")).toEqual({
      error: "invalid_selfhost_url",
    });
    const url = buildDesktopCloudAuthorizeUrl({
      dashboardOrigin: "https://ops.example.com",
      callbackUrl: "http://127.0.0.1:4010/api/auth/cloud-callback",
      state: "state",
      codeChallenge: "challenge",
      machine: "mac",
    });
    expect(url.startsWith("https://ops.example.com/authorize?")).toBe(true);
    expect(url).toContain("flow=desktop-cloud");
    expect(url).not.toContain("app.openship.io");
  });

  it("guards the update window too", () => {
    expect(updateWindow).toMatch(/\.on\(\s*["']will-navigate["']/);
    expect(updateWindow).toMatch(/\.on\(\s*["']will-redirect["']/);
  });

  it("renders advisory copy in the update window before raw release notes", () => {
    expect(updateWindow).toContain("info.announcement?.title");
    expect(updateWindow).toContain("info.announcement?.message");
    expect(updateWindow).toContain('(info.notes || "").trim()');
    expect(updateWindow).toContain('id="announcement"');
    expect(updateWindow).toContain('id="notes"');
  });

  it("keeps the real changelog in its own scrollable region and links to the website", () => {
    expect(updateWindow).toContain("overflow-y:auto");
    expect(updateWindow).toContain("min-height:0");
    expect(updateWindow).toContain("changelogUrl(`v${info.version}`)");
    expect(updateWindow).toContain("openExternal(INFO.changelogUrl)");
  });
});

describe("credential surface is off the bridge", () => {
  it("has no config:getAll and no SSH settings channels", () => {
    for (const channel of ["config:getAll", "system:get-settings", "system:update-settings"]) {
      expect(main, channel).not.toContain(`"${channel}"`);
      expect(preload, channel).not.toContain(`"${channel}"`);
    }
  });

  it("validates every config key crossing the bridge", () => {
    expect(main).toContain("isRendererConfigKey");
  });
});

describe("self-hosted window stays off the preload bridge", () => {
  it("keeps the connect prompt on a local page and blocks navigation", () => {
    expect(selfhost).toMatch(/\.on\(\s*["']will-navigate["']/);
    expect(selfhost).toMatch(/\.on\(\s*["']will-redirect["']/);
    expect(selfhost).toContain("sandbox: true");
    expect(selfhost).not.toContain("sandbox: false");
    expect(selfhost).toContain("data:text/html");
    expect(selfhost).not.toContain("loadURL(target");
  });

  it("gives the connect prompt only the self-host channels", () => {
    expect(promptPreload).toContain('exposeInMainWorld("selfhostPrompt"');
    expect(promptPreload).not.toContain("config:get");
    expect(promptPreload).not.toContain("onboarding:complete");
    expect(promptPreload).not.toContain("system:get-settings");
  });
});

describe("openExternal is scheme-gated", () => {
  it("no longer prefix-matches 'http' and validates the onboarding passthrough", () => {
    expect(main).not.toContain('url.startsWith("http")');
    expect(main).toContain("isSafeExternalUrl");
  });
});

describe("update window cannot be injected via release notes", () => {
  it("escapes '<' in the JSON payload embedded in the inline script", () => {
    expect(updateWindow).toContain("\\\\u003c");
    // Guard the actual breakout, not just the presence of an escape.
    const html = updateWindow.match(/const payload = ([\s\S]*?);\n/)?.[1] ?? "";
    expect(html).toContain("replace(");
  });
});
