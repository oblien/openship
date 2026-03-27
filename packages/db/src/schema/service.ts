import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { deployment } from "./deployment";

// ─── Services ────────────────────────────────────────────────────────────────

/**
 * Compose services within a project.
 * Each service represents a single container in a multi-service (docker-compose) project.
 * Services share a Docker network and can reach each other by name as hostname.
 */
export const service = pgTable("service", {
  id: text("id").primaryKey(), // "svc_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),

  /** Service name (from compose, e.g. "web", "db", "redis") — also used as hostname on the network */
  name: text("name").notNull(),
  /** Docker image (e.g. "postgres:16", "redis:7-alpine") — null if service is built from source */
  image: text("image"),
  /** Build context path relative to repo root (e.g. ".", "./services/api") — null if using a pre-built image */
  build: text("build"),
  /** Dockerfile path relative to build context — null to use default "Dockerfile" */
  dockerfile: text("dockerfile"),

  /* ── Networking ─────────────────────────────────────────────────────── */
  /** JSON array of port mappings (e.g. ["8080:3000", "5432"]) */
  ports: jsonb("ports").$type<string[]>().default([]),
  /** JSON array of service names this service depends on */
  dependsOn: jsonb("depends_on").$type<string[]>().default([]),

  /* ── Configuration ──────────────────────────────────────────────────── */
  /** JSON object of environment variables (non-secret defaults from compose) */
  environment: jsonb("environment").$type<Record<string, string>>().default({}),
  /** JSON array of volume mounts (e.g. ["pgdata:/var/lib/postgresql/data"]) */
  volumes: jsonb("volumes").$type<string[]>().default([]),
  /** Override command */
  command: text("command"),
  /** Restart policy: no | always | on-failure | unless-stopped */
  restart: text("restart").default("unless-stopped"),

  /* ── Public routing ─────────────────────────────────────────────── */
  /** Whether this service should be exposed publicly through routing */
  exposed: boolean("exposed").notNull().default(false),
  /** Container port to expose publicly */
  exposedPort: text("exposed_port"),
  /** Free subdomain label for managed routing */
  domain: text("domain"),
  /** Custom domain bound directly to this service */
  customDomain: text("custom_domain"),
  /** Whether the service uses a free or custom domain */
  domainType: text("domain_type").default("free"),

  /* ── State ──────────────────────────────────────────────────────────── */
  /** Whether this service should be deployed (allows disabling individual services) */
  enabled: boolean("enabled").notNull().default(true),
  /** Display / dependency order (lower = deployed first) */
  sortOrder: integer("sort_order").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Service deployments ─────────────────────────────────────────────────────

/**
 * Per-service container state within a deployment.
 * A project deployment fans out into one serviceDeployment per enabled service.
 */
export const serviceDeployment = pgTable("service_deployment", {
  id: text("id").primaryKey(), // "sd_..."
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployment.id, { onDelete: "cascade" }),
  serviceId: text("service_id")
    .notNull()
    .references(() => service.id, { onDelete: "cascade" }),

  /** Docker container ID */
  containerId: text("container_id"),
  /** Container status: running | stopped | failed | building */
  status: text("status").notNull().default("pending"),
  /** Resolved image reference (pulled or built) */
  imageRef: text("image_ref"),
  /** Mapped host port */
  hostPort: integer("host_port"),
  /** Internal network IP */
  ip: text("ip"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
