import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";

const run = promisify(execFile);
const docker = async (...args: string[]) =>
  (await run("docker", args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();

/** Runs the catalog's actual image/argv against a disposable TLS IMAP fixture.
 * No mailbox credentials, mail delivery, or production servers are involved.
 * Run: DOCKER_CONTEXT=<context> bun scripts/smoke-catalog-radicale.ts */
export async function smokeRadicale() {
  const service = buildCatalog().apps.find((app) => app.id === "radicale")!.services![0]!;
  const name = "openship-radicale-smoke-" + randomUUID().slice(0, 8);
  const imap = name + "-imap";
  const volume = name + "-data";
  const dir = await mkdtemp(join(tmpdir(), name));
  const password = randomUUID();
  const alice = "alice@example.com";
  const bob = "bob@example.com";
  const otherDomain = "alice@other.example";
  const accounts: Record<string, string> = {
    [alice]: password,
    [bob]: password,
    [otherDomain]: password,
  };
  const platform = process.env.CATALOG_TEST_PLATFORM;
  const platformArgs = platform ? ["--platform", platform] : [];
  let url = "";
  let networkCreated = false;
  let volumeCreated = false;

  const request = async (
    path: string,
    method: string,
    username?: string,
    pass = password,
    body?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(url + path, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(username
          ? { Authorization: "Basic " + Buffer.from(username + ":" + pass).toString("base64") }
          : {}),
        ...headers,
      },
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  const updateAccounts = async () => {
    await writeFile(join(dir, "accounts.json"), JSON.stringify(accounts));
    await docker("cp", join(dir, "accounts.json"), imap + ":/fixture/accounts.json");
  };
  const start = async (host = "imap", trustCertificate = true) => {
    await docker(
      "create",
      "--name",
      name,
      "--label",
      "openship.test=catalog-radicale",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--network",
      name,
      ...platformArgs,
      "-p",
      "127.0.0.1::5232",
      "--mount",
      `type=volume,source=${volume},target=${service.volumes![0]!.split(":")[1]}`,
      "-e",
      "IMAP_HOST=" + host,
      ...(trustCertificate ? ["-e", "SSL_CERT_FILE=/smoke-ca.pem"] : []),
      "--entrypoint",
      service.entrypointArgv![0]!,
      service.image!,
      ...service.entrypointArgv!.slice(1),
      ...service.commandArgv!,
    );
    await docker("cp", join(dir, "cert.pem"), name + ":/smoke-ca.pem");
    await docker("start", name);
    if ((await docker("inspect", "--format", "{{.State.Running}}", name)) !== "true") {
      const logs = await run("docker", ["logs", name]);
      throw new Error("Radicale startup failed: " + logs.stdout + logs.stderr);
    }
    const port = await docker("port", name, "5232/tcp");
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    url = "http://" + port;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      let ready = false;
      try {
        ready = (await request("/.well-known/caldav", "GET")).status === 301;
      } catch {
        /* The container is still starting. */
      }
      if (ready) {
        assert.equal(service.healthcheck!.test[0], "CMD");
        await docker("exec", name, ...service.healthcheck!.test.slice(1));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Radicale did not become ready");
  };

  try {
    await docker("pull", ...platformArgs, service.image!);
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=imap",
      "-addext",
      "subjectAltName=DNS:imap",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]);
    await copyFile(
      fileURLToPath(new URL("./fixtures/radicale-imap.py", import.meta.url)),
      join(dir, "server.py"),
    );
    await writeFile(join(dir, "accounts.json"), JSON.stringify(accounts));
    await docker("network", "create", "--label", "openship.test=catalog-radicale", name);
    networkCreated = true;
    await docker("volume", "create", "--label", "openship.test=catalog-radicale", volume);
    volumeCreated = true;
    await docker(
      "create",
      "--name",
      imap,
      "--label",
      "openship.test=catalog-radicale",
      "--user",
      "0:0",
      "--network",
      name,
      "--network-alias",
      "imap",
      "--network-alias",
      "wrong-host",
      ...platformArgs,
      "--entrypoint",
      "/app/bin/python",
      service.image!,
      "/fixture/server.py",
    );
    await docker("cp", dir, imap + ":/fixture");
    await docker("start", imap);
    await start();

    for (const path of ["/.well-known/caldav", "/.well-known/carddav"]) {
      for (const method of ["GET", "PROPFIND"]) {
        const result = await request(path, method);
        assert.equal(result.status, 301, method + " " + path);
        assert.equal(result.headers.get("location"), "/");
      }
    }
    assert.equal((await request("/alice@example.com/", "PROPFIND")).status, 401);
    assert.equal((await request("/alice@example.com/", "PROPFIND", alice, "wrong")).status, 401);
    assert.equal(
      (
        await request("/alice@example.com/", "PROPFIND", undefined, password, undefined, {
          "X-Remote-User": alice,
        })
      ).status,
      401,
    );
    for (const username of [alice, bob, otherDomain])
      assert.equal(
        (
          await request("/" + username + "/", "PROPFIND", username, password, undefined, {
            Depth: "0",
          })
        ).status,
        207,
      );
    assert.equal(
      (
        await request("/alice@example.com/", "PROPFIND", "ALICE@EXAMPLE.COM", password, undefined, {
          Depth: "0",
        })
      ).status,
      207,
    );

    const calendar = "/alice@example.com/calendar/";
    const contacts = "/alice@example.com/contacts/";
    assert.equal((await request(calendar, "MKCALENDAR", alice)).status, 201);
    assert.equal(
      (
        await request(
          contacts,
          "MKCOL",
          alice,
          password,
          '<mkcol xmlns="DAV:"><set><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop></set></mkcol>',
          { "Content-Type": "application/xml" },
        )
      ).status,
      201,
    );
    const event = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//OpenShip//Smoke//EN",
      "BEGIN:VEVENT",
      "UID:" + name,
      "DTSTAMP:20261104T120000Z",
      "DTSTART:20261105T120000Z",
      "DTEND:20261105T130000Z",
      "SUMMARY:Mailbox calendar",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const card = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:" + name,
      "FN:Mailbox contact",
      "EMAIL:alice@example.com",
      "END:VCARD",
      "",
    ].join("\r\n");
    for (const [path, content, contentType] of [
      [calendar + "event.ics", event, "text/calendar"],
      [contacts + "contact.vcf", card, "text/vcard"],
    ]) {
      assert.equal(
        (await request(path!, "PUT", alice, password, content!, { "Content-Type": contentType! }))
          .status,
        201,
      );
      const saved = await request(path!, "GET", alice);
      assert.equal(saved.status, 200);
      const etag = saved.headers.get("etag");
      assert.ok(etag, "DAV clients need an ETag for conflict-safe updates");
      const updated = content!.replace("Mailbox", "Updated mailbox");
      assert.equal(
        (
          await request(path!, "PUT", alice, password, updated, {
            "Content-Type": contentType!,
            "If-Match": etag,
          })
        ).status,
        204,
      );
      assert.equal(
        (
          await request(path!, "PUT", alice, password, content!, {
            "Content-Type": contentType!,
            "If-Match": etag,
          })
        ).status,
        412,
      );
      for (const stranger of [bob, otherDomain]) {
        assert.equal((await request(path!, "GET", stranger)).status, 403);
        assert.equal((await request(path!, "DELETE", stranger)).status, 403);
      }
    }
    for (const [path, body] of [
      [
        calendar,
        '<calendar-query xmlns="urn:ietf:params:xml:ns:caldav"><prop xmlns="DAV:"><getetag/></prop><filter><comp-filter name="VCALENDAR"/></filter></calendar-query>',
      ],
      [
        contacts,
        '<addressbook-query xmlns="urn:ietf:params:xml:ns:carddav"><prop xmlns="DAV:"><getetag/></prop></addressbook-query>',
      ],
    ])
      assert.equal(
        (
          await request(path!, "REPORT", alice, password, body!, {
            "Content-Type": "application/xml",
            Depth: "1",
          })
        ).status,
        207,
      );
    console.log(
      "Radicale: discovery, CalDAV/CardDAV CRUD, native IMAP login and mailbox isolation passed",
    );

    accounts[alice] = "rotated-" + password;
    await updateAccounts();
    assert.equal((await request(calendar + "event.ics", "GET", alice)).status, 401);
    assert.equal(
      (await request(calendar + "event.ics", "GET", alice, accounts[alice])).status,
      200,
    );
    delete accounts[alice];
    await updateAccounts();
    assert.equal(
      (await request(calendar + "event.ics", "GET", alice, "rotated-" + password)).status,
      401,
    );
    accounts[alice] = password;
    await updateAccounts();

    await docker("rm", "-f", "-v", name);
    await start();
    assert.match(
      (await request(calendar + "event.ics", "GET", alice)).text,
      /SUMMARY:Updated mailbox calendar/,
    );
    assert.match(
      (await request(contacts + "contact.vcf", "GET", alice)).text,
      /FN:Updated mailbox contact/,
    );
    assert.equal((await request(contacts + "contact.vcf", "DELETE", alice)).status, 200);
    console.log("Radicale: password rotation, account disabling and persistent volume passed");

    for (const [host, trust] of [
      ["imap", false],
      ["wrong-host", true],
    ] as const) {
      await docker("rm", "-f", "-v", name);
      await start(host, trust);
      assert.equal((await request(calendar + "event.ics", "GET", alice)).status, 401);
    }
    console.log("Radicale: untrusted IMAP certificate and hostname mismatch fail closed");
  } finally {
    await docker("rm", "-f", "-v", name, imap).catch(() => {});
    if (volumeCreated) await docker("volume", "rm", volume).catch(() => {});
    if (networkCreated) await docker("network", "rm", name).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await smokeRadicale();
  } catch (error) {
    // Child-process errors can contain ephemeral credentials in argv.
    console.error(
      error instanceof Error && !("cmd" in error)
        ? error.message
        : "Radicale smoke failed during a Docker or certificate operation",
    );
    process.exitCode = 1;
  }
}
