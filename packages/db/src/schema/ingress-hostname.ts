import { pgTable, text, jsonb, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { domain } from "./domain";
import { ingressConnection } from "./ingress-connection";

export interface IngressOwnership {
  zoneId?: string;
  dnsId?: string;
  appId?: string;
  appAud?: string;
  appPolicyId?: string;
  /** Policy write intent survives a lost provider response and later disconnection. */
  appNextPolicyId?: string;
  teamName?: string;
  /** Last accepted provider state. Write intent is saved BEFORE an external call. */
  rule?: Record<string, unknown>;
  nextRule?: Record<string, unknown>;
  dnsIntent?: boolean;
  appIntent?: boolean;
}
/** Survives domain/project deletion. Only this ledger authorizes provider cleanup. */
export const ingressHostname = pgTable(
  "ingress_hostname",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => ingressConnection.id, { onDelete: "restrict" }),
    domainId: text("domain_id").references(() => domain.id, { onDelete: "set null" }),
    hostname: text("hostname").notNull(),
    accessPolicyId: text("access_policy_id"),
    status: text("status")
      .$type<"pending" | "ready" | "error" | "removing">()
      .notNull()
      .default("pending"),
    phase: text("phase").notNull().default("access"),
    ownership: jsonb("ownership").$type<IngressOwnership>().notNull().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ingress_hostname_domain").on(t.domainId),
    uniqueIndex("ingress_hostname_host").on(t.connectionId, t.hostname),
    index("ingress_hostname_due").on(t.nextAttemptAt),
  ],
);
