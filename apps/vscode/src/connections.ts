import { randomUUID } from "node:crypto";
import type { Memento, SecretStorage } from "vscode";
import { OpenshipClient, type OpenshipClientOptions } from "@repo/sdk/client";
import { type Connection, isRecord } from "./model";
import { normalizeEndpoint } from "./urls";

const STATE_KEY = "openship.connections.v1";
const secretKey = (id: string) => `openship.connection.${id}.token`;
type NewConnection = Omit<Connection, "id">;
type ClientFactory = (options: OpenshipClientOptions) => OpenshipClient;

function parseConnection(value: unknown): Connection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.apiUrl !== "string" ||
    typeof value.dashboardUrl !== "string" ||
    (value.organizationId !== undefined &&
      (typeof value.organizationId !== "string" || !value.organizationId.trim()))
  )
    return;
  try {
    return {
      id: value.id,
      name: value.name,
      apiUrl: normalizeEndpoint(value.apiUrl),
      dashboardUrl: normalizeEndpoint(value.dashboardUrl),
      ...(value.organizationId ? { organizationId: value.organizationId as string } : {}),
    };
  } catch {
    return;
  }
}

export class Connections {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: Pick<Memento, "get" | "update">,
    private readonly secrets: Pick<SecretStorage, "get" | "store" | "delete">,
    private readonly changed: () => void,
    private readonly makeClient: ClientFactory = (options) => new OpenshipClient(options),
    private readonly version = "dev",
  ) {}

  list(): Connection[] {
    const value = this.state.get<unknown>(STATE_KEY, []);
    return Array.isArray(value)
      ? value.map(parseConnection).filter((item): item is Connection => !!item)
      : [];
  }

  get(id: string): Connection {
    const connection = this.list().find((item) => item.id === id);
    if (!connection)
      throw new Error(
        "This connection is no longer available. Run Openship: Connect, then link the workspace again.",
      );
    return connection;
  }

  client(id: string, organizationId?: string): OpenshipClient {
    const connection = this.get(id);
    if (
      organizationId &&
      connection.organizationId &&
      organizationId !== connection.organizationId
    ) {
      throw new Error("The project belongs to a different organization than this connection.");
    }
    return this.makeClient({
      baseUrl: connection.apiUrl,
      organizationId: organizationId ?? connection.organizationId,
      timeoutMs: 20_000,
      userAgent: `openship-vscode/${this.version}`,
      token: async () => {
        this.get(id);
        const token = await this.secrets.get(secretKey(id));
        if (!token)
          throw new Error(
            "No access token is stored for this connection. Run Openship: Update Access Token.",
          );
        return token;
      },
    });
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async validate(connection: NewConnection, token: string): Promise<void> {
    if (!/^opsh_pat_\S+$/.test(token))
      throw new Error("Enter an Openship personal access token starting with opsh_pat_.");
    // The extension needs project read access. Checking its typed response also
    // rejects a dashboard HTML page accidentally entered as the API endpoint.
    await this.makeClient({
      baseUrl: connection.apiUrl,
      organizationId: connection.organizationId,
      token,
      timeoutMs: 10_000,
      userAgent: `openship-vscode/${this.version}`,
    }).projects.list({ perPage: 1 });
  }

  add(input: NewConnection, token: string): Promise<Connection> {
    return this.mutate(async () => {
      const name = input.name.trim();
      if (!name || this.list().some((item) => item.name === name))
        throw new Error("Choose a unique connection name.");
      const connection: Connection = {
        id: randomUUID(),
        name,
        apiUrl: normalizeEndpoint(input.apiUrl),
        dashboardUrl: normalizeEndpoint(input.dashboardUrl),
        ...(input.organizationId?.trim() ? { organizationId: input.organizationId.trim() } : {}),
      };
      await this.validate(connection, token.trim());
      await this.secrets.store(secretKey(connection.id), token.trim());
      try {
        await this.state.update(STATE_KEY, [...this.list(), connection]);
      } catch (error) {
        await this.secrets.delete(secretKey(connection.id));
        throw error;
      }
      this.changed();
      return connection;
    });
  }

  updateToken(id: string, token: string): Promise<void> {
    return this.mutate(async () => {
      await this.validate(this.get(id), token.trim());
      await this.secrets.store(secretKey(id), token.trim());
      this.changed();
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      this.get(id);
      await this.secrets.delete(secretKey(id));
      await this.state.update(
        STATE_KEY,
        this.list().filter((item) => item.id !== id),
      );
      this.changed();
    });
  }
}
