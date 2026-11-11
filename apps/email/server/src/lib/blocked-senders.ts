import { z } from "zod";
import type { ImapAuth } from "./imap";
import { quoteSieve, withSieve, type SieveResponse } from "./sieve";

const NAME = "openship-sender-blocks";
const MARKER = "# Openship sender blocks: ";
const metadata = z.object({ senders: z.array(z.email()).max(500), previous: z.string().max(256) });
const locks = new Map<string, Promise<unknown>>();

export function readBlockScript(script: string) {
  const first = script.split("\n", 1)[0];
  if (!first?.startsWith(MARKER))
    throw new Error("The sender filter was modified outside Openship; no changes were made");
  const result = metadata.parse(JSON.parse(first.slice(MARKER.length)));
  if (result.previous === NAME) throw new Error("Invalid sender filter chain");
  return result;
}
export function buildBlockScript(senders: string[], previous: string): string {
  const input = metadata.parse({ senders, previous });
  if (previous === NAME) throw new Error("Invalid sender filter chain");
  const quoted = input.senders.map(quoteSieve).join(", ");
  return (
    MARKER +
    JSON.stringify(input) +
    "\n" +
    'require ["fileinto", "include"];\n' +
    (senders.length ? `if address :is "from" [${quoted}] { fileinto "Junk"; stop; }\n` : "") +
    (previous ? `include :personal ${quoteSieve(previous)};\n` : "")
  );
}
function activeScript(response: SieveResponse) {
  const active = response.lines.find((line) => / ACTIVE$/.test(line));
  if (!active) return "";
  const match = active.match(/^"((?:[^"\\]|\\.)*)" ACTIVE$/);
  if (!match) throw new Error("The mail server returned an unsupported script name");
  return match[1]!.replace(/\\([\\"])/g, "$1");
}
async function read(command: (text: string) => Promise<SieveResponse>) {
  const scripts = await command("LISTSCRIPTS");
  const active = activeScript(scripts);
  const exists = scripts.lines.some(
    (line) => line === quoteSieve(NAME) || line === `${quoteSieve(NAME)} ACTIVE`,
  );
  const saved = exists
    ? readBlockScript((await command(`GETSCRIPT ${quoteSieve(NAME)}`)).literals[0] ?? "")
    : { senders: [], previous: "" };
  return { ...saved, active };
}
export async function listBlockedSenders(auth: ImapAuth) {
  return withSieve(auth, async (command) => {
    const state = await read(command);
    return { senders: state.senders, active: state.active === NAME };
  });
}

/** Serialize mailbox filter edits. The Sieve script is the single source of truth.
 * Existing personal scripts are included unchanged and restored after the last unblock. */
export async function setSenderBlocked(auth: ImapAuth, email: string, blocked: boolean) {
  const sender = z.email().parse(email.trim().toLowerCase());
  const key = `${auth.host}:${auth.port}:${auth.user.toLowerCase()}`;
  const task = (locks.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      withSieve(auth, async (command) => {
        const state = await read(command);
        const senders = [
          ...new Set(
            blocked
              ? [...state.senders, sender]
              : state.senders.filter((value) => value !== sender),
          ),
        ].sort();
        const previous = state.active === NAME ? state.previous : state.active;
        if (!senders.length) {
          if (state.active === NAME) await command(`SETACTIVE ${quoteSieve(previous)}`);
        }
        const script = buildBlockScript(senders, previous);
        await command(`PUTSCRIPT ${quoteSieve(NAME)} {${Buffer.byteLength(script)}+}\r\n${script}`);
        if (senders.length) await command(`SETACTIVE ${quoteSieve(NAME)}`);
        return { senders, active: senders.length > 0 };
      }),
    );
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) locks.delete(key);
  }
}
