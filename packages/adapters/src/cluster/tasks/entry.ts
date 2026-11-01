import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { runDatabaseTask, taskError } from "./main";

const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
Promise.resolve()
  .then(() =>
    runDatabaseTask(
      JSON.parse(process.env.TASK_CONFIG ?? "{}"),
      AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)]),
    ),
  )
  .catch((error) => {
    errorDiagnostics.error("adapters/cluster/tasks/entry", taskError(error), error);
    process.exitCode = 1;
  });
