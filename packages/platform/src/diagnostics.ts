import {
  endDiagnosticSpan,
  reportError,
  startDiagnosticSpan,
  type DiagnosticSpan,
  type ErrorContext,
} from "@repo/core/diagnostics";
import { currentErrorContext, withErrorContext } from "@repo/core/diagnostics/node";
import type { ExecutionContext } from "./context";

/** One observation boundary for the same operation through HTTP, MCP and native SDK. */
export function observePlatformOperations<T extends object>(module: string, operations: T): T {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(operations).map(([name, value]) => {
        if (typeof value !== "function") return [name, value];
        return [
          name,
          function (this: unknown, ...args: unknown[]) {
            const caller = args[0] as Partial<ExecutionContext> | undefined;
            const context: ErrorContext = {
              kind: "operation",
              component: module,
              operation: `${module}.${name}`,
              ...(caller && typeof caller === "object"
                ? {
                    traceId: caller.traceId,
                    userId: caller.userId,
                    organizationId: caller.organizationId,
                  }
                : {}),
            };
            const span = startDiagnosticSpan({ ...currentErrorContext(), ...context });
            const run = () =>
              withErrorContext({ ...context, ...span?.correlation }, () => {
                const failed = (error: unknown): never => {
                  reportError(error, { kind: "operation", handled: true });
                  endDiagnosticSpan(span, currentErrorContext(), error);
                  throw error;
                };
                try {
                  const result = Reflect.apply(value, operations, args);
                  const promise = result as PromiseLike<unknown> | null;
                  // Preserve synchronous APIs and rejections exactly; never await or
                  // retry the operation for logging and never inspect its input body.
                  return promise && typeof promise.then === "function"
                    ? promise.then((output: unknown) => {
                        const value = output as {
                          data?: unknown;
                          context?: ExecutionContext;
                        } | null;
                        const data = value?.data as AsyncIterable<unknown> | undefined;
                        if (data && typeof data[Symbol.asyncIterator] === "function") {
                          return {
                            ...value,
                            data: observeIterator(
                              data,
                              {
                                ...currentErrorContext(),
                                ...(value?.context
                                  ? {
                                      userId: value.context.userId,
                                      organizationId: value.context.organizationId,
                                    }
                                  : {}),
                              },
                              span,
                            ),
                          };
                        }
                        endDiagnosticSpan(span, currentErrorContext());
                        return output;
                      }, failed)
                    : (endDiagnosticSpan(span, currentErrorContext()), result);
                } catch (error) {
                  /* diagnostics-ignore: failed() records the error and rethrows the same object. */
                  return failed(error);
                }
              });
            return span ? span.run(run) : run();
          },
        ];
      }),
    ),
  ) as T;
}

/** Iterator work happens after the operation returns; retain its own scoped ids. */
function observeIterator<T>(
  source: AsyncIterable<T>,
  context: ErrorContext,
  span?: DiagnosticSpan,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const create = () =>
        withErrorContext(context, () => {
          try {
            return source[Symbol.asyncIterator]();
          } catch (error) {
            reportError(error, { handled: true });
            endDiagnosticSpan(span, currentErrorContext(), error);
            throw error;
          }
        });
      const iterator = span ? span.run(create) : create();
      const call = (work: () => Promise<IteratorResult<T>>) => {
        const run = () =>
          withErrorContext(context, async () => {
            try {
              const result = await work();
              if (result.done) endDiagnosticSpan(span, currentErrorContext());
              return result;
            } catch (error) {
              reportError(error, { handled: true });
              endDiagnosticSpan(span, currentErrorContext(), error);
              throw error;
            }
          });
        return span ? span.run(run) : run();
      };
      return {
        next: (...args: [] | [unknown]) => call(() => iterator.next(...args)),
        ...(iterator.return
          ? { return: (value?: unknown) => call(() => iterator.return!(value)) }
          : {}),
        ...(iterator.throw
          ? { throw: (error?: unknown) => call(() => iterator.throw!(error)) }
          : {}),
      };
    },
  };
}
