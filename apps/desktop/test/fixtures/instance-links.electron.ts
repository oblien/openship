import { app } from "electron";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { desktopInstanceLink } from "@repo/core";
import { InstanceLinkInbox, registerInstanceLinks } from "../../src/main/instance-links";

const directory = process.argv.find((value) => value.startsWith("--fixture-dir="))?.slice(14);
assert.ok(directory);
app.setPath("userData", directory);
const inbox = new InstanceLinkInbox();
let activated!: () => void;
const secondLaunch = new Promise<void>((resolve) => {
  activated = resolve;
});
const owner = registerInstanceLinks(
  app,
  (url) => {
    inbox.receive(url);
  },
  activated,
  process.argv,
);

if (owner) {
  void app
    .whenReady()
    .then(async () => {
      const cold = "https://cold.example.test/accept-invite/inv_cold";
      const warm = "https://warm.example.test/accept-invite/inv_warm";
      assert.equal(inbox.pending()?.address, cold);
      // macOS delivers this event instead of command-line arguments. Use the
      // real emitter without installing an OS handler over the user's app.
      let prevented = false;
      app.emit(
        "open-url",
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        desktopInstanceLink("https://mac.example.test/accept-invite/inv_mac"),
      );
      assert.ok(prevented);
      // The fixture is bundled as CommonJS; argv[1] may be an Electron switch.
      const entry = __filename;
      const child = spawn(
        process.execPath,
        [
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          entry,
          `--fixture-dir=${directory}`,
          desktopInstanceLink(warm),
        ],
        { env: process.env, stdio: "ignore" },
      );
      const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const timeout = setTimeout(() => {
        child.kill();
        console.error("The second Desktop launch did not deliver its link.");
        app.exit(1);
      }, 15_000);
      child.on("error", (error) => {
        console.error(error.message);
        app.exit(1);
      });
      try {
        await secondLaunch;
        const addresses: string[] = [];
        while (inbox.pending()) {
          const pending = inbox.pending()!;
          addresses.push(pending.address);
          inbox.acknowledge(pending.id);
        }
        assert.deepEqual(addresses, [cold, "https://mac.example.test/accept-invite/inv_mac", warm]);
        console.log(
          "Electron instance links passed: cold launch, macOS event, second process, confirmation queue",
        );
      } finally {
        clearTimeout(timeout);
        child.kill();
        await childClosed;
      }
      app.quit();
    })
    .catch((error) => {
      console.error(error.message);
      app.exit(1);
    });
}
