/**
 * "Which mail server is this screen about?" — one rule, so the rail, /emails and
 * the webmail resolver can't scope to different servers on the same click.
 *
 * The URL hint wins when it names a server we actually know about; a stale
 * `?serverId=` for a forgotten server must NOT scope anything, or every request
 * made under it 404s. With no usable hint: the only installed server (the common
 * single-box case), else the first row so a half-installed box is still reachable.
 */

export interface MailServerLike {
  id: string;
  completed: boolean;
}

export function pickActiveMailServer<T extends MailServerLike>(
  servers: T[],
  hintedServerId: string | null,
): T | null {
  const hinted = hintedServerId
    ? servers.find((s) => s.id === hintedServerId) ?? null
    : null;
  if (hinted) return hinted;
  const installed = servers.filter((s) => s.completed);
  return installed.length === 1 ? installed[0] : servers[0] ?? null;
}

/**
 * Should the screen ASK which server, instead of picking one?
 *
 * The rail has nowhere to ask — it must resolve to something, which is what
 * `pickActiveMailServer` is for. A page can ask, and where the answer decides
 * which mail domain's webmail you're about to open, guessing the first row is
 * worse than a one-click list.
 *
 * Only counts installed servers: a half-provisioned box has no webmail to reach,
 * so it never makes the choice ambiguous.
 */
export function needsMailServerChoice<T extends MailServerLike>(
  servers: T[],
  hintedServerId: string | null,
): boolean {
  if (hintedServerId && servers.some((s) => s.id === hintedServerId)) return false;
  return servers.filter((s) => s.completed).length > 1;
}
