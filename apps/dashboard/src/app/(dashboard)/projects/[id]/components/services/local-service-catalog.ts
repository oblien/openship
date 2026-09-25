/**
 * Curated catalog for **local / self-hosted** Docker deployments.
 *
 * The Oblien `images.list()` catalog is cloud-specific (oblien/* images
 * running on managed workspaces). When the user deploys to their own
 * machine or server, those images don't apply - they need the plain
 * upstream Docker images instead.
 *
 * This list is hand-curated to the things people actually add to apps:
 * databases, caches, search, vector stores, queues, storage, browsers
 * for scraping, mail catchers for dev, etc.
 *
 * Logos use the simpleicons.org CDN where available (returns a clean,
 * single-color SVG). Entries without a simpleicons slug fall back to
 * catalog's package icon at render time.
 *
 * Default env keys cover the minimum needed to boot the image - the
 * user will paste their real secrets in the configure step.
 */

import type { ImageCatalogEntry } from "@/lib/api/images";

function si(slug: string): string {
  // simpleicons.org auto-coloring CDN. Falls back to monochrome silently
  // if the slug isn't in their set - `onError` on the <img> tag hides it.
  return `https://cdn.simpleicons.org/${slug}`;
}

function gh(org: string): string {
  // GitHub org avatar - reliable for projects that don't have a simpleicons
  // entry yet (newer tools like Valkey, Dragonfly, Redpanda).
  return `https://github.com/${org}.png?size=80`;
}

