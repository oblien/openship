// Real Electron windows and Chromium storage, with a local discovery and webmail fixture.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");
const { setTimeout: delay } = require("node:timers/promises");

async function findPage(desktop, matches, previous = []) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = desktop.windows().find((page) => !previous.includes(page) && matches(page.url()));
    if (page) return page;
    await delay(30);
  }
  throw new Error("Desktop did not open the expected view.");
}

test("connect, switch, reopen, and forget isolated mailboxes", { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openship-mail-desktop-"));
  const requests = [];
  let origin;
  const server = createServer((req, res) => {
    if (req.url === "/auth/session") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("null");
      return;
    }
    if (req.url.startsWith("/api/mail/discovery")) {
      requests.push(req.url);
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ webmailUrl: origin }));
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<title>Mailbox</title><main>Mailbox</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  let desktop;
  async function start() {
    desktop = await _electron.launch({
      args: [path.join(__dirname, "..")],
      env: {
        ...process.env,
        OPENSHIP_MAIL_USER_DATA_DIR: directory,
        OPENSHIP_CLOUD_API_URL: origin,
      },
    });
    return desktop.firstWindow();
  }
  t.after(async () => {
    if (desktop) await desktop.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const picker = await start();
  async function switcher() {
    await desktop.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((i) => i.label === "Mailboxes")
        .submenu.items[0].click(),
    );
    await picker.getByRole("heading", { name: "Your mailboxes" }).waitFor();
  }
  async function add(email, self) {
    await picker.getByLabel("Email address").fill(email);
    if (self) {
      await picker.getByText("Self-hosted", { exact: true }).click();
      await picker.getByLabel("Webmail address").fill(origin);
    }
    const previous = desktop.windows();
    await picker.getByRole("button", { name: "Continue" }).click();
    const page = await findPage(desktop, (url) => url.startsWith(origin + "/"), previous);
    await page.locator("main").waitFor();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("email"), email);
    assert.equal(await page.evaluate(() => typeof window.mailboxes), "undefined");
    return page;
  }
  const first = await add("alex@company.test", false);
  const header = await findPage(desktop, (url) => url.endsWith("/frame.html"));
  const back = header.getByRole("button", { name: "Back", exact: true });
  const forward = header.getByRole("button", { name: "Forward", exact: true });
  await back.waitFor();
  assert.equal(await back.isDisabled(), true);
  const metrics = await header.locator("header").boundingBox();
  assert.equal(metrics.height, 44);
  if (process.platform === "darwin") assert.equal((await back.boundingBox()).x, 92);
  await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/frame.html"),
    );
    win.setContentSize(900, 600);
  });
  await first.waitForFunction(() => innerWidth === 900 && innerHeight === 556);
  assert.equal(await first.evaluate(() => typeof window.mailFrame), "undefined");
  await first.evaluate(() => history.pushState({}, "", "/mail/sent"));
  await back.click();
  await first.waitForURL("**/login#**");
  await forward.click();
  await first.waitForURL("**/mail/sent");
  await first.evaluate(() => {
    document.cookie = "session=alex; Max-Age=3600; Path=/";
  });
  await switcher();
  await picker.getByRole("button", { name: "Add mailbox" }).click();
  const second = await add("sam@company.test", true);
  assert.equal(await second.evaluate(() => document.cookie), "");
  assert.deepEqual(requests, ["/api/mail/discovery?domain=company.test"]);
  await desktop.close();
  desktop = null;
  const reopened = await start();
  await reopened.getByRole("button", { name: /alex@company.test OpenShip Cloud/ }).click();
  const inbox = await findPage(desktop, (url) => url.startsWith(origin + "/"));
  await inbox.locator("main").waitFor();
  assert.equal(await inbox.evaluate(() => document.cookie), "session=alex");
  assert.equal(requests.length, 2);
  await desktop.evaluate(({ Menu, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    Menu.getApplicationMenu()
      .items.find((i) => i.label === "Mailboxes")
      .submenu.items[0].click();
  });
  await reopened.getByRole("button", { name: "Remove alex@company.test" }).click();
  await reopened
    .getByRole("button", { name: "Remove alex@company.test" })
    .waitFor({ state: "detached" });
  assert.equal(await reopened.getByRole("button", { name: "Remove sam@company.test" }).count(), 1);
  await desktop.close();
  desktop = null;
  await start();
  const resumed = await findPage(desktop, (url) => url.startsWith(origin + "/"));
  await resumed.waitForURL(origin + "/");
  assert.equal(await resumed.evaluate(() => document.cookie), "");
});

test(
  "opens the sample inbox through the real webmail login",
  { skip: !process.env.OPENSHIP_MAIL_SAMPLE_URL, timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "openship-mail-sample-"));
    const desktop = await _electron.launch({
      args: [path.join(__dirname, "..")],
      env: {
        ...process.env,
        OPENSHIP_MAIL_USER_DATA_DIR: directory,
      },
    });
    t.after(async () => {
      await desktop.close();
      await rm(directory, { recursive: true, force: true });
    });
    const picker = await desktop.firstWindow();
    await picker.getByText("Self-hosted", { exact: true }).click();
    await picker.getByLabel("Email address").fill("alex@openship.test");
    const origin = new URL(process.env.OPENSHIP_MAIL_SAMPLE_URL);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname));
    await picker.getByLabel("Webmail address").fill(origin.origin);
    await picker.getByRole("button", { name: "Continue" }).click();
    const page = await findPage(desktop, (url) => url.startsWith(origin.origin + "/"));
    await page.waitForFunction(
      () => document.querySelector("input[type=email]")?.value === "alex@openship.test",
    );
    await page.locator("input[type=password]").fill("sample-mail");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/mail/inbox");
    await page.getByText("Your sample inbox is ready", { exact: true }).first().waitFor();
    const identity = await page.evaluate(
      async () => (await (await fetch("/auth/session")).json()).email,
    );
    assert.equal(identity, "alex@openship.test");
  },
);
