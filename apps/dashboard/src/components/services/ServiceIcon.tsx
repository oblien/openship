"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import { AppLogo } from "@/components/AppLogo";

/**
 * The icon for one service row/panel.
 *
 * Recognized images use their brand mark. Otherwise, the service's role selects
 * a catalog icon, regardless of whether it builds from source or pulls an image.
 * AppLogo uses the same role icon if its brand artwork cannot load.
 */

/**
 * Docker image (repo part, tag stripped) → simpleicons brand slug.
 *
 * Matched against the LAST path segment so `docker.io/library/postgres`,
 * `bitnami/postgresql` and `postgres` all land on the same mark. Longest key
 * first at match time, so `postgresql` doesn't get shadowed by `postgres`.
 */
const IMAGE_BRAND: Record<string, string> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  pgvector: "postgresql",
  timescaledb: "timescale",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  mongodb: "mongodb",
  redis: "redis",
  valkey: "valkey",
  memcached: "memcached",
  rabbitmq: "rabbitmq",
  kafka: "apachekafka",
  nats: "natsdotio",
  elasticsearch: "elasticsearch",
  opensearch: "opensearch",
  meilisearch: "meilisearch",
  typesense: "typesense",
  qdrant: "qdrant",
  clickhouse: "clickhouse",
  cassandra: "apachecassandra",
  couchdb: "apachecouchdb",
  influxdb: "influxdb",
  minio: "minio",
  nginx: "nginx",
  openresty: "nginx",
  caddy: "caddy",
  traefik: "traefikproxy",
  haproxy: "haproxy",
  varnish: "varnish",
  grafana: "grafana",
  prometheus: "prometheus",
  loki: "grafana",
  n8n: "n8n",
  supabase: "supabase",
  keycloak: "keycloak",
  vault: "vault",
  consul: "consul",
  gitea: "gitea",
  jenkins: "jenkins",
  sonarqube: "sonarqube",
  wordpress: "wordpress",
  ghost: "ghost",
  directus: "directus",
  nocodb: "nocodb",
  metabase: "metabase",
  strapi: "strapi",
  plausible: "plausibleanalytics",
  umami: "umami",
  mailhog: "maildotru",
  node: "nodedotjs",
  bun: "bun",
  python: "python",
  golang: "go",
  php: "php",
  ruby: "ruby",
  rust: "rust",
  openjdk: "openjdk",
  nextcloud: "nextcloud",
  jellyfin: "jellyfin",
  uptimekuma: "uptimekuma",
  "uptime-kuma": "uptimekuma",
};

/** Role fallbacks, keyed by what the NAME suggests when the image is unknown. */
const NAME_ROLE: Array<{ re: RegExp; icon: IconName }> = [
  { re: /(^|[-_])(db|database|postgres|pg|mysql|maria|mongo|sql)([-_]|$)/i, icon: "database" },
  { re: /(^|[-_])(cache|redis|valkey|memcache)([-_]|$)/i, icon: "database" },
  { re: /(^|[-_])(search|index|elastic|meili|typesense)([-_]|$)/i, icon: "search" },
  { re: /(^|[-_])(queue|worker|jobs?|cron|scheduler|consumer)([-_]|$)/i, icon: "workflow" },
  { re: /(^|[-_])(mail|smtp|mailer)([-_]|$)/i, icon: "mail" },
  { re: /(^|[-_])(api|backend|server|gateway)([-_]|$)/i, icon: "server" },
  { re: /(^|[-_])(web|www|site|frontend|dashboard|app|ui)([-_]|$)/i, icon: "globe" },
];

/** The image's bare repo name: `ghcr.io/oblien/openship-api:0.3.0` → `openship-api`. */
function imageName(image: string | null | undefined): string {
  if (!image) return "";
  const noTag = image.split("@")[0]!.replace(/:[^/:]+$/, "");
  return (noTag.split("/").pop() ?? "").toLowerCase();
}

/** simpleicons slug for this image, or null when we don't recognize it. */
export function brandSlugForImage(image: string | null | undefined): string | null {
  const name = imageName(image);
  if (!name) return null;
  if (IMAGE_BRAND[name]) return IMAGE_BRAND[name]!;
  // Suffixed/prefixed variants: `postgres-16`, `my-redis`, `bitnami-mongodb`.
  const keys = Object.keys(IMAGE_BRAND).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => name.includes(k));
  return hit ? IMAGE_BRAND[hit]! : null;
}

export function ServiceIcon({
  service,
  className = "size-[18px]",
}: {
  service: {
    name: string;
    image?: string | null;
    build?: string | null;
    kind?: "compose" | "monorepo";
    exposed?: boolean;
  };
  className?: string;
}) {
  const roleIcon = NAME_ROLE.find((r) => r.re.test(service.name))?.icon ??
    (service.exposed ? "globe" : "window");
  const brand = brandSlugForImage(service.image);
  if (brand) {
    return <AppLogo slug={brand} className={className} icon={roleIcon} />;
  }

  return <UiIcon name={roleIcon} className={`${className} text-muted-foreground`} />;
}
