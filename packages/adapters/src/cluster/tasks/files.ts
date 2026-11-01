import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { ArchiveFile } from "./types";

export class TaskArchiveStore {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  constructor(
    destinationPath: string,
    readonly signal: AbortSignal,
    credentials = {
      endpoint: process.env.BACKUP_ENDPOINT,
      region: process.env.BACKUP_REGION || "us-east-1",
      accessKeyId: process.env.BACKUP_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BACKUP_SECRET_ACCESS_KEY!,
    },
  ) {
    const destination = new URL(destinationPath);
    if (
      destination.protocol !== "s3:" ||
      !destination.hostname ||
      destination.search ||
      destination.hash
    )
      throw new Error("Invalid saved backup location.");
    this.bucket = destination.hostname;
    this.prefix = destination.pathname.replace(/^\/+|\/+$/g, "");
    this.client = new S3Client({
      endpoint: credentials.endpoint || undefined,
      region: credentials.region,
      forcePathStyle: true,
      credentials,
      maxAttempts: 3,
    });
  }
  private check(key: string) {
    if (
      (this.prefix && !key.startsWith(`${this.prefix}/`)) ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("An archive object is outside its approved destination.");
  }
  async relativeGet(key: string): Promise<Readable> {
    if (!key || key.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error("Invalid backup object identity.");
    const full = this.prefix ? `${this.prefix}/${key}` : key;
    this.check(full);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: full }),
      { abortSignal: this.signal },
    );
    return response.Body as Readable;
  }
  async json<T>(key: string): Promise<T | null> {
    this.check(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: this.signal },
      );
      let body = Buffer.alloc(0);
      for await (const chunk of response.Body as Readable) {
        body = Buffer.concat([body, Buffer.from(chunk)]);
        if (body.length > 1024 * 1024)
          throw new Error("The archive manifest exceeds its size limit.");
      }
      return JSON.parse(body.toString()) as T;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw error;
    }
  }
  async commit(key: string, manifest: unknown) {
    this.check(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(manifest),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
      { abortSignal: this.signal },
    );
  }
  async upload(key: string, path: string): Promise<ArchiveFile> {
    this.check(key);
    const sizeBytes = (await stat(path)).size;
    const hash = createHash("sha256");
    const source = createReadStream(path);
    source.on("data", (chunk) => hash.update(chunk));
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: source, ContentLength: sizeBytes },
      queueSize: 2,
      leavePartsOnError: false,
    });
    const abort = () => {
      source.destroy();
      void upload.abort();
    };
    this.signal.addEventListener("abort", abort, { once: true });
    try {
      this.signal.throwIfAborted();
      await upload.done();
      return { key, sizeBytes, sha256: hash.digest("hex") };
    } finally {
      this.signal.removeEventListener("abort", abort);
      source.destroy();
    }
  }
  async download(file: ArchiveFile, path: string) {
    this.check(file.key);
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("The archive has no valid integrity metadata.");
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: file.key }),
      { abortSignal: this.signal },
    );
    if (response.ContentLength !== file.sizeBytes)
      throw new Error("The saved archive size changed. Recovery stopped before loading data.");
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      response.Body as Readable,
      new Transform({
        transform(chunk, _encoding, next) {
          bytes += chunk.length;
          if (bytes > file.sizeBytes) return next(new Error("The archive exceeds its saved size."));
          hash.update(chunk);
          next(null, chunk);
        },
      }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal: this.signal },
    );
    if (bytes !== file.sizeBytes || hash.digest("hex") !== file.sha256)
      throw new Error("The archive checksum did not match. Recovery stopped before loading data.");
  }
  async remove(key: string) {
    this.check(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: this.signal,
    });
  }
  async removeArchive(prefix: string) {
    this.check(`${prefix}/manifest.json`);
    // Only a named, claimed archive is eligible. Never accept a namespace root.
    if (
      !prefix.startsWith(`${this.prefix}/os-db-`) ||
      !/\/(?:redis|postgres)\/[a-z0-9-]+$/.test(prefix)
    )
      throw new Error("Invalid archive cleanup scope.");
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
        { abortSignal: this.signal },
      );
      for (const object of page.Contents ?? []) if (object.Key) await this.remove(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token)
        throw new Error("Archive cleanup returned an incomplete page.");
    } while (token);
  }
}
