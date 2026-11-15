/** ManageSieve uses the signed-in mailbox's own credentials, with mandatory TLS.
 * Server filtering continues when the browser and webmail server are closed. */
import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { env } from "../env";
import type { ImapAuth } from "./imap";

export type SieveResponse = { lines: string[]; literals: string[]; ok: boolean };
const MAX_RESPONSE = 1024 * 1024;
export function quoteSieve(value: string) {
  if (/[\r\n\x00]/.test(value)) throw new Error("Invalid Sieve string");
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Literal contents may contain newlines and OK/NO: only frame boundaries are status lines. */
export function readSieveResponse(socket: Socket): Promise<SieveResponse> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0),
      total = 0,
      literal: number | null = null;
    const lines: string[] = [],
      literals: string[] = [];
    const timer = setTimeout(() => fail(new Error("Mail filter server timed out")), 10_000);
    function clean() {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("error", fail);
      socket.off("close", closed);
    }
    function fail(error: Error) {
      clean();
      reject(error);
    }
    function closed() {
      fail(new Error("Mail filter server disconnected"));
    }
    function data(chunk: Buffer) {
      total += chunk.length;
      if (total > MAX_RESPONSE) return fail(new Error("Mail filter response is too large"));
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literal !== null) {
          if (buffer.length < literal + 2) return;
          if (buffer.subarray(literal, literal + 2).toString() !== "\r\n")
            return fail(new Error("Invalid mail filter response"));
          literals.push(buffer.subarray(0, literal).toString("utf8"));
          buffer = buffer.subarray(literal + 2);
          literal = null;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        if (/^(OK|NO|BYE)(?:[ (]|$)/i.test(line)) {
          clean();
          resolve({ lines, literals, ok: /^OK(?:[ (]|$)/i.test(line) });
          return;
        }
        const match = line.match(/^\{(\d+)\+?\}$/);
        if (match) {
          literal = Number(match[1]);
          if (literal > MAX_RESPONSE) return fail(new Error("Mail filter script is too large"));
        } else lines.push(line);
      }
    }
    socket.on("data", data);
    socket.once("error", fail);
    socket.once("close", closed);
  });
}

export async function withSieve<T>(
  auth: ImapAuth,
  work: (command: (text: string) => Promise<SieveResponse>) => Promise<T>,
): Promise<T> {
  const host = env.DEFAULT_SIEVE_HOST || auth.host;
  let socket: Socket | TLSSocket = net.connect({ host, port: env.DEFAULT_SIEVE_PORT });
  // Never let an idle/late socket error escape after a response has removed its listener.
  socket.on("error", () => {});
  const execute = async (text?: string) => {
    const result = readSieveResponse(socket);
    if (text !== undefined) socket.write(text + "\r\n");
    return result;
  };
  const command = async (text: string) => {
    const result = await execute(text);
    if (!result.ok) throw new Error("The mail server could not update the sender filter");
    return result;
  };
  try {
    const greeting = await execute();
    if (!greeting.ok || !greeting.lines.some((line) => /^"STARTTLS"/.test(line)))
      throw new Error("The mail server must support secure ManageSieve");
    await command("STARTTLS");
    socket = tls.connect({
      socket,
      servername: net.isIP(host) ? undefined : host,
      host,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    socket.on("error", () => {});
    const capabilities = await execute();
    if (
      !capabilities.ok ||
      !capabilities.lines.some((line) => /^"SASL".*\bPLAIN\b/i.test(line)) ||
      !capabilities.lines.some((line) =>
        /^"SIEVE".*\bfileinto\b.*\binclude\b|^"SIEVE".*\binclude\b.*\bfileinto\b/i.test(line),
      )
    )
      throw new Error("The mail server does not support secure sender filtering");
    const credential = Buffer.from(`\0${auth.user}\0${auth.pass}`).toString("base64");
    await command(`AUTHENTICATE "PLAIN" ${quoteSieve(credential)}`);
    return await work(command);
  } finally {
    socket.destroy();
  }
}
