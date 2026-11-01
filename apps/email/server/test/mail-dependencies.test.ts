import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

test("the shipped mail composer and parser preserve Unicode and attachment bytes", async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  try {
    const sent = await transport.sendMail({
      from: "Sender <sender@example.test>",
      to: "recipient@example.test",
      subject: "A message — رسالة",
      text: "Hello from the mail compatibility test.",
      attachments: [{ filename: "sample.bin", content: bytes }],
    });
    const parsed = await simpleParser(sent.message);
    expect(parsed.subject).toBe("A message — رسالة");
    expect(parsed.from?.value[0]?.address).toBe("sender@example.test");
    expect(parsed.text?.trim()).toBe("Hello from the mail compatibility test.");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("sample.bin");
    expect(parsed.attachments[0]?.content).toEqual(bytes);
  } finally {
    transport.close();
  }
});

test("the existing IMAP client can use the patched Nodemailer HTTP proxy helper", async () => {
  // ImapFlow 1.x uses this CJS callback helper internally. Exercise that real
  // import and handshake so the nested dependency override cannot break it.
  const require = createRequire(import.meta.url);
  const { proxyConnection } = require("imapflow/lib/proxy-connection");
  let authority = "";
  let authorization: string | undefined;
  const sockets = new Set<Socket>();
  const proxy = createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket) => {
    authority = request.url ?? "";
    authorization = request.headers["proxy-authorization"];
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  let connection: Socket | undefined;
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    connection = await proxyConnection(
      { info() {}, error() {} },
      `http://fixture:password@127.0.0.1:${address.port}`,
      "127.0.0.1",
      993,
    );
    expect(connection?.destroyed).toBe(false);
    expect(authority).toBe("127.0.0.1:993");
    expect(authorization).toBe(`Basic ${Buffer.from("fixture:password").toString("base64")}`);
  } finally {
    connection?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
