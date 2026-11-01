import { Type, type Static } from "@sinclair/typebox";

/** Shared by the browser, SDK and terminal controllers. Credentials never belong in URLs. */
export const TERMINAL_SUBPROTOCOL_PREFIX = "openship.terminal.v1+";
export const TERMINAL_RESUME_SUBPROTOCOL_PREFIX = "openship.terminal.resume+";
export const TERMINAL_COLS_MAX = 1000;
export const TERMINAL_ROWS_MAX = 500;

export const TerminalTicketSchema = Type.Object({
  success: Type.Literal(true),
  token: Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" }),
  expiresIn: Type.Number({ minimum: 0 }),
});
export type TerminalTicket = Static<typeof TerminalTicketSchema>;
export const TerminalTargetSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("server"), Type.Literal("service")]),
    id: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
export type TerminalTarget = Static<typeof TerminalTargetSchema>;

export const TerminalControlSchema = Type.Union([
  Type.Object({
    type: Type.Literal("ready"),
    sessionId: Type.String(),
    resumeToken: Type.String(),
    resumed: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("exit"),
    code: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal("error"), code: Type.String(), message: Type.String() }),
  Type.Object({ type: Type.Literal("pong") }),
]);
export type TerminalControl = Static<typeof TerminalControlSchema>;
export type TerminalReady = Extract<TerminalControl, { type: "ready" }>;
export type TerminalExit = Extract<TerminalControl, { type: "exit" }>;
