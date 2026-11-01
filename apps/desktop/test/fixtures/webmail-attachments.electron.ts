import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const directory = process.argv.find((value) => value.startsWith("--fixture-dir="))?.slice(14);
assert.ok(directory);
app.setPath("userData", directory);
app.on("window-all-closed", () => {});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Attachment viewer did not finish loading");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

void app.whenReady().then(async () => {
  const renderer = await readFile(join(directory, "renderer.js"));
  let executions = 0;
  const server = createServer((request, response) => {
    if (request.url === "/renderer.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(renderer);
    } else if (request.url === "/executed") {
      executions++;
      response.end("recorded");
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><script src="/renderer.js"></script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const popups: BrowserWindow[] = [];
  window.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { show: false },
  }));
  window.webContents.on("did-create-window", (popup) => popups.push(popup));
  // The renderer learns of a destroyed popup asynchronously, and reopening the
  // named viewer before then reuses the dying window.
  const closeViewer = async (popup: BrowserWindow) => {
    popup.destroy();
    const deadline = Date.now() + 5000;
    while (!(await window.webContents.executeJavaScript("window.viewerClosed()"))) {
      if (Date.now() > deadline) throw new Error("Attachment viewer did not close");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const script = `fetch('${origin}/executed')`;
  try {
    await window.loadURL(origin);
    // Positive control: the browser really executes sender HTML in a creator-
    // origin blob. The protected attachment path below must never do this.
    await window.webContents.executeJavaScript(
      `(() => {
      const popup = window.open('', 'positive-control');
      popup.location.href = URL.createObjectURL(new Blob([${JSON.stringify(`<script>${script}</script>`)}], {type:'text/html'}));
    })()`,
      true,
    );
    await until(() => executions === 1);
    for (const popup of popups.splice(0)) popup.destroy();
    executions = 0;

    const cases = [
      ["text/html", "message.html", `<script>${script}</script>`],
      ["TEXT/HTML; charset=utf-8", "message.html", `<script>${script}</script>`],
      [
        "image/svg+xml",
        "drawing.svg",
        `<svg xmlns="http://www.w3.org/2000/svg"><script>${script}</script></svg>`,
      ],
      [
        "application/xhtml+xml",
        "message.xhtml",
        `<html xmlns="http://www.w3.org/1999/xhtml"><script>${script}</script></html>`,
      ],
      [
        "text/xml",
        "message.xml",
        `<html xmlns="http://www.w3.org/1999/xhtml"><script>${script}</script></html>`,
      ],
      ["application/xml", "message.xml", `<root>${script}</root>`],
      ["", "unknown.html", `<script>${script}</script>`],
      ["text/plain, text/html", "invalid.html", `<script>${script}</script>`],
      // An Office preview that cannot render downloads, never opens the raw blob.
      [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "broken.xlsx",
        "not a zip archive",
      ],
      ["text/html", "invoice.docx", `<script>${script}</script>`],
      // Chromium silently drops script-started downloads after ten per window,
      // so further cases need a new BrowserWindow.
    ];
    for (const [index, [mimeType, filename, payload]] of cases.entries()) {
      const output = join(directory, `download-${index}`);
      const downloaded = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Attachment ${mimeType} was not downloaded`)),
          5000,
        );
        window.webContents.session.once("will-download", (_event, item) => {
          // A throw here would be uncaught in the main process and stall the run.
          if (item.getFilename() !== filename) {
            clearTimeout(timeout);
            item.cancel();
            reject(new Error(`Downloaded ${item.getFilename()} instead of ${filename}`));
            return;
          }
          item.setSavePath(output);
          item.once("done", (_event, state) => {
            clearTimeout(timeout);
            state === "completed" ? resolve() : reject(new Error(`Download ${state}`));
          });
        });
      });
      const attachment = {
        mimeType,
        filename,
        body: Buffer.from(payload!).toString("base64"),
        attachmentId: String(index),
      };
      await window.webContents.executeJavaScript(
        `window.openMailAttachment(${JSON.stringify(attachment)})`,
        true,
      );
      await downloaded;
      assert.equal(await readFile(output, "utf8"), payload);
      // Renderer Window.close() completes asynchronously on Linux.
      await until(() => popups.every((popup) => popup.isDestroyed()));
      popups.length = 0;
    }
    const text = `<script>${script}</script>`;
    await window.webContents.executeJavaScript(
      `window.openMailAttachment(${JSON.stringify({ mimeType: "TEXT/PLAIN; charset=utf-8", filename: "message.txt", body: Buffer.from(text).toString("base64"), attachmentId: "text" })})`,
      true,
    );
    let popup = popups.at(-1)!;
    await until(
      () => !popup.webContents.isLoading() && popup.webContents.getURL().startsWith("blob:"),
    );
    assert.equal(await popup.webContents.executeJavaScript("document.body.textContent"), text);
    await closeViewer(popup);
    const png = await window.webContents.executeJavaScript("window.pngAttachment()");
    const image = {
      mimeType: "IMAGE/PNG; name=image.png",
      filename: "image.png",
      body: png,
      attachmentId: "png",
    };
    await window.webContents.executeJavaScript(
      `window.openMailAttachment(${JSON.stringify(image)})`,
      true,
    );
    popup = popups.at(-1)!;
    await until(
      () => !popup.webContents.isLoading() && popup.webContents.getURL().startsWith("blob:"),
    );
    assert.equal(
      await popup.webContents.executeJavaScript("document.querySelector('img').naturalWidth"),
      1,
    );
    await closeViewer(popup);
    await window.webContents.executeJavaScript(
      `window.openMailAttachment(${JSON.stringify(image)}, true)`,
      true,
    );
    popups.length = 0;
    const csv = `name,payload\nscript,<script>${script}</script>\nimage,"<img src=x onerror=""${script}"">"`;
    await window.webContents.executeJavaScript(
      `window.openMailAttachment(${JSON.stringify({ mimeType: "text/csv", filename: "report.csv", body: Buffer.from(csv).toString("base64"), attachmentId: "csv" })})`,
      true,
    );
    await until(() => popups.length === 1);
    popup = popups[0]!;
    await until(
      () =>
        !popup.webContents.isLoading() &&
        popup.webContents.getURL().startsWith("blob:") &&
        popup.webContents.mainFrame.frames.length === 1,
    );
    const preview = popup.webContents.mainFrame.frames[0]!;
    assert.equal(preview.origin, "null", "Generated previews render in an opaque origin");
    assert.equal(
      await popup.webContents.executeJavaScript(
        "document.querySelector('iframe').getAttribute('sandbox')",
      ),
      "",
    );
    assert.match(
      await popup.webContents.executeJavaScript("document.querySelector('iframe').srcdoc"),
      /<td>&lt;script&gt;fetch/,
    );
    popup.webContents.debugger.attach("1.3");
    try {
      // Script execution is disabled in this frame, so inspect its rendered DOM
      // over DevTools rather than relaxing the production sandbox for the test.
      const { targetInfos } = (await popup.webContents.debugger.sendCommand(
        "Target.getTargets",
      )) as {
        targetInfos: { targetId: string; type: string; url: string }[];
      };
      const target = targetInfos.find(
        (target) => target.type === "iframe" && target.url === "about:srcdoc",
      );
      assert.ok(target);
      const { sessionId } = await popup.webContents.debugger.sendCommand("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      const { root } = await popup.webContents.debugger.sendCommand(
        "DOM.getDocument",
        {},
        sessionId,
      );
      const { nodeIds } = await popup.webContents.debugger.sendCommand(
        "DOM.querySelectorAll",
        {
          nodeId: root.nodeId,
          selector: "td",
        },
        sessionId,
      );
      assert.equal(nodeIds.length, 6, "The sandboxed preview renders the CSV cells");
    } finally {
      popup.webContents.debugger.detach();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await closeViewer(popup);
    assert.equal(executions, 0, "No attachment script ran in the webmail origin");
    console.log("Webmail attachment browser checks passed");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    window.destroy();
    server.close();
  }
});
