import type Dockerode from "dockerode";
import { S3Client, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { eventually, freePort } from "./scaling-lab";

/** An actual S3-compatible object store in the fixture's isolated network. */
export async function scalingBackupStore(
  create: (options: Dockerode.ContainerCreateOptions) => Promise<Dockerode.Container>,
  network: string,
) {
  const accessKeyId = "openship-scaling-test";
  const secretAccessKey = "disposable-scaling-backup-test-secret";
  const port = await freePort();
  const container = await create({
    Image:
      "versity/versitygw:v1.0.10@sha256:9078144b88346d96467afd05f8573d05ae661bd41e11e079c3472b9678d6ad6d",
    Env: [`ROOT_ACCESS_KEY=${accessKeyId}`, `ROOT_SECRET_KEY=${secretAccessKey}`],
    Cmd: ["--port", ":7070", "posix", "/data"],
    ExposedPorts: { "7070/tcp": {} },
    HostConfig: {
      Tmpfs: { "/data": "size=512m" },
      PortBindings: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] },
    },
  });
  const info = await container.inspect();
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  const bucket = "scaling-archives";
  await eventually(
    "the backup object store",
    async () => {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      return true;
    },
    Boolean,
    60_000,
  );
  return {
    endpoint: `http://${info.NetworkSettings.Networks[network].IPAddress}:7070`,
    localEndpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    client,
    keys: async () =>
      (await client.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents?.map(
        (object) => object.Key!,
      ) ?? [],
  };
}
