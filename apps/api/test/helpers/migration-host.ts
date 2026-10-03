import { connect, createServer, type AddressInfo } from "node:net";

/** Reserve on the runner too: a Docker VM's ephemeral port can collide with a
 * local listener. Release just before Docker publishes the fixture port. */
export function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

/** Docker may publish its port before the VM's host forwarding carries SSH. */
export function sshReady(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
    socket.once("data", data => finish(data.toString().startsWith("SSH-")));
  });
}
