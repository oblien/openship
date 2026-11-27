import type { CloudSubscriptionChangeIntent, CloudWorkspaceOperation } from "./cloud-workspace";
import type { MailPlacement, MailProduct, PaidMailPlan } from "@repo/core/managed-mail";
import {
  pgTable,
  primaryKey,
  text,
  boolean,
  jsonb,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { servers } from "./servers";
import { personalAccessToken } from "./personal-access-token";

/** Worker-local delegation. Keep the tenant/service reservation even after a PAT is removed. */
export const mailTenantAccess = pgTable("mail_tenant_access", {
  serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  serviceId: text("service_id").notNull().unique(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  parentId: text("parent_id").references(() => personalAccessToken.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull().unique(),
}, t => [primaryKey({ columns: [t.serverId, t.namespace] })]);

export type DedicatedMailOrder = {
  purchase?: { plan: PaidMailPlan; storageGB: number; monthlyCents: number };
  plan: PaidMailPlan;
  storageGB: number;
  vmMonthlyCents: number;
  sendingMonthlyCents: number;
  cpuCores: number;
  memoryMB: number;
  diskGB: number;
  allowance?: { recipients: number; dailyRecipients: number; domains: number };
  worker?: { id: string; origin: string };
};

export type MailChangeIntent = CloudSubscriptionChangeIntent & {
  nextOrder?: Omit<DedicatedMailOrder, "worker" | "purchase">;
  restartWorkloads?: CloudWorkspaceOperation["restartWorkloads"];
};

/** A host keeps its identity and isolation mode even after its last owner leaves. */
export const managedMailHost = pgTable(
  "managed_mail_host",
  {
    engine: text("engine").primaryKey(),
    hostname: text("hostname").notNull().unique("managed_mail_host_hostname_key"),
    shared: boolean("shared").notNull(),
  },
  (table) => [unique("managed_mail_host_identity").on(table.engine, table.hostname, table.shared)],
);

/** Keep the assignment after cancellation. A previously occupied engine must
 * be explicitly retired and wiped before its infrastructure can be reused. */
export const managedMailService = pgTable(
  "managed_mail_service",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    engine: text("engine"),
    hostname: text("hostname"),
    shared: boolean("shared").notNull().default(false),
    provisioning: boolean("provisioning").notNull().default(false),
    cloudServerId: text("cloud_server_id").unique("managed_mail_service_cloud_server_id_key"),
    billingNamespace: text("billing_namespace").unique(),
    order: jsonb("dedicated_order").$type<DedicatedMailOrder>(),
    change: jsonb("subscription_change").$type<MailChangeIntent>(),
    orderState: text("order_state").$type<"checkout" | "funded" | "closed">(),
    checkoutId: text("checkout_id"),
    placement: text("placement").$type<MailPlacement>().notNull(),
  },
  (table) => [
    uniqueIndex("managed_mail_default_service")
      .on(table.organizationId)
      .where(sql`${table.billingNamespace} IS NULL`),
    uniqueIndex("managed_mail_pending_order")
      .on(table.organizationId)
      .where(sql`${table.orderState} = 'checkout'`),
    check(
      "managed_mail_assignment",
      sql`(${table.engine} IS NOT NULL AND ${table.hostname} IS NOT NULL) OR
      (${table.engine} IS NULL AND ${table.hostname} IS NULL AND ${table.provisioning} AND (${table.cloudServerId} IS NOT NULL OR ${table.billingNamespace} IS NOT NULL) AND ${table.placement} = 'dedicated')`,
    ),
    check(
      "managed_mail_order_identity",
      sql`
      (${table.billingNamespace} IS NULL AND ${table.order} IS NULL AND ${table.orderState} IS NULL) OR
      (${table.billingNamespace} IS NOT NULL AND ${table.order} IS NOT NULL AND ${table.orderState} IS NOT NULL AND
       ${table.orderState} IN ('checkout', 'funded', 'closed') AND ${table.placement} = 'dedicated' AND NOT ${table.shared})`,
    ),
    foreignKey({
      name: "managed_mail_service_host",
      columns: [table.engine, table.hostname, table.shared],
      foreignColumns: [managedMailHost.engine, managedMailHost.hostname, managedMailHost.shared],
    }),
    check(
      "managed_mail_shared_placement",
      sql`NOT ${table.shared} OR ${table.placement} = 'standard'`,
    ),
    uniqueIndex("managed_mail_private_engine")
      .on(table.engine)
      .where(sql`NOT ${table.shared}`),
  ],
);

export const managedMailAccount = pgTable("managed_mail_account", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull().unique(),
  namespaceReady: boolean("namespace_ready").notNull().default(false),
  sendingEnabled: boolean("sending_enabled").notNull().default(false),
  change: jsonb("subscription_change").$type<MailChangeIntent>(),
  checkout: jsonb("checkout").$type<{
    key: string;
    plan: PaidMailPlan;
    product?: Exclude<MailProduct, "dedicated">;
    id?: string;
  }>(),
});