export const LOCAL_SERVICE_CATALOG: ImageCatalogEntry[] = [
  /* ── Databases ─────────────────────────────────────────────────────── */
  {
    id: "postgres",
    name: "PostgreSQL",
    image: "postgres:16-alpine",
    logo: si("postgresql"),
    category: "database",
    description: "Open-source relational database. The default choice for most apps.",
    ports: [5432],
    defaultEnv: [
      { key: "POSTGRES_USER", value: "postgres" },
      { key: "POSTGRES_PASSWORD", value: "" },
      { key: "POSTGRES_DB", value: "app" },
    ],
    defaultVolumes: ["pgdata:/var/lib/postgresql/data"],
  },
  {
    id: "mysql",
    name: "MySQL",
    image: "mysql:8",
    logo: si("mysql"),
    category: "database",
    description: "Popular relational database, especially common with PHP and WordPress.",
    ports: [3306],
    defaultEnv: [
      { key: "MYSQL_ROOT_PASSWORD", value: "" },
      { key: "MYSQL_DATABASE", value: "app" },
    ],
    defaultVolumes: ["mysql_data:/var/lib/mysql"],
  },
  {
    id: "mariadb",
    name: "MariaDB",
    image: "mariadb:11",
    logo: si("mariadb"),
    category: "database",
    description: "MySQL-compatible drop-in maintained by the original authors.",
    ports: [3306],
    defaultEnv: [
      { key: "MARIADB_ROOT_PASSWORD", value: "" },
      { key: "MARIADB_DATABASE", value: "app" },
    ],
    defaultVolumes: ["mariadb_data:/var/lib/mysql"],
  },
  {
    id: "mongo",
    name: "MongoDB",
    image: "mongo:7",
    logo: si("mongodb"),
    category: "database",
    description: "Document-oriented NoSQL database for flexible schemas.",
    ports: [27017],
    defaultEnv: [
      { key: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
      { key: "MONGO_INITDB_ROOT_PASSWORD", value: "" },
    ],
    defaultVolumes: ["mongo_data:/data/db"],
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    image: "clickhouse/clickhouse-server:latest",
    logo: si("clickhouse"),
    category: "database",
    description: "Columnar analytics database for fast OLAP queries at scale.",
    ports: [8123, 9000],
    defaultEnv: [
      { key: "CLICKHOUSE_USER", value: "default" },
      { key: "CLICKHOUSE_PASSWORD", value: "" },
    ],
    defaultVolumes: ["clickhouse_data:/var/lib/clickhouse"],
  },
  {
    id: "cockroachdb",
    name: "CockroachDB",
    image: "cockroachdb/cockroach:latest",
    logo: gh("cockroachdb"),
    category: "database",
    description: "Distributed SQL database with PostgreSQL wire compatibility.",
    ports: [26257, 8080],
    defaultEnv: [
      { key: "COCKROACH_DATABASE", value: "app" },
      { key: "COCKROACH_USER", value: "root" },
    ],
    defaultVolumes: ["cockroach_data:/cockroach/cockroach-data"],
  },

  /* ── Caches ───────────────────────────────────────────────────────── */
  {
    id: "redis",
    name: "Redis",
    image: "redis:7-alpine",
    logo: si("redis"),
    category: "cache",
    description: "In-memory key-value store. Caching, sessions, pub/sub.",
    ports: [6379],
    defaultEnv: [
      { key: "REDIS_PASSWORD", value: "" },
    ],
    defaultVolumes: ["redis_data:/data"],
  },
  {
    id: "valkey",
    name: "Valkey",
    image: "valkey/valkey:8-alpine",
    logo: gh("valkey-io"),
    category: "cache",
    description: "Open-source Redis fork maintained by the Linux Foundation.",
    ports: [6379],
    defaultVolumes: ["valkey_data:/data"],
  },
  {
    id: "memcached",
    name: "Memcached",
    image: "memcached:1.6-alpine",
    logo: gh("memcached"),
    category: "cache",
    description: "Distributed memory object caching system - simple and fast.",
    ports: [11211],
  },
  {
    id: "dragonfly",
    name: "Dragonfly",
    image: "docker.dragonflydb.io/dragonflydb/dragonfly:latest",
    logo: gh("dragonflydb"),
    category: "cache",
    description: "Redis-compatible, modern in-memory data store with higher throughput.",
    ports: [6379],
    defaultVolumes: ["dragonfly_data:/data"],
  },

  /* ── Search ───────────────────────────────────────────────────────── */
  {
    id: "elasticsearch",
    name: "Elasticsearch",
    image: "elasticsearch:8.13.0",
    logo: si("elasticsearch"),
    category: "search",
    description: "Distributed full-text search and analytics engine.",
    ports: [9200],
    defaultEnv: [
      { key: "discovery.type", value: "single-node" },
      { key: "ES_JAVA_OPTS", value: "-Xms512m -Xmx512m" },
      { key: "xpack.security.enabled", value: "false" },
    ],
    defaultVolumes: ["es_data:/usr/share/elasticsearch/data"],
  },
  {
    id: "meilisearch",
    name: "Meilisearch",
    image: "getmeili/meilisearch:v1.8",
    logo: si("meilisearch"),
    category: "search",
    description: "Lightweight, typo-tolerant search engine. Drop-in for product search.",
    ports: [7700],
    defaultEnv: [
      { key: "MEILI_MASTER_KEY", value: "" },
      { key: "MEILI_ENV", value: "development" },
    ],
    defaultVolumes: ["meili_data:/meili_data"],
  },
  {
    id: "typesense",
    name: "Typesense",
    image: "typesense/typesense:26.0",
    logo: gh("typesense"),
    category: "search",
    description: "Fast, open-source search engine with first-class typo tolerance.",
    ports: [8108],
    defaultEnv: [
      { key: "TYPESENSE_API_KEY", value: "" },
      { key: "TYPESENSE_DATA_DIR", value: "/data" },
    ],
    defaultVolumes: ["typesense_data:/data"],
  },
  {
    id: "opensearch",
    name: "OpenSearch",
    image: "opensearchproject/opensearch:2",
    logo: si("opensearch"),
    category: "search",
    description: "Elasticsearch fork maintained by AWS, Apache 2.0 licensed.",
    ports: [9200],
    defaultEnv: [
      { key: "discovery.type", value: "single-node" },
      { key: "plugins.security.disabled", value: "true" },
    ],
    defaultVolumes: ["opensearch_data:/usr/share/opensearch/data"],
  },

  /* ── Vector & AI ──────────────────────────────────────────────────── */
  {
    id: "qdrant",
    name: "Qdrant",
    image: "qdrant/qdrant:latest",
    logo: si("qdrant"),
    category: "vector",
    description: "Vector database for similarity search, embeddings, and RAG.",
    ports: [6333, 6334],
    defaultEnv: [
      { key: "QDRANT__SERVICE__API_KEY", value: "" },
    ],
    defaultVolumes: ["qdrant_storage:/qdrant/storage"],
  },
  {
    id: "weaviate",
    name: "Weaviate",
    image: "semitechnologies/weaviate:latest",
    logo: gh("weaviate"),
    category: "vector",
    description: "Open-source vector database with built-in vectorizer modules.",
    ports: [8080],
    defaultEnv: [
      { key: "AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED", value: "true" },
      { key: "PERSISTENCE_DATA_PATH", value: "/var/lib/weaviate" },
      { key: "DEFAULT_VECTORIZER_MODULE", value: "none" },
    ],
    defaultVolumes: ["weaviate_data:/var/lib/weaviate"],
  },
  {
    id: "chroma",
    name: "Chroma",
    image: "chromadb/chroma:latest",
    logo: gh("chroma-core"),
    category: "vector",
    description: "AI-native embedding database. Lightweight, Python-friendly.",
    ports: [8000],
    defaultEnv: [
      { key: "IS_PERSISTENT", value: "TRUE" },
      { key: "PERSIST_DIRECTORY", value: "/chroma/chroma" },
    ],
    defaultVolumes: ["chroma_data:/chroma/chroma"],
  },
  {
    id: "ollama",
    name: "Ollama",
    image: "ollama/ollama:latest",
    logo: si("ollama"),
    category: "vector",
    description: "Run local LLMs (Llama, Mistral, etc.) with an OpenAI-compatible API.",
    ports: [11434],
    defaultVolumes: ["ollama_data:/root/.ollama"],
  },

  /* ── Queues & Streams ─────────────────────────────────────────────── */
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    image: "rabbitmq:3-management-alpine",
    logo: si("rabbitmq"),
    category: "queue",
    description: "Battle-tested message broker with AMQP, MQTT, and management UI.",
    ports: [5672, 15672],
    defaultEnv: [
      { key: "RABBITMQ_DEFAULT_USER", value: "guest" },
      { key: "RABBITMQ_DEFAULT_PASS", value: "guest" },
    ],
    defaultVolumes: ["rabbitmq_data:/var/lib/rabbitmq"],
  },
  {
    id: "nats",
    name: "NATS",
    image: "nats:latest",
    logo: si("natsdotio"),
    category: "queue",
    description: "Lightweight, high-performance messaging system for cloud-native apps.",
    ports: [4222, 8222],
  },
  {
    id: "redpanda",
    name: "Redpanda",
    image: "redpandadata/redpanda:latest",
    logo: gh("redpanda-data"),
    category: "queue",
    description: "Kafka-compatible streaming platform, no ZooKeeper or JVM.",
    ports: [9092, 9644],
    defaultVolumes: ["redpanda_data:/var/lib/redpanda/data"],
  },

  /* ── Object Storage ───────────────────────────────────────────────── */
  {
    id: "minio",
    name: "MinIO",
    image: "minio/minio:latest",
    logo: si("minio"),
    category: "storage",
    description: "S3-compatible object storage. Self-hosted alternative to AWS S3.",
    ports: [9000, 9001],
    defaultEnv: [
      { key: "MINIO_ROOT_USER", value: "minioadmin" },
      { key: "MINIO_ROOT_PASSWORD", value: "minioadmin" },
    ],
    defaultVolumes: ["minio_data:/data"],
  },

  /* ── Auth & Identity ──────────────────────────────────────────────── */
  {
    id: "keycloak",
    name: "Keycloak",
    image: "quay.io/keycloak/keycloak:latest",
    logo: si("keycloak"),
    category: "auth",
    description: "Full-featured open-source identity and access management.",
    ports: [8080],
    defaultEnv: [
      { key: "KEYCLOAK_ADMIN", value: "admin" },
      { key: "KEYCLOAK_ADMIN_PASSWORD", value: "" },
    ],
  },
  {
    id: "authentik",
    name: "Authentik",
    image: "ghcr.io/goauthentik/server:latest",
    logo: gh("goauthentik"),
    category: "auth",
    description: "Modern open-source identity provider with SAML, OAuth2, LDAP.",
    ports: [9000],
    defaultEnv: [
      { key: "AUTHENTIK_SECRET_KEY", value: "" },
      { key: "AUTHENTIK_POSTGRESQL__HOST", value: "postgres" },
      { key: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
      { key: "AUTHENTIK_POSTGRESQL__PASSWORD", value: "" },
      { key: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
      { key: "AUTHENTIK_REDIS__HOST", value: "redis" },
    ],
  },

  /* ── Mail & SMTP (dev) ────────────────────────────────────────────── */
  {
    id: "mailpit",
    name: "Mailpit",
    image: "axllent/mailpit:latest",
    logo: gh("axllent"),
    category: "mail",
    description: "SMTP catcher with web UI. Inspect outbound mail in development.",
    ports: [1025, 8025],
  },
  {
    id: "mailhog",
    name: "MailHog",
    image: "mailhog/mailhog:latest",
    logo: gh("mailhog"),
    category: "mail",
    description: "Classic SMTP catch-all for development environments.",
    ports: [1025, 8025],
  },

  /* ── Browsers & automation ────────────────────────────────────────── */
  {
    id: "browserless",
    name: "Browserless Chrome",
    image: "browserless/chrome:latest",
    logo: si("googlechrome"),
    category: "runtime",
    description: "Headless Chrome over HTTP/WS. For scraping, screenshots, PDF rendering.",
    ports: [3000],
    defaultEnv: [
      { key: "TOKEN", value: "" },
      { key: "MAX_CONCURRENT_SESSIONS", value: "10" },
      { key: "CONNECTION_TIMEOUT", value: "60000" },
    ],
  },
  {
    id: "playwright",
    name: "Playwright",
    image: "mcr.microsoft.com/playwright:latest",
    logo: si("playwright"),
    category: "runtime",
    description: "Browser automation across Chromium, Firefox, and WebKit.",
  },
];
