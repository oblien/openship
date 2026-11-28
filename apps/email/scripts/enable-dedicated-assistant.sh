#!/usr/bin/env bash
# Run on the dedicated mail VM after its assistant-only rootless Docker engine is ready.
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
[[ $# == 3 && $(id -u) == 0 ]] || fail "Run as root: $0 WEBMAIL_CONTAINER /run/user/UID/docker.sock RELEASE_DIRECTORY"
container=$1
socket=$2
release=$3
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail "Invalid webmail container."
[[ $socket =~ ^/run/user/([1-9][0-9]*)/docker\.sock$ && -S $socket ]] || fail "Supply the assistant user's rootless Docker socket."
uid=$(stat -Lc '%u' "$socket")
[[ $socket == "/run/user/$uid/docker.sock" && $uid != 0 ]] || fail "Unexpected socket owner."
main=(docker --host unix:///var/run/docker.sock)
ai=(docker --host "unix://$socket")

"${main[@]}" exec "$container" bun -e 'import { mailHostingPlacement } from "/app/server/src/mail/sending-settings.ts"; if (mailHostingPlacement() !== "dedicated") process.exit(1)' ||
  fail "The running webmail must be bound to this dedicated VM first."
mount=$("${main[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/run/openship-mail-assistants"}}{{.Type}} {{.Name}} {{.RW}}{{end}}{{end}}' "$container")
[[ $mount =~ ^volume\ ([a-zA-Z0-9_.-]+)\ false$ ]] || fail "Redeploy dedicated webmail with its read-only assistant runtime volume."
volume=${BASH_REMATCH[1]}
dir=$("${main[@]}" volume inspect --format '{{.Mountpoint}}' "$volume")
[[ $dir =~ ^/[a-zA-Z0-9_./-]+$ && -d $dir && $(stat -Lc '%u:%a' "$dir") =~ ^0:(700|750|755)$ ]] ||
  fail "The runtime volume must have a root-owned private mountpoint."
asset=$("${main[@]}" exec "$container" bun -e 'import { dedicatedAssistantAsset } from "/app/server/src/mail/assistant-hosting.ts"; console.log(dedicatedAssistantAsset)')
[[ $asset =~ ^mindwired-v[0-9]+\.[0-9]+\.[0-9]+-linux-(amd64|arm64)$ && -f $release/$asset && -f $release/checksums.txt ]] ||
  fail "Provide the matching Mindwire release file ($asset) and checksums.txt."
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$release/checksums.txt")
[[ $expected =~ ^[[:xdigit:]]{64}$ ]] || fail "The release manifest has no unique checksum for $asset."
[[ $("${ai[@]}" info --format '{{range .SecurityOptions}}{{println .}}{{end}}') == *name=rootless* ]] || fail "The assistant engine must be rootless."
[[ $("${ai[@]}" info --format '{{.MemoryLimit}} {{.SwapLimit}} {{.CPUCfsQuota}} {{.PidsLimit}}') == "true true true true" ]] ||
  fail "Delegate memory, CPU and process limits to the assistant engine before enabling it."
[[ $("${ai[@]}" info --format '{{.ID}}') != $("${main[@]}" info --format '{{.ID}}') ]] || fail "Use a separate engine for assistants."
containers=$("${ai[@]}" ps -a --format '{{.ID}} {{.Label "io.openship.mail.assistant"}}')
while read -r id owner; do
  [[ -z $id || $owner =~ ^[a-f0-9]{64}$ ]] || fail "The assistant engine contains unrelated containers."
done <<< "$containers"

proxy=/usr/lib/systemd/systemd-socket-proxyd
[[ -x $proxy ]] || proxy=/lib/systemd/systemd-socket-proxyd
[[ -x $proxy ]] || fail "Install systemd-socket-proxyd on the VM."
unit=openship-mail-assistants
# Named volume paths can exceed Linux's 107-byte Unix socket address limit.
runtime=/etc/openship-mail-assistant-runtime
if [[ -e $runtime || -L $runtime ]]; then
  [[ -L $runtime && $(readlink "$runtime") == "$dir" ]] || fail "A different runtime already uses $runtime."
fi
stage=$(mktemp -d)
binary=$(mktemp -- "$dir/.mindwired-XXXXXXXX")
trap 'rm -rf -- "$stage"; rm -f -- "$binary"' EXIT
install -m 0444 -- "$release/$asset" "$binary"
actual=$(sha256sum -- "$binary")
[[ ${actual%% *} == "$expected" ]] || fail "Mindwire release checksum mismatch."
cat > "$stage/$unit.socket" <<EOF
[Unit]
Description=Dedicated OpenShip Mail assistant socket
RequiresMountsFor=$dir
[Socket]
ListenStream=$runtime/docker.sock
SocketMode=0600
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
EOF
cat > "$stage/$unit.service" <<EOF
[Unit]
Description=Connect dedicated webmail to its assistant engine
[Service]
User=$uid
ExecStart=$proxy $socket
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
EOF
for ext in socket service; do
  dest="/etc/systemd/system/$unit.$ext"
  [[ ! -e $dest ]] || cmp -s "$stage/$unit.$ext" "$dest" || fail "A different $dest already exists."
done
mv -fT -- "$binary" "$dir/$asset"
[[ -L $runtime ]] || ln -s -- "$dir" "$runtime"
for ext in socket service; do install -m 0644 "$stage/$unit.$ext" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now "$unit.socket"
reported=$(docker --host "unix://$runtime/docker.sock" info --format '{{.ID}}')
[[ $reported == "$("${ai[@]}" info --format '{{.ID}}')" ]] || fail "The webmail socket points to a different engine."
echo "Dedicated runtime ready. Sign in to a mailbox and open Settings → AI & agents → Connect AI."
