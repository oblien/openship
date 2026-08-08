import { InteractiveTerminal, type TerminalLine } from "./interactive-terminal";
import { SectionHeader } from "./section-header";
import styles from "./how-it-works.module.css";

type TerminalDemo = {
  step: string;
  title: string;
  description: string;
  command: string;
  lines: TerminalLine[];
};

const TERMINALS: TerminalDemo[] = [
  {
    step: "01",
    title: "Connect the project",
    description:
      "Link the current repository to its Openship project and production target. The link stays in the repo, so every later command knows where to deploy.",
    command: "openship init --project proj_storefront",
    lines: [
      { text: "→ Using context self-hosted", tone: "muted" },
      { text: "→ Linking project proj_storefront", tone: "accent" },
      { text: "✓ Linked storefront → .openship/project.json", tone: "success" },
    ],
  },
  {
    step: "02",
    title: "Build an immutable image",
    description:
      "A deploy reads the linked branch, builds away from production, runs the checks, and tags one versioned artifact before anything reaches your server.",
    command: "openship deploy --watch",
    lines: [
      { text: "◐ Triggering deployment", tone: "accent" },
      { text: "✓ Deployment queued: dep_7f3a", tone: "success" },
      { text: "→ Reading main at 9c4e1f2", tone: "muted" },
      { text: "→ Building image on this machine" },
      { text: "✓ Tests passed · image storefront:9c4e1f2", tone: "success" },
    ],
  },
  {
    step: "03",
    title: "Ship and route",
    description:
      "The finished image crosses SSH, starts on a private network, passes its health check, and receives TLS before traffic switches over.",
    command: "openship logs dep_7f3a --follow",
    lines: [
      { text: "→ Streaming image to srv_lon_01 over SSH", tone: "accent" },
      { text: "→ Starting container on private network" },
      { text: "✓ Health check passed on :3000", tone: "success" },
      { text: "✓ TLS ready · traffic switched", tone: "success" },
      { text: "✓ https://storefront.opsh.io", tone: "success" },
    ],
  },
  {
    step: "04",
    title: "Operate without lock-in",
    description:
      "Logs, status, and rollback use the same CLI and the same deployment history. A previous healthy artifact can take traffic again without rebuilding.",
    command: "openship deployment rollback dep_6e91",
    lines: [
      { text: "→ Found healthy artifact storefront:6e91b4c", tone: "muted" },
      { text: "→ Starting previous container", tone: "accent" },
      { text: "→ Switching OpenResty upstream" },
      { text: "✓ Rolled back to dep_6e91", tone: "success" },
      { text: "✓ No requests dropped", tone: "success" },
    ],
  },
];

export function HowItWorks({ index, total }: { index: number; total: number }) {
  return (
    <section id="how-it-works" className="lp-sec">
      <SectionHeader label="How it works" index={index} total={total} />

      <div className="lp-band">
        <div className="lp-band-in">
          <div className={styles.headline}>
            <h2 className={styles.headlineTitle}>
              From git push to live,<br />on your infrastructure.
            </h2>
            <p className={styles.headlineSub}>
              Edit a command, press Enter, and watch the real Openship workflow move
              through linking, building, SSH delivery, routing, and rollback.
            </p>
          </div>
        </div>
      </div>

      <div className="lp-band">
        <div className="lp-band-in lp-band-in--flush">
          <div className={styles.terminalGrid}>
            {TERMINALS.map((terminal) => (
              <article className={styles.terminalCard} key={terminal.step}>
                <div className={styles.terminalStage}>
                  <InteractiveTerminal
                    title={terminal.title}
                    command={terminal.command}
                    lines={terminal.lines}
                  />
                </div>
                <div className={styles.terminalCopy}>
                  <span className={styles.step}>{terminal.step}</span>
                  <div>
                    <h3 className={styles.terminalTitle}>{terminal.title}</h3>
                    <p className={styles.terminalDescription}>{terminal.description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
