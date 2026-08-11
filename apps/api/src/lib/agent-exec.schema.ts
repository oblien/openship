import { Type } from "@sinclair/typebox";
import {
  EXEC_OUTPUT_MAX_BYTES,
  EXEC_TIMEOUT_DEFAULT_MS,
  EXEC_TIMEOUT_MAX_MS,
} from "./agent-exec";

/**
 * Body for both exec endpoints (host and in-container). One schema so the two
 * tools present an identical contract to an agent — the only difference between
 * them is WHERE the command lands, which the path already says.
 *
 * Declared as `spec.body` rather than only documented, because the MCP tool layer
 * derives its `body` input parameter from `spec.body` and advertises NO body at all
 * when it is absent. For an exec tool that would mean an agent could see the tool
 * and have no way to send it a command.
 */
export const AgentExecBody = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: 10_000,
      description:
        "Shell command to run. Interpreted by `sh -c`, so pipes, redirects and `&&` work. stderr is merged into the output.",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description: "Working directory to run in. Defaults to the target's own default.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: EXEC_TIMEOUT_MAX_MS,
        default: EXEC_TIMEOUT_DEFAULT_MS,
        description: `Kill the command after this long. Max ${EXEC_TIMEOUT_MAX_MS}ms.`,
      }),
    ),
    maxOutputBytes: Type.Optional(
      Type.Integer({
        minimum: 1_024,
        maximum: EXEC_OUTPUT_MAX_BYTES,
        default: EXEC_OUTPUT_MAX_BYTES,
        description: `Truncate output past this many bytes. Max ${EXEC_OUTPUT_MAX_BYTES}.`,
      }),
    ),
  },
  { additionalProperties: false },
);
