import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const directory = process.argv.find((value) => value.startsWith("--fixture-dir="))?.slice(14);
assert.ok(directory);
app.setPath("userData", directory);
void app.whenReady().then(async () => {
  const renderer = await readFile(join(directory, "renderer.js"));
  const server = createServer((request, response) => {
    if (request.url === "/renderer.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(renderer);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><script src="/renderer.js"></script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  try {
    await window.loadURL(`http://127.0.0.1:${address.port}`);
    await window.webContents.executeJavaScript("window.editorCheck()");
    console.log("Webmail editor browser checks passed");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    window.destroy();
    server.close();
  }
});
