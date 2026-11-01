/**
 * Capabilities of the Scale planner, not a list of provisioned database engines.
 * Limits are OpenShip product limits; they are not upstream database limits.
 * Keep this module serializable and independent of React and server integrations.
 */
export const RESOURCE_KINDS = ["edge", "service", "postgres", "redis"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const DATABASE_KINDS = ["postgres", "redis"] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];
export const DATABASE_MODES = { standalone: "Standalone", cluster: "Cluster" } as const;
export type DatabaseMode = keyof typeof DATABASE_MODES;
export const DATABASE_CPUS = [0.5, 1, 2, 4, 8] as const;
export const DATABASE_MEMORY = [512, 1024, 2048, 4096, 8192, 16384] as const;

export const APPLICATION_TYPES = {
  api: "API",
  website: "Website",
  service: "HTTP service",
} as const;
export const ALGORITHMS = {
  "round-robin": "Round robin",
  "least-connections": "Least connections",
  "ip-hash": "IP hash",
} as const;
export const CONNECTION_PROTOCOLS = {
  http: "HTTP",
  https: "HTTPS",
  tcp: "TCP",
  tls: "TLS",
} as const;
export type ConnectionProtocol = keyof typeof CONNECTION_PROTOCOLS;
export const REPLICATION_MODES = { async: "Asynchronous", sync: "Synchronous" } as const;
export type ReplicationMode = keyof typeof REPLICATION_MODES;
export type ClusterMemberRole = "primary" | "replica";

export const SCALE_LIMITS = {
  resources: 60,
  connections: 180,
  instances: 24,
  draftBytes: 2_000_000,
} as const;

const databaseConnection = { protocols: ["tcp", "tls"], defaultProtocol: "tcp" } as const;
const databaseCapacity = { cpu: DATABASE_CPUS, memory: DATABASE_MEMORY } as const;

export const DATABASE_CATALOG = {
  postgres: {
    engine: "PostgreSQL",
    title: "PostgreSQL database",
    description: "Relational database",
    connection: { ...databaseConnection, defaultPort: 5432 },
    deployments: {
      standalone: {
        label: "Standalone",
        description: "One database instance",
        topology: "single-instance",
        defaults: { cpu: 1, memory: 1024, storage: 20 },
        limits: { ...databaseCapacity, storage: { min: 10, max: 4096 } },
        actions: [],
      },
      cluster: {
        label: "Cluster",
        description: "Primary with read replicas",
        topology: "primary-replicas",
        defaults: { replicas: 2, failover: true },
        limits: { primaries: { min: 1, max: 1 }, replicas: { min: 0, max: 8 } },
        roles: {
          primary: { label: "Primary", access: "read-write", removal: "protected" },
          replica: { label: "Read replica", access: "read-only", removal: "member" },
        },
        replication: {
          sourceRoles: ["primary", "replica"],
          targetRole: "replica",
          sameShard: true,
          modes: ["async", "sync"],
          defaultMode: "async",
          synchronousSourceRoles: ["primary"],
          maxSourcesPerReplica: 1,
        },
        failover: { supported: true, minimumReplicas: 1 },
        actions: [
          {
            id: "add-replica",
            label: "Add replica",
            description: "Add a read replica connected to the primary",
            field: "replicas",
            scope: "cluster",
          },
        ],
      },
    },
  },
  redis: {
    engine: "Redis",
    title: "Redis database",
    description: "In-memory data store",
    connection: { ...databaseConnection, defaultPort: 6379 },
    deployments: {
      standalone: {
        label: "Standalone",
        description: "One database instance",
        topology: "single-instance",
        defaults: { cpu: 1, memory: 1024 },
        limits: databaseCapacity,
        actions: [],
      },
      cluster: {
        label: "Cluster",
        description: "Shards with replicas",
        topology: "sharded",
        defaults: { shards: 3, replicasPerShard: 1 },
        limits: { shards: { min: 3, max: 12 }, replicasPerShard: { min: 1, max: 2 } },
        roles: {
          primary: { label: "Shard primary", access: "read-write", removal: "shard" },
          replica: { label: "Replica", access: "read-only", removal: "cluster-settings" },
        },
        replication: {
          sourceRoles: ["primary"],
          targetRole: "replica",
          sameShard: true,
          modes: ["async"],
          defaultMode: "async",
          synchronousSourceRoles: [],
          maxSourcesPerReplica: 1,
        },
        sharding: { hashSlots: 16384, uniformReplicas: true, clusterAwareClient: true },
        actions: [
          {
            id: "add-shard",
            label: "Add shard",
            description: "Add a primary shard with its replicas",
            field: "shards",
            scope: "shard",
          },
          {
            id: "add-replica-per-shard",
            label: "Add replica per shard",
            description: "Add one replica to every primary shard",
            field: "replicasPerShard",
            scope: "every-shard",
          },
        ],
      },
    },
  },
} as const;

export type ClusterAddition =
  (typeof DATABASE_CATALOG)[DatabaseKind]["deployments"]["cluster"]["actions"][number]["id"];

export const RESOURCE_CATALOG = {
  edge: {
    title: "OpenShip Edge",
    description: "Ingress, TLS, and load balancing",
    paletteDescription: "TLS, routing and load balancing",
    connection: { protocols: ["http", "https"], defaultProtocol: "https", defaultPort: 443 },
    defaults: { tls: true, algorithm: "round-robin", healthPath: "/health", healthInterval: 10 },
    limits: { healthInterval: { min: 5, max: 120 } },
  },
  service: {
    title: "Application",
    description: "Horizontal instances of an API, website, or service",
    paletteDescription: "API, website or HTTP service",
    connection: { protocols: ["http", "https"], defaultProtocol: "http", defaultPort: 3000 },
    defaults: {
      applicationType: "api",
      port: 3000,
      cpu: 1,
      memory: 1024,
      autoscale: false,
      minReplicas: 1,
      maxReplicas: 8,
      targetCpu: 70,
    },
    initialInstances: 3,
    limits: {
      cpu: [0.5, 1, 2, 4],
      memory: [512, 1024, 2048, 4096, 8192],
      instances: { min: 1, max: SCALE_LIMITS.instances },
      targetCpu: { min: 20, max: 90 },
    },
  },
  ...DATABASE_CATALOG,
} as const;

export const CONNECTION_TARGETS: Readonly<Record<ResourceKind, readonly ResourceKind[]>> = {
  edge: ["edge", "service"],
  service: ["postgres", "redis"],
  postgres: [],
  redis: [],
};

/** Versioned capability document. Adding an install-catalog app does not enable it here. */
export const SCALE_CATALOG = {
  version: 1,
  draftVersion: 2,
  stage: "planning",
  resourceKinds: RESOURCE_KINDS,
  resources: RESOURCE_CATALOG,
  connectionTargets: CONNECTION_TARGETS,
  limits: SCALE_LIMITS,
} as const;

export const DATABASE_ENGINES = {
  postgres: DATABASE_CATALOG.postgres.engine,
  redis: DATABASE_CATALOG.redis.engine,
};
export const RESOURCE_META = RESOURCE_CATALOG;

export function isDatabaseKind(kind: ResourceKind): kind is DatabaseKind {
  return DATABASE_KINDS.some((database) => database === kind);
}
