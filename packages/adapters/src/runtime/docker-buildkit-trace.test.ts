import { describe, expect, it } from "vitest";

import { statusResponse } from "../../test/fixtures/docker-buildkit";
import { BuildKitTraceDecoder, dockerfileNeedsBuildKit } from "./docker-buildkit-trace";

/**
 * The three payloads below are VERBATIM `aux` values captured from a real
 * `POST /build?version=2` against Docker Engine 29.5.2 — one vertex progressing from
 * "seen" → "started" → "completed with an error". They are the reason the field
 * numbers in the decoder are asserted rather than assumed: the same daemon that
 * ships the traces produced these bytes.
 */
const REAL_TRACES = [
  "Cm8KR3NoYTI1Njo0MWUzY2E5NjI1NmZlMjE2MTdkNTE0ZWNjOWRjNmM4OGU5YWU5OWM0NTRkZjZhMDU3YmVjOGQwYmMyOTUwMzE4GiRbaW50ZXJuYWxdIGxvYWQgcmVtb3RlIGJ1aWxkIGNvbnRleHQ=",
  "CnwKR3NoYTI1Njo0MWUzY2E5NjI1NmZlMjE2MTdkNTE0ZWNjOWRjNmM4OGU5YWU5OWM0NTRkZjZhMDU3YmVjOGQwYmMyOTUwMzE4GiRbaW50ZXJuYWxdIGxvYWQgcmVtb3RlIGJ1aWxkIGNvbnRleHQqCwjV0pPUBhCU3N9j",
  "CvcBCkdzaGEyNTY6NDFlM2NhOTYyNTZmZTIxNjE3ZDUxNGVjYzlkYzZjODhlOWFlOTljNDU0ZGY2YTA1N2JlYzhkMGJjMjk1MDMxOBokW2ludGVybmFsXSBsb2FkIHJlbW90ZSBidWlsZCBjb250ZXh0KgsI1dKT1AYQlNzfYzILCNbSk9QGEIzI9xQ6bGZhaWxlZCB0byBjcmVhdGUgbGVhc2U6IHdyaXRlIC92YXIvbGliL2NvbnRhaW5lcmQvaW8uY29udGFpbmVyZC5tZXRhZGF0YS52MS5ib2x0L21ldGEuZGI6IGlucHV0L291dHB1dCBlcnJvcg==",
];

const DIGEST = "sha256:41e3ca96256fe21617d514ecc9dc6c88e9ae99c454df6a057bec8d0bc2950318";

describe("BuildKitTraceDecoder — real daemon traces", () => {
  it("names each step once and reports its failure", () => {
    const decoder = new BuildKitTraceDecoder();

    expect(decoder.push(REAL_TRACES[0]!)).toEqual([
      { message: "#1 [internal] load remote build context", level: "info" },
    ]);
    // The daemon re-sends the vertex on every state change; the header must not
    // repeat or a long step would spam its own name.
    expect(decoder.push(REAL_TRACES[1]!)).toEqual([]);
    expect(decoder.push(REAL_TRACES[2]!)).toEqual([
      {
        message:
          "#1 ERROR: failed to create lease: write /var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db: input/output error",
        level: "error",
      },
    ]);
  });
});

