import type { Copy } from "@/i18n/copy";
import styles from "./capabilities.module.css";

// The sample projects match the import reviews shown in the two migration guides.
const samples = [
  {
    provider: "Railway",
    app: { name: "Storefront API", logo: "/app-logos/nodejs.svg", kind: "service", action: "Deploy from source" },
    dependencies: [
      { name: "PostgreSQL", logo: "/app-logos/postgresql.svg", kind: "postgres", action: "Copy persistent volume" },
      { name: "Redis", logo: "/app-logos/redis.png", kind: "redis", action: "Copy persistent volume" },
    ],
  },
  {
    provider: "Vercel",
    app: { name: "Storefront", logo: "/provider-logos/github.svg", kind: "service", action: "Deploy from source" },
    dependencies: [
      { name: "PostgreSQL", logo: "/app-logos/postgresql.svg", kind: "postgres", action: "Copy database" },
    ],
  },
] as const;

export function MigrationPreview({ copy }: { copy: Copy }) {
  type Sample = (typeof samples)[number];
  function node(service: Sample["app"] | Sample["dependencies"][number]) {
    return (
      <article className={styles.card} data-kind={service.kind}>
        <span className={styles.cardIcon}>
          <img src={service.logo} alt="" width={22} height={22} loading="lazy" />
        </span>
        <div className={styles.cardLabel}>
          <h3>{service.name}</h3>
          <p>{copy(service.action)}</p>
        </div>
      </article>
    );
  }
  return (
    <fieldset className={styles.preview}>
      <legend className="sr-only">{copy("Sample import")}</legend>
      <div className={styles.route}>
        <div className={styles.sources}>
          {samples.map(({ provider }, index) => (
            <label key={provider}>
              <input className="sr-only" type="radio" name="migration-preview-source" value={provider} defaultChecked={index === 0} />
              <img src={`/provider-logos/${provider.toLowerCase()}.svg`} alt="" width={17} height={17} />
              <bdi>{provider}</bdi>
            </label>
          ))}
        </div>
        <span className={styles.connector} aria-hidden="true" />
        <span className={styles.destination} dir="ltr"><i aria-hidden="true" />OpenShip Cloud</span>
      </div>
      <div className={styles.board}>
        <div className={styles.boardHeading}>
          <bdi>Storefront</bdi>
          <span>{copy("Sample import")}</span>
        </div>
        <div className={styles.canvas} role="group" aria-label={copy("Project topology")}>
          {samples.map(({ provider, app, dependencies }) => (
            <div key={provider} data-source={provider} className={styles.graph} role="group" aria-label={provider}>
              <div className={styles.sourceNode}>{node(app)}</div>
              <ul className={styles.branches}>
                {dependencies.map((service) => <li key={service.name}>{node(service)}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
