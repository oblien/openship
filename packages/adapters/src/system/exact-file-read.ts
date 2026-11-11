import { sq } from "./local-shell";

/**
 * Read a file's bytes through `exec` without losing any of them.
 *
 * Every executor resolves command output with `stdout.trim()`, which is right for
 * command parsers and wrong for file content: a vhost read through `cat` came back
 * without its trailing newline, so it never compared equal to the bytes we were about
 * to write, and a rollback that restored such a snapshot wrote the truncated text back.
 *
 * Framing the payload between two non-whitespace markers makes the trim a no-op on the
 * file itself. The closing marker is printed only after `cat` succeeds, so a read that
 * fails part-way can never be mistaken for a short file. Anything a login shell prints
 * before the opening marker is ignored rather than mistaken for content.
 */
const OPEN = "<openship-file>";
const CLOSE = "</openship-file>";

/** Shell command that prints `path` framed for {@link unframeFileRead}. */
export function framedCatCommand(path: string): string {
  return `printf '%s' ${sq(OPEN)} && cat ${sq(path)} && printf '%s' ${sq(CLOSE)}`;
}

/** Recover the exact file content from {@link framedCatCommand}'s output. */
export function unframeFileRead(output: string, path: string): string {
  const start = output.indexOf(OPEN);
  if (start < 0 || !output.endsWith(CLOSE) || output.length - start < OPEN.length + CLOSE.length) {
    throw new Error(`Incomplete read of ${path}: the output was not framed`);
  }
  return output.slice(start + OPEN.length, output.length - CLOSE.length);
}
