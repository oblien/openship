import { createServer } from "node:net";

// Choose a port on the client host too: a Docker VM's automatic allocation can
// collide with an existing local listener when the VM forwards that port.
const ports = new Set<number>();
export async function freePort(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as { port: number }).port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  if (ports.has(port)) return freePort();
  ports.add(port);
  return String(port);
}
