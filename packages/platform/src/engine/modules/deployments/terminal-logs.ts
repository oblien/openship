import { StringDecoder } from "node:string_decoder";
import type { LogEntry } from "@repo/adapters";

/** Save complete terminal lines. Raw executor chunks can end inside a line,
 * CRLF or UTF-8 character; plain logger entries are already discrete lines. */
export function collapseTerminalLogs(entries: LogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];
  type StreamState = {
    line: string;
    carriageReturn: boolean;
    decoder: StringDecoder;
    entry: LogEntry;
  };
  // Parallel Compose builds share this log list, but not their terminal buffers.
  const streams = new Map<string, StreamState>();
  const key = (entry: LogEntry) => entry.serviceId ? `id:${entry.serviceId}`
    : entry.serviceName ? `name:${entry.serviceName}` : "project";

  const flushLine = (state: StreamState) => {
    const message = state.line.trimEnd();
    if (message) result.push({
      timestamp: state.entry.timestamp, message, level: state.entry.level,
      serviceName: state.entry.serviceName, serviceId: state.entry.serviceId,
      ...(state.entry.resourceIssue ? { resourceIssue: state.entry.resourceIssue } : {}),
    });
    state.line = "";
    state.carriageReturn = false;
  };
  const write = (state: StreamState, text: string) => {
    for (const char of text) {
      if (state.carriageReturn) {
        state.carriageReturn = false;
        if (char === "\n") {
          flushLine(state);
          continue;
        }
        state.line = "";
      }
      if (char === "\r") state.carriageReturn = true;
      else if (char === "\n") flushLine(state);
      else state.line += char;
    }
  };
  const finish = (state: StreamState) => {
    write(state, state.decoder.end());
    flushLine(state);
    state.decoder = new StringDecoder("utf8");
  };

  for (const entry of entries) {
    if (entry.step) {
      // A phase boundary ends its stream; service-local steps do not split
      // another service's in-flight output.
      if (entry.serviceId || entry.serviceName) {
        const state = streams.get(key(entry));
        if (state) finish(state);
      } else {
        for (const state of streams.values()) finish(state);
      }
      result.push(entry);
      continue;
    }
    let state = streams.get(key(entry));
    if (!state) {
      state = { line: "", carriageReturn: false, decoder: new StringDecoder("utf8"), entry };
      streams.set(key(entry), state);
    }
    if (entry.rawData !== undefined) {
      state.entry = entry;
      write(state, state.decoder.write(Buffer.from(entry.rawData, "base64")));
    } else {
      // A structured message following a stream must start on its own line.
      finish(state);
      state.entry = entry;
      write(state, entry.message);
      flushLine(state);
    }
  }
  for (const state of streams.values()) finish(state);
  return result;
}
