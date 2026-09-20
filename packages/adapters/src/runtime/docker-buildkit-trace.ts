/**
 * Turn a BuildKit build's progress stream back into readable log lines.
 *
 * The Docker Engine's BuildKit builder (`POST /build?version=2`) does NOT emit the
 * classic builder's human-readable `{"stream":"Step 2/7 : RUN ..."}` events. It
 * emits `{"id":"moby.buildkit.trace","aux":"<base64 protobuf>"}` — a
 * `control.StatusResponse` — and expects the CLIENT to render it, which is what
 * `docker buildx` does. Without this decoder a BuildKit build over the Engine API
 * streams nothing at all: no step names, no `pip install` output, no failing
 * command. Errors would still surface (the daemon sends a final plain
 * `{"error":...}` event), but a ten-minute build would look like a hang.
 *
 * Only the two fields that carry the log are decoded — vertex names (the steps) and
 * vertex logs (the command output). Everything else is skipped by wire type, so a
 * BuildKit version that adds fields cannot break this.
 *
 * Hand-decoded from real daemon output rather than from a vendored `.proto`:
 *   StatusResponse { repeated Vertex vertexes = 1; repeated VertexLog logs = 3; }
 *   Vertex    { string digest = 1; string name = 3; bool cached = 4;
 *               Timestamp started = 5; Timestamp completed = 6; string error = 7; }
 *   VertexLog { string vertex = 1; Timestamp timestamp = 2; int64 stream = 3;
 *               bytes msg = 4; }
 *
 * Defensive by construction: a malformed or unexpected payload yields NO lines
 * rather than throwing, because this runs inside a live build's event handler.
 *
 * Why hand-rolled: the pinned dockerode (4.0.9) ships no BuildKit decoder at all, and
 * the build stream is consumed through `docker.modem.followProgress`, which has none
 * either. 4.0.12 added a protobufjs-based `decodeBuildKitStatus` behind
 * `Docker.prototype.followProgress` — if this repo ever moves onto that call, this
 * module becomes redundant and should be deleted rather than left as a second decoder.
 */

export interface BuildKitTraceLine {
  message: string;
  level: "info" | "error";
}

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

/** Minimal protobuf wire reader. Returns null from every accessor once the buffer
 *  is exhausted or malformed, so callers bail instead of looping forever. */
class WireReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Varint as a Number. Bails past 10 bytes (the protobuf maximum) so a corrupt
   *  buffer cannot spin. Values we actually read (`stream`, `cached`) are tiny. */
  varint(): number | null {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i += 1) {
      if (this.done) return null;
      const byte = this.buf[this.pos]!;
      this.pos += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    return null;
  }

  /** Field header → { field, wire }. */
  key(): { field: number; wire: number } | null {
    const tag = this.varint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    if (field <= 0) return null;
    return { field, wire: tag % 8 };
  }

  bytes(): Uint8Array | null {
    const length = this.varint();
    if (length === null || length < 0 || this.pos + length > this.buf.length) return null;
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  /** Advance past a field we don't read. Returns false when the buffer is
   *  malformed, which ends the scan. */
  skip(wire: number): boolean {
    switch (wire) {
      case WIRE_VARINT:
        return this.varint() !== null;
      case WIRE_64BIT:
        this.pos += 8;
        return this.pos <= this.buf.length;
      case WIRE_LENGTH:
        return this.bytes() !== null;
      case WIRE_32BIT:
        this.pos += 4;
        return this.pos <= this.buf.length;
      default:
        // Groups (3/4) are long removed from protobuf and BuildKit emits none;
        // an unknown wire type means the payload is not what we think it is.
        return false;
    }
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

interface TraceVertex {
  digest: string;
  name: string;
  cached: boolean;
  started: boolean;
  completed: boolean;
  error: string;
}

interface TraceLog {
  vertex: string;
  stream: number;
  msg: string;
}

function decodeVertex(bytes: Uint8Array): TraceVertex | null {
  const reader = new WireReader(bytes);
  const vertex: TraceVertex = {
    digest: "",
    name: "",
    cached: false,
    started: false,
    completed: false,
    error: "",
  };

  while (!reader.done) {
    const key = reader.key();
    if (!key) return null;
    if (key.field === 1 && key.wire === WIRE_LENGTH) {
      const value = reader.bytes();
      if (!value) return null;
      vertex.digest = text(value);
    } else if (key.field === 3 && key.wire === WIRE_LENGTH) {
      const value = reader.bytes();
      if (!value) return null;
      vertex.name = text(value);
    } else if (key.field === 4 && key.wire === WIRE_VARINT) {
      const value = reader.varint();
      if (value === null) return null;
      vertex.cached = value !== 0;
    } else if (key.field === 5 && key.wire === WIRE_LENGTH) {
      if (!reader.bytes()) return null;
      vertex.started = true;
    } else if (key.field === 6 && key.wire === WIRE_LENGTH) {
      if (!reader.bytes()) return null;
      vertex.completed = true;
    } else if (key.field === 7 && key.wire === WIRE_LENGTH) {
      const value = reader.bytes();
      if (!value) return null;
      vertex.error = text(value);
    } else if (!reader.skip(key.wire)) {
      return null;
    }
  }

  return vertex;
}

function decodeLog(bytes: Uint8Array): TraceLog | null {
  const reader = new WireReader(bytes);
  let vertex = "";
  let stream = 0;
  let msg: Uint8Array | null = null;

  while (!reader.done) {
    const key = reader.key();
    if (!key) return null;
    if (key.field === 1 && key.wire === WIRE_LENGTH) {
      const value = reader.bytes();
      if (!value) return null;
      vertex = text(value);
    } else if (key.field === 3 && key.wire === WIRE_VARINT) {
      const value = reader.varint();
      if (value === null) return null;
      stream = value;
    } else if (key.field === 4 && key.wire === WIRE_LENGTH) {
      const value = reader.bytes();
      if (!value) return null;
      msg = value;
    } else if (!reader.skip(key.wire)) {
      return null;
    }
  }

  // Structural sanity check, not decoration: a VertexLog always names its vertex by
  // digest. If field 1 isn't one, the field numbers above don't describe what the
  // daemon actually sent, and emitting `msg` would print binary noise into the build
  // log. Dropping it degrades to "no per-command output", never to garbage.
  if (!vertex.startsWith("sha256:") || !msg?.length) return null;

  return { vertex, stream, msg: text(msg) };
}

/**
 * Stateful renderer for one build's trace stream. Vertices are numbered in the
 * order they first appear (`#1`, `#2`, …) so a log line can be tied back to the
 * step that produced it, the way `docker build --progress=plain` does.
 */
export class BuildKitTraceDecoder {
  private readonly numbers = new Map<string, number>();
  private readonly announced = new Set<string>();
  private readonly settled = new Set<string>();

  /** Decode one `aux` payload into the lines it should add to the build log. */
  push(
    auxBase64: string,
    onOutput?: (data: string, streamId: string) => void,
  ): BuildKitTraceLine[] {
    let payload: Uint8Array;
    try {
      payload = Uint8Array.from(Buffer.from(auxBase64, "base64"));
    } catch {
      return [];
    }
    if (payload.length === 0) return [];

    const lines: BuildKitTraceLine[] = [];
    const reader = new WireReader(payload);

    while (!reader.done) {
      const key = reader.key();
      if (!key) break;

      if (key.field === 1 && key.wire === WIRE_LENGTH) {
        const bytes = reader.bytes();
        if (!bytes) break;
        const vertex = decodeVertex(bytes);
        if (vertex) lines.push(...this.renderVertex(vertex));
        continue;
      }

      if (key.field === 3 && key.wire === WIRE_LENGTH) {
        const bytes = reader.bytes();
        if (!bytes) break;
        const entry = decodeLog(bytes);
        if (entry) {
          // Preserve fragment boundaries and stdout/stderr identity before the
          // renderer splits lines or adds step prefixes.
          onOutput?.(entry.msg, `${entry.vertex}:${entry.stream}`);
          lines.push(...this.renderLog(entry));
        }
        continue;
      }

      if (!reader.skip(key.wire)) break;
    }

    return lines;
  }

  private numberFor(digest: string): number {
    const existing = this.numbers.get(digest);
    if (existing !== undefined) return existing;
    const next = this.numbers.size + 1;
    this.numbers.set(digest, next);
    return next;
  }

  private renderVertex(vertex: TraceVertex): BuildKitTraceLine[] {
    if (!vertex.digest) return [];
    const number = this.numberFor(vertex.digest);
    const lines: BuildKitTraceLine[] = [];

    // The daemon re-sends a vertex on every state change, so each transition is
    // emitted at most once — otherwise a long step would repeat its own header
    // dozens of times.
    if (vertex.name && !this.announced.has(vertex.digest)) {
      this.announced.add(vertex.digest);
      lines.push({ message: `#${number} ${vertex.name}`, level: "info" });
    }

    if ((vertex.completed || vertex.error) && !this.settled.has(vertex.digest)) {
      this.settled.add(vertex.digest);
      if (vertex.error) {
        lines.push({ message: `#${number} ERROR: ${vertex.error}`, level: "error" });
      } else if (vertex.cached) {
        lines.push({ message: `#${number} CACHED`, level: "info" });
      } else {
        lines.push({ message: `#${number} DONE`, level: "info" });
      }
    }

    return lines;
  }

  private renderLog(entry: TraceLog): BuildKitTraceLine[] {
    const number = this.numberFor(entry.vertex);
    return entry.msg
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ message: `#${number} ${line}`, level: "info" as const }));
  }
}

