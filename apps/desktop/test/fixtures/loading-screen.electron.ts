import { app, BrowserWindow, nativeTheme } from "electron";
import { strict as assert } from "node:assert";
import palettes from "../../../../packages/core/src/appearance-defaults.json";
import { buildLoadingScreen } from "../../src/main/loading-screen";

const directory = process.argv.find((value) => value.startsWith("--fixture-dir="))?.slice(14);
assert.ok(directory);
app.setPath("userData", directory);
// Keep the fixture alive between the two independent startup windows.
app.on("window-all-closed", () => {});

async function verifyPalette(window: BrowserWindow, theme: "light" | "dim" | "dark") {
  const rendered = await window.webContents.executeJavaScript(`(async () => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const root = getComputedStyle(document.documentElement);
    const title = getComputedStyle(document.getElementById('title'));
    const outline = getComputedStyle(document.querySelector('.art .brand-ring'));
    return {
      backgroundToken: root.getPropertyValue('--th-bg-page').trim(),
      textToken: root.getPropertyValue('--th-text-title').trim(),
      background: getComputedStyle(document.body).backgroundColor,
      text: title.color,
      ring: outline.stroke,
      visible: document.querySelector('.startup').getBoundingClientRect().width > 0,
      font: document.fonts.check('16px Gellix'),
    };
  })()`);
  assert.equal(
    rendered.backgroundToken,
    palettes[theme]["--th-bg-page"],
    `${theme} background palette`,
  );
  assert.equal(rendered.textToken, palettes[theme]["--th-text-title"], `${theme} text palette`);
  assert.notEqual(rendered.background, "rgba(0, 0, 0, 0)", `${theme} background is opaque`);
  assert.notEqual(rendered.text, rendered.background, `${theme} text is visible`);
  assert.equal(rendered.ring, rendered.text, `${theme} artwork uses visible theme color`);
  assert.ok(rendered.visible, `${theme} content is laid out`);
  assert.ok(rendered.font, `${theme} font is embedded`);
}

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined;
  try {
    for (const dark of [false, true]) {
      nativeTheme.themeSource = dark ? "dark" : "light";
      const theme = dark ? "dim" : "light";
      const html = buildLoadingScreen({ dark, version: "9.8.7", windowControls: !dark });
      window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const requests: string[] = [];
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (!details.url.startsWith("data:")) requests.push(details.url);
        callback({});
      });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      assert.equal(
        await window.webContents.executeJavaScript("document.documentElement.dataset.theme"),
        theme,
      );
      await verifyPalette(window, theme);
      assert.ok(!html.includes("@import"), "Startup has no external CSS imports");
      for (const [stage, message, completed] of [
        ["services", "Preparing your workspace", 1],
        ["dashboard", "Opening your dashboard", 2],
      ] as const) {
        const progress = await window.webContents.executeJavaScript(`(() => {
          window.__osStage(${JSON.stringify(stage)});
          return {
            stage: document.getElementById('stage').textContent,
            completed: document.querySelectorAll('.step.complete').length,
            current: document.querySelector('[aria-current="step"]').dataset.step,
          };
        })()`);
        assert.deepEqual(progress, { stage: message, completed, current: stage });
      }
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.getElementById('version').textContent",
        ),
        "v9.8.7",
      );
      // Dark is also a shared palette; the native system-dark preference starts
      // with dim, and a later palette selection must retain legible artwork.
      await verifyPalette(window, "dark");
      assert.deepEqual(requests, [], "Startup does not depend on a server or the network");
      window.destroy();
      window = undefined;
    }
    console.log("Electron loading screen passed");
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
});
