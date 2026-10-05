import type { OutputChannel } from "vscode";
import type { OpenshipClient } from "@repo/sdk/client";
import type { DeploymentReference } from "./model";
import { cleanText } from "./errors";
import { type LogSink, watchDeployment, watchRuntimeLogs } from "./streams";

/** A single visible stream prevents background subscriptions accumulating. */
export class Logs {
  private active?: { controller: AbortController; deployment?: DeploymentReference };
  private closed = false;

  constructor(
    readonly output: OutputChannel,
    private readonly changed: (watching: boolean) => void,
  ) {}

  get currentDeployment(): DeploymentReference | undefined {
    return this.active?.deployment;
  }

  stop(): void {
    if (!this.active) return;
    const wasDeployment = !!this.active.deployment;
    this.active.controller.abort();
    this.active = undefined;
    this.output.appendLine(
      wasDeployment
        ? "\nStopped watching. The deployment continues on Openship."
        : "\nStopped watching application logs.",
    );
    this.changed(false);
  }

  private async run<T>(
    label: string,
    work: (signal: AbortSignal, sink: LogSink) => Promise<T>,
    deployment?: DeploymentReference,
  ): Promise<T | undefined> {
    if (this.closed) return;
    this.stop();
    const session = { controller: new AbortController(), deployment };
    this.active = session;
    this.output.clear();
    this.output.appendLine(cleanText(label));
    this.output.show(true);
    this.changed(true);
    const sink: LogSink = {
      append: (text) => {
        if (this.active === session) this.output.append(text);
      },
      appendLine: (text) => {
        if (this.active === session) this.output.appendLine(text);
      },
    };
    try {
      const result = await work(session.controller.signal, sink);
      return this.active === session ? result : undefined;
    } catch (error) {
      if (!session.controller.signal.aborted) throw error;
    } finally {
      session.controller.abort();
      if (this.active === session) {
        this.active = undefined;
        this.changed(false);
      }
    }
  }

  deployment(client: OpenshipClient, ref: DeploymentReference, label: string) {
    return this.run(
      label,
      (signal, sink) => watchDeployment(client, ref.deploymentId, signal, sink),
      ref,
    );
  }

  runtime(client: OpenshipClient, projectId: string, label: string) {
    return this.run(label, (signal, sink) => watchRuntimeLogs(client, projectId, signal, sink));
  }

  dispose(): void {
    this.closed = true;
    this.stop();
  }
}
