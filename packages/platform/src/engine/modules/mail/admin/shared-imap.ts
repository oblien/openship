import { AppError, shellQuote } from "@repo/core";
import { createProvisionLock } from "../../../lib/provision-lock";
import { mailEngineCommand, runMailCommand } from "../mail-engine";

// The engine's /etc/dovecot bind mount survives container replacement.
// Render only the shared-host override, preserving the installed private-mailbox plugins.
export const sharedImapPolicy = `set -eu
dir=/etc/dovecot/iredmail
file="$dir/99-openship-shared.conf"
mkdir -p "$dir"
work=$(mktemp -d "$dir/.openship-shared.XXXXXX")
tmp="$work/policy"
trap 'rm -rf "$work"' EXIT
plugins=$(doveconf -f protocol=imap -h mail_plugins)
{
  printf 'protocol imap {\\n  mail_plugins ='
  for plugin in $plugins; do
    if [ "$plugin" != imap_acl ]; then printf ' %s' "$plugin"; fi
  done
  printf '\\n}\\nnamespace shared {\\n  disabled = yes\\n}\\n'
} > "$tmp"
validate() {
  namespaces=$(doveconf -f protocol=imap -h namespace) || return 1
  printf '%s\\n' "$namespaces" | awk '
    /^namespace [{]/ { disabled = ""; type = ""; inbox = "" }
    /^  disabled =/ { disabled = $3 }
    /^  type =/ { type = $3 }
    /^  inbox =/ { inbox = $3 }
    /^[}]/ {
      if (type != "private" && disabled != "yes") exit 1
      if (type == "private" && disabled == "no" && inbox == "yes") private_inbox = 1
    }
    END { if (!private_inbox) exit 1 }
  ' || return 1
  test "$(doveconf -f protocol=imap -h namespace/shared/disabled)" = yes || return 1
  plugins=$(doveconf -f protocol=imap -h mail_plugins) || return 1
  case " $plugins " in *" imap_acl "*) return 1 ;; esac
}
marker="$dir/.openship-shared-applied"
if ! cmp -s "$tmp" "$file"; then
  if [ -f "$file" ]; then cp -p "$file" "$work/previous"; fi
  rm -f "$marker"
  chmod 644 "$tmp"
  mv "$tmp" "$file"
  if ! validate; then
    if [ -f "$work/previous" ]; then mv "$work/previous" "$file"; else rm -f "$file"; fi
    echo "Shared IMAP requires a private inbox and disabled non-private namespaces" >&2
    exit 1
  fi
else
  validate
fi
if [ ! -f "$marker" ]; then
  doveadm reload
  # EX_NOUSER (68) also means every pre-policy session is gone.
  doveadm kick '*' || test "$?" -eq 68
  touch "$marker"
fi`;

export async function enforceSharedImap(serverId: string) {
  await createProvisionLock("mail:shared-imap:" + serverId).run(() =>
    runMailCommand(serverId, (flavor) => {
      if (flavor !== "container")
        throw new AppError("Shared IMAP requires a container mail engine.", 409);
      return mailEngineCommand(flavor, "sh -c " + shellQuote(sharedImapPolicy));
    }),
  );
}
