import { Type, type Static } from "@sinclair/typebox";

const requestId = Type.String({
  pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",
});
const singleLine = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: "^[^\\x00-\\x1f\\x7f]+$" });
const message = Type.String({ minLength: 1, maxLength: 12_000, pattern: "^[^\\x00]+$" });

/** Public intake never accepts an organization, user identity, or delivery state. */
export const CloudSupportInputSchema = Type.Object(
  {
    requestId,
    name: singleLine(120),
    email: Type.String({
      minLength: 3,
      maxLength: 254,
      pattern:
        /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/
          .source,
    }),
    subject: singleLine(200),
    message,
    source: Type.Union([Type.Literal("support"), Type.Literal("contact")]),
  },
  { additionalProperties: false },
);
export type CloudSupportInput = Static<typeof CloudSupportInputSchema>;

export const CloudSupportStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("resolved"),
]);
export const CloudSupportReplySchema = Type.Object(
  {
    requestId,
    message,
    resolve: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CloudSupportReply = Static<typeof CloudSupportReplySchema>;

export const CloudSupportIdSchema = Type.String({ pattern: "^SUP-[A-F0-9]{24}$" });
export const CloudSupportReceiptSchema = Type.Object(
  {
    id: CloudSupportIdSchema,
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type CloudSupportReceipt = Static<typeof CloudSupportReceiptSchema>;

/** A connection binding, never a credential. Local relays require it on ticket requests. */
export const CLOUD_SUPPORT_ACCOUNT_HEADER = "X-Openship-Support-Account";
export const CloudSupportSessionSchema = Type.Object(
  {
    account: Type.Union([
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 512 }),
          id: Type.String(),
          name: Type.Union([Type.String(), Type.Null()]),
          email: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type CloudSupportSession = Static<typeof CloudSupportSessionSchema>;

export const CloudSupportCategorySchema = Type.Union([
  Type.Literal("deployment"),
  Type.Literal("billing"),
  Type.Literal("account"),
  Type.Literal("general"),
]);

/** Customer identity comes from the session, never from the form or an email match. */
export const CloudSupportCustomerInputSchema = Type.Object(
  { requestId, subject: singleLine(200), message, category: CloudSupportCategorySchema },
  { additionalProperties: false },
);
export const CloudSupportCustomerReplySchema = Type.Object(
  { requestId, message },
  { additionalProperties: false },
);
export const CloudSupportCustomerStatusSchema = Type.Object(
  { status: CloudSupportStatusSchema },
  { additionalProperties: false },
);
export const CloudSupportCustomerQuerySchema = Type.Object(
  {
    status: Type.Optional(CloudSupportStatusSchema),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    before: Type.Optional(CloudSupportIdSchema),
    limit: Type.Integer({ minimum: 1, maximum: 50 }),
  },
  { additionalProperties: false },
);
export const CloudSupportCustomerTicketSchema = Type.Object(
  {
    id: CloudSupportIdSchema,
    subject: Type.String(),
    category: CloudSupportCategorySchema,
    status: CloudSupportStatusSchema,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export const CloudSupportCustomerListSchema = Type.Object(
  {
    tickets: Type.Array(CloudSupportCustomerTicketSchema),
    nextCursor: Type.Union([CloudSupportIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const CloudSupportCustomerDetailSchema = Type.Object(
  {
    ticket: Type.Composite([
      CloudSupportCustomerTicketSchema,
      Type.Object({ message: Type.String() }),
    ]),
    messages: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          author: Type.Union([Type.Literal("customer"), Type.Literal("support")]),
          body: Type.String(),
          createdAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type CloudSupportCategory = Static<typeof CloudSupportCategorySchema>;
export type CloudSupportCustomerInput = Static<typeof CloudSupportCustomerInputSchema>;
export type CloudSupportCustomerReply = Static<typeof CloudSupportCustomerReplySchema>;
export type CloudSupportCustomerQuery = Static<typeof CloudSupportCustomerQuerySchema>;
export type CloudSupportCustomerTicket = Static<typeof CloudSupportCustomerTicketSchema>;
export type CloudSupportCustomerList = Static<typeof CloudSupportCustomerListSchema>;
export type CloudSupportCustomerDetail = Static<typeof CloudSupportCustomerDetailSchema>;