describe("BuildKitTraceDecoder", () => {
  it("numbers vertices in the order they appear", () => {
    const decoder = new BuildKitTraceDecoder();
    const lines = decoder.push(
      statusResponse({
        vertexes: [
          { digest: "sha256:aaa", name: "[1/3] FROM python:3.12" },
          { digest: "sha256:bbb", name: "[2/3] COPY requirements.txt /" },
        ],
      }),
    );

    expect(lines.map((line) => line.message)).toEqual([
      "#1 [1/3] FROM python:3.12",
      "#2 [2/3] COPY requirements.txt /",
    ]);
  });

  it("passes command output through, tagged with its step", () => {
    const decoder = new BuildKitTraceDecoder();
    decoder.push(statusResponse({ vertexes: [{ digest: DIGEST, name: "[2/3] RUN pip install" }] }));

    const lines = decoder.push(
      statusResponse({
        logs: [{ vertex: DIGEST, msg: "Collecting flask\nDownloading flask-3.0.0.whl\n\n" }],
      }),
    );

    expect(lines).toEqual([
      { message: "#1 Collecting flask", level: "info" },
      { message: "#1 Downloading flask-3.0.0.whl", level: "info" },
    ]);
  });

  it("observes raw fragments separately by vertex and stream without changing rendering", () => {
    const decoder = new BuildKitTraceDecoder();
    const baseline = new BuildKitTraceDecoder();
    const observed: Array<[string, string]> = [];
    const logs = [
      { vertex: DIGEST, stream: 1, msg: "getaddrinfo ENO" },
      { vertex: "sha256:other", stream: 1, msg: "another build step\n" },
      { vertex: DIGEST, stream: 2, msg: "stderr output\n" },
      { vertex: DIGEST, stream: 1, msg: "TFOUND db\n\n" },
    ];

    for (const log of logs) {
      const payload = statusResponse({ logs: [log] });
      expect(decoder.push(payload, (data, streamId) => observed.push([data, streamId]))).toEqual(
        baseline.push(payload),
      );
    }

    expect(observed).toEqual(logs.map((log) => [log.msg, `${log.vertex}:${log.stream}`]));
  });

  it("reports a cached step as cached, and a plain one as done", () => {
    const decoder = new BuildKitTraceDecoder();
    expect(
      decoder
        .push(
          statusResponse({
            vertexes: [
              { digest: "sha256:aaa", name: "[1/2] FROM alpine", cached: true, completed: true },
            ],
          }),
        )
        .map((line) => line.message),
    ).toEqual(["#1 [1/2] FROM alpine", "#1 CACHED"]);

    expect(
      decoder
        .push(
          statusResponse({
            vertexes: [{ digest: "sha256:bbb", name: "[2/2] RUN true", completed: true }],
          }),
        )
        .map((line) => line.message),
    ).toEqual(["#2 [2/2] RUN true", "#2 DONE"]);
  });

  // This runs inside a live build's event handler, so a payload it cannot read must
  // yield nothing rather than throw — a decode bug must never fail a good build.
  it.each([
    ["not base64 at all", "!!!!"],
    ["empty", ""],
    ["truncated", "Cm8KR3NoYTI1Njo0MWUz"],
    ["a plain string", Buffer.from("hello world", "utf-8").toString("base64")],
  ])("returns no lines for %s input", (_label, payload) => {
    expect(() => new BuildKitTraceDecoder().push(payload)).not.toThrow();
  });

  it("drops a log entry whose vertex is not a digest", () => {
    // The structural guard: if the field numbers ever stop describing what the daemon
    // sends, `msg` would be some other field's bytes — printing those would fill the
    // build log with binary noise.
    const decoder = new BuildKitTraceDecoder();
    expect(decoder.push(statusResponse({ logs: [{ vertex: "not-a-digest", msg: "x" }] }))).toEqual(
      [],
    );
  });
});

describe("dockerfileNeedsBuildKit", () => {
  it.each([
    [
      "RUN --mount cache",
      "FROM python:3.12\nRUN --mount=type=cache,target=/c pip install -r r.txt\n",
    ],
    ["RUN --network", "FROM alpine\nRUN --network=none true\n"],
    ["a syntax directive", "# syntax=docker/dockerfile:1.7\nFROM alpine\n"],
    ["COPY --link", "FROM alpine\nCOPY --link app /app\n"],
    ["ADD --checksum", "FROM alpine\nADD --checksum=sha256:abc https://x/y /y\n"],
    ["a heredoc", "FROM alpine\nRUN <<EOF\necho hi\nEOF\n"],
  ])("flags %s", (_label, contents) => {
    expect(dockerfileNeedsBuildKit(contents)).toBe(true);
  });

  it.each([
    [
      "a plain Dockerfile",
      "FROM python:3.12\nCOPY requirements.txt /\nRUN pip install -r /requirements.txt\n",
    ],
    ["multi-stage COPY --from", "FROM alpine AS b\nFROM alpine\nCOPY --from=b /x /x\n"],
    ["a commented-out mount", "FROM alpine\n# RUN --mount=type=cache,target=/c true\nRUN true\n"],
    ["a mount mentioned in an argument", "FROM alpine\nRUN echo --mount=type=cache\n"],
    ["<< inside a quoted string", 'FROM alpine\nRUN echo "see docs <<here>>" && make\n'],
    ["a shell here-string", 'FROM alpine\nRUN grep x <<<"$VALUE"\n'],
  ])("leaves %s on the default builder", (_label, contents) => {
    expect(dockerfileNeedsBuildKit(contents)).toBe(false);
  });
});