/**
 * Does this Dockerfile need BuildKit to build at all?
 *
 * The Engine API's classic builder rejects modern Dockerfile syntax outright
 * (`the --mount option requires BuildKit`), so this is the gate for opting a build
 * onto BuildKit — narrowly, only where the classic builder is guaranteed to fail.
 * Every construct listed here is BuildKit-only:
 *
 *   - a `# syntax=` directive (selects a BuildKit frontend)
 *   - `RUN --mount=` / `--network=` / `--security=`
 *   - `COPY|ADD --link` / `ADD --checksum=` / `--keep-git-dir=` / `COPY --from` with
 *     a named additional context is NOT included: plain `--from` predates BuildKit
 *   - heredoc bodies (`RUN <<EOF`)
 *
 * A false negative just reproduces today's failure, so the list errs toward NOT
 * claiming BuildKit is needed.
 */
export function dockerfileNeedsBuildKit(contents: string): boolean {
  // Comments can carry example commands; the syntax directive is the one comment
  // that counts, and it is only a directive near the top of the file.
  if (/^\s*#\s*syntax\s*=/im.test(contents.slice(0, 4096))) return true;

  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;

    // Only the flags BETWEEN the instruction and its command count. A BuildKit flag
    // must sit there, so `RUN echo --mount=type=cache` — the string as an argument —
    // is not a BuildKit Dockerfile and must not be treated as one.
    const match = /^\s*(RUN|COPY|ADD)((?:\s+--[^\s]+)*)/i.exec(line);
    if (!match) continue;
    const flags = match[2] ?? "";

    if (/--(mount|network|security)\b/i.test(flags)) return true;
    if (/--(link|checksum|keep-git-dir)\b/i.test(flags)) return true;
    // Heredoc body (`RUN <<EOF`). The marker must be its own token, or a command
    // that merely contains "<<" (a shell here-string, a C++ stream) would match.
    if (/(?:^|\s)<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?(?:\s|$)/.test(line)) return true;
  }

  return false;
}
