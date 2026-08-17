import { NonceCache } from "./protocol";
import { loadAgentConfig } from "./config";
import { OperationJournal } from "./journal";
import { startAgentHttp, type AgentRuntime } from "./server";
import { replayIncomplete, startHeartbeat } from "./loop";
import { executeOp } from "./ops";

export async function startAgent(runtime?: AgentRuntime): Promise<{
  runtime: AgentRuntime;
  stop: () => Promise<void>;
}> {
  let resolved = runtime;
  if (!resolved) {
    const config = loadAgentConfig();
    resolved = {
      config,
      journal: new OperationJournal(config.journalPath),
      nonces: new NonceCache(),
    };
  }

  const recovered = await replayIncomplete(resolved);
  if (recovered > 0) {
    console.log(`[openship-agent] replayed ${recovered} incomplete journal op(s)`);
  }
  await executeOp("recover_releases", {}, resolved.journal).catch((err) => {
    console.warn("[openship-agent] recover_releases failed", err);
  });

  const http = startAgentHttp(resolved);
  const beat = startHeartbeat(resolved);
  const addr = `${resolved.config.listenHost}:${resolved.config.listenPort}`;
  console.log(`[openship-agent] listening on ${addr} server=${resolved.config.serverId}`);

  return {
    runtime: resolved,
    stop: async () => {
      beat.stop();
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

const isMain = (import.meta as ImportMeta & { main?: boolean }).main === true;
if (isMain) {
  startAgent().catch((err) => {
    console.error("[openship-agent] failed to start", err);
    process.exit(1);
  });
}
