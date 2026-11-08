import { StringDecoder } from "node:string_decoder";
import { BUILD_ENV_VARS } from "@repo/core";
import { SecretValues } from "@repo/core/diagnostics";
import type { BuildConfig, LogCallback, LogEntry } from "../types";

export function buildSecretValues(
  config: Pick<BuildConfig, "envVars" | "buildArgs" | "gitToken" | "gitSsh">,
): string[] {
  return [
    ...Object.entries(config.envVars)
      .filter(([key, value]) => BUILD_ENV_VARS[key] !== value)
      .map(([, value]) => value),
    ...Object.values(config.buildArgs ?? {}),
    config.gitToken ?? "",
    config.gitSsh?.privateKey ?? "",
  ];
}

/** One boundary for all BuildLogger consumers, including base64 terminal data. */
export class BuildLogRedactor<Step extends string> {
  private values = new Set<string>();
  private secrets = new SecretValues([]);
  private outputStreams = new Map<
    string,
    {
      filter: ReturnType<SecretValues["stream"]>;
      decoder: StringDecoder;
      onFlush?: (message: string) => void;
    }
  >();
  private streams = new Map<
    string,
    {
      decoder: StringDecoder;
      filter: ReturnType<SecretValues["stream"]>;
      entry: LogEntry<Step>;
    }
  >();

  constructor(private readonly emit?: LogCallback<Step>) {}

  protect(values: readonly string[]): void {
    const added = values.filter((value) => value && !this.values.has(value));
    if (!added.length) return;
    this.flush();
    added.forEach((value) => this.values.add(value));
    this.secrets = new SecretValues([...this.values]);
  }

  text(value: string): string {
    return this.secrets.redact(value);
  }

  output(data: Uint8Array, streamId: string, onFlush?: (message: string) => void): string {
    let stream = this.outputStreams.get(streamId);
    if (!stream) {
      stream = { filter: this.secrets.stream(), decoder: new StringDecoder("utf8"), onFlush };
      this.outputStreams.set(streamId, stream);
    }
    return stream.filter.write(stream.decoder.write(Buffer.from(data)));
  }

  write(entry: LogEntry<Step>): void {
    if (!entry.rawData || this.secrets.empty) {
      this.emit?.({ ...entry, message: this.text(entry.message) });
      return;
    }
    // Separate stdout/stderr and Compose services. Never join two tenants or
    // interpret arbitrary UTF-8 transport boundaries as message boundaries.
    const key = `${entry.serviceId ?? entry.serviceName ?? ""}:${entry.level}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { decoder: new StringDecoder("utf8"), filter: this.secrets.stream(), entry };
      this.streams.set(key, stream);
    }
    stream.entry = entry;
    const message = stream.filter.write(stream.decoder.write(Buffer.from(entry.rawData, "base64")));
    if (message)
      this.emit?.({ ...entry, message, rawData: Buffer.from(message).toString("base64") });
  }

  flush(): void {
    for (const { decoder, filter, entry } of this.streams.values()) {
      const message = filter.write(decoder.end()) + filter.end();
      if (message)
        this.emit?.({ ...entry, message, rawData: Buffer.from(message).toString("base64") });
    }
    this.streams.clear();
    for (const stream of this.outputStreams.values()) {
      const message = stream.filter.write(stream.decoder.end()) + stream.filter.end();
      if (message) {
        if (stream.onFlush) stream.onFlush(message);
        else this.emit?.({ timestamp: new Date().toISOString(), message, level: "info" });
      }
    }
    this.outputStreams.clear();
  }
}
