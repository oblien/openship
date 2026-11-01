import { AppError, shellQuote as q } from "@repo/core";
import type { CommandExecutor } from "@repo/adapters";
import type { IngressConnection } from "@repo/db";
const VERSION = "2026.10.0";
const IMAGE =
  "cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07";
const BIN = `/usr/local/lib/openship/cloudflared-${VERSION}`;
const RELEASES: Record<string, { asset: string; sha: string }> = {
  x86_64: {
    asset: "amd64",
    sha: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
  },
  aarch64: {
    asset: "arm64",
    sha: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
  },
};
function identity(connection: IngressConnection) {
  if (!/^[a-zA-Z0-9_-]+$/.test(connection.id) || !/^[a-zA-Z0-9-]+$/.test(connection.tunnelId ?? ""))
    throw new AppError("Invalid connector identity", 400, "INGRESS_CONNECTOR_ID");
  const name = `openship-cloudflare-${connection.id}`;
  return {
    name,
    dir: `/etc/openship/ingress/${connection.id}`,
    marker: JSON.stringify({ connectionId: connection.id, tunnelId: connection.tunnelId }),
  };
}
export async function manageConnector(
  executor: CommandExecutor,
  connection: IngressConnection,
  token: string | null,
  remove = false,
): Promise<void> {
  const { name, dir, marker } = identity(connection);
  const fail = (message: string): never => {
    throw new AppError(message, 409, "INGRESS_CONNECTOR_SETUP");
  };
  const root = (await executor.exec("id -u")).trim() === "0";
  const sudo = root ? "" : "sudo -n ";
  if (
    !root &&
    (await executor.exec("sudo -n true >/dev/null 2>&1 && echo yes || echo no")).trim() !== "yes"
  )
    fail(
      "Connector setup needs root or passwordless sudo. Install cloudflared yourself, then choose an existing connector.",
    );
  if ((await executor.exec("uname -s")).trim() !== "Linux")
    fail(
      "Automatic connector setup supports Linux. Install cloudflared on this server, then choose an existing connector.",
    );
  const read = async (path: string) => executor.exec(`${sudo}cat ${q(path)}`);
  const present =
    (await executor.exec(`${sudo}test -e ${q(dir)} && echo yes || echo no`)).trim() === "yes";
  if (present && (await read(`${dir}/owner.json`)).trim() !== marker)
    fail(
      "This connector directory is not owned by this setup. Review it on the server before retrying.",
    );
  const unit = `/etc/systemd/system/${name}.service`;
  const mode = (
    await executor.exec(
      "if command -v systemctl >/dev/null 2>&1 && test -d /run/systemd/system; then systemctl --version | head -1; elif command -v docker >/dev/null 2>&1; then echo docker; else echo unavailable; fi",
    )
  ).trim();
  const systemd = /^systemd (\d+)/.exec(mode);
  const useSystemd = Boolean(systemd && Number(systemd[1]) >= 247);
  const hasDocker =
    (await executor.exec("command -v docker >/dev/null 2>&1 && echo yes || echo no")).trim() ===
    "yes";
  const kindFile = `${dir}/runtime`;
  const hasKind =
    present &&
    (await executor.exec(`${sudo}test -f ${q(kindFile)} && echo yes || echo no`)).trim() === "yes";
  const storedKind = hasKind ? (await read(kindFile)).trim() : null;
  if (storedKind && !["systemd", "docker"].includes(storedKind))
    fail("The connector's ownership metadata changed. Review it on the server before retrying.");
  const kind = storedKind ?? (useSystemd ? "systemd" : "docker");
  const dockerExists = async () =>
    (
      await executor.exec(
        `${sudo}docker ps -a --filter ${q(`name=^/${name}$`)} --format '{{.Names}}'`,
      )
    ).trim() === name;

  const expectedUnit = `[Unit]\nDescription=Openship Cloudflare connector ${connection.id}\nAfter=network-online.target\nWants=network-online.target\n[Service]\nExecStart=${BIN} tunnel --no-autoupdate run --token-file /run/credentials/${name}.service/token\nLoadCredential=token:${dir}/token\nDynamicUser=yes\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\n[Install]\nWantedBy=multi-user.target\n`;
  if (remove) {
    if (!present) return;
    if (
      (await executor.exec(`${sudo}test -e ${q(unit)} && echo yes || echo no`)).trim() === "yes"
    ) {
      if ((await read(unit)).trim() !== expectedUnit.trim())
        fail("The connector service was edited outside Openship. It has been retained for review.");
      await executor.exec(`${sudo}systemctl disable --now ${q(name + ".service")}`);
      await executor.exec(`${sudo}rm -f ${q(unit)} && ${sudo}systemctl daemon-reload`);
    } else if (kind === "systemd") {
      const state = (
        await executor.exec(
          `${sudo}systemctl show ${q(name + ".service")} --property=ActiveState --value`,
        )
      ).trim();
      if (!["inactive", "failed"].includes(state))
        fail(
          "The connector service is still running but its unit file is missing. Restore the owned unit file or stop the service before retrying cleanup.",
        );
    } else if (await dockerExists()) {
      const owner = (
        await executor.exec(
          `${sudo}docker inspect --format '{{index .Config.Labels "openship.ingress"}}' ${q(name)}`,
        )
      ).trim();
      if (owner !== connection.id)
        fail(
          "The connector container is not owned by this setup. It has been retained for review.",
        );
      await executor.exec(`${sudo}docker rm -f ${q(name)}`);
    }
    await executor.exec(`${sudo}rm -rf ${q(dir)}`);
    return;
  }
  if (!token || !/^[a-zA-Z0-9._=-]+$/.test(token))
    fail("Cloudflare did not return a usable connector token. Retry setup.");
  if ((kind === "systemd" && !useSystemd) || (kind === "docker" && !hasDocker))
    fail(
      "Connector setup needs systemd 247 or newer, or Docker. Install cloudflared yourself and choose an existing connector instead.",
    );
  const tmp = (await executor.exec("mktemp -d /tmp/openship-ingress.XXXXXXXXXX")).trim();
  if (!/^\/tmp\/openship-ingress\.[a-zA-Z0-9]+$/.test(tmp))
    fail("Could not create a private setup directory.");
  try {
    await executor.writeFile(`${tmp}/token`, token!, { mode: 0o600 });
    await executor.writeFile(`${tmp}/owner.json`, marker, { mode: 0o600 });
    await executor.writeFile(`${tmp}/runtime`, kind, { mode: 0o600 });
    await executor.exec(
      `${sudo}install -d -m 700 ${q(dir)} && ${sudo}install -m 600 ${q(tmp + "/owner.json")} ${q(dir + "/owner.json")} && ${sudo}install -m 600 ${q(tmp + "/runtime")} ${q(kindFile)}`,
    );
    const sameToken =
      present &&
      (
        await executor.exec(
          `${sudo}test -f ${q(dir + "/token")} && ${sudo}cmp -s ${q(tmp + "/token")} ${q(dir + "/token")} && echo yes || echo no`,
        )
      ).trim() === "yes";
    if (kind === "systemd") {
      const arch = (await executor.exec("uname -m")).trim();
      const release = RELEASES[arch];
      if (!release)
        fail(
          "Automatic connector setup supports Linux x86-64 and ARM64. Use an existing connector on this architecture.",
        );
      if (
        (await executor.exec(`${sudo}test -f ${q(BIN)} && echo yes || echo no`)).trim() !== "yes"
      ) {
        await executor.exec(
          `curl --fail --location --silent --show-error --max-time 180 ${q(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-${release.asset}`)} -o ${q(tmp + "/cloudflared")}`,
          { timeout: 190000 },
        );
        await executor.exec(
          `printf '%s  %s\\n' ${q(release.sha)} ${q(tmp + "/cloudflared")} | sha256sum -c -`,
        );
        await executor.exec(
          `${sudo}install -d -m 755 /usr/local/lib/openship && ${sudo}install -m 755 ${q(tmp + "/cloudflared")} ${q(BIN)}`,
        );
      } else
        await executor.exec(`${sudo}sha256sum ${q(BIN)} | cut -d ' ' -f 1`).then((sha) => {
          if (sha.trim() !== release.sha)
            fail(
              "The managed cloudflared binary changed outside Openship. Review it before retrying.",
            );
        });
      if (
        (await executor.exec(`${sudo}test -e ${q(unit)} && echo yes || echo no`)).trim() ===
          "yes" &&
        (await read(unit)).trim() !== expectedUnit.trim()
      )
        fail("The connector service was edited outside Openship. Review it before retrying.");
      const active =
        (
          await executor.exec(`${sudo}systemctl is-active ${q(name + ".service")} || true`)
        ).trim() === "active";
      if (sameToken && active) return;
      await executor.writeFile(`${tmp}/unit`, expectedUnit, { mode: 0o600 });
      await executor.exec(
        `${sudo}install -m 600 ${q(tmp + "/token")} ${q(dir + "/token")} && ${sudo}install -m 644 ${q(tmp + "/unit")} ${q(unit)} && ${sudo}systemctl daemon-reload && ${sudo}systemctl enable --now ${q(name + ".service")}`,
      );
      if (active) await executor.exec(`${sudo}systemctl restart ${q(name + ".service")}`);
    } else {
      const exists = await dockerExists();
      if (exists) {
        const owner = (
          await executor.exec(
            `${sudo}docker inspect --format '{{index .Config.Labels "openship.ingress"}}' ${q(name)}`,
          )
        ).trim();
        if (owner !== connection.id)
          fail("A container already uses this connector name. Openship will not replace it.");
        if (sameToken) {
          await executor.exec(`${sudo}docker start ${q(name)}`);
          return;
        }
        // Recreate on rotation: a bind mount can retain the old file inode.
        await executor.exec(`${sudo}docker rm -f ${q(name)}`);
      }
      await executor.exec(
        `${sudo}install -o 65532 -g 65532 -m 400 ${q(tmp + "/token")} ${q(dir + "/token")}`,
      );
      await executor.exec(
        `${sudo}docker run -d --name ${q(name)} --label ${q(`openship.ingress=${connection.id}`)} --restart unless-stopped --network host --read-only --cap-drop ALL --security-opt no-new-privileges --user 65532:65532 --mount ${q(`type=bind,src=${dir}/token,dst=/run/secrets/token,readonly`)} ${q(IMAGE)} tunnel --no-autoupdate run --token-file /run/secrets/token`,
        { timeout: 190000 },
      );
    }
  } finally {
    await executor.rm(tmp);
  }
}
