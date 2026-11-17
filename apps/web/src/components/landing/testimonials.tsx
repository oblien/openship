import { useCopy } from "@/i18n/use-copy";

/* Public posts on X, quoted word for word and linked to the original.
   Quotes stay in the language they were written in, so they are not
   passed through the translation catalog. */
const QUOTES = [
  {
    name: "Chris Burrett-Bijlstra",
    handle: "christiaan_bb",
    href: "https://x.com/christiaan_bb/status/2086118312677642680",
    quote:
      "Migrated all my projects from @coolifyio to @openshipio today as I am really liking the velocity of their product.",
  },
  {
    name: "AMEEN",
    handle: "onerandomd3v",
    href: "https://x.com/onerandomd3v/status/2091402550348013700",
    quote:
      "ngl @openshipio might be the best open source project i’ve used. ui/ux is actually clean, deploys just work, no yaml headaches.",
  },
  {
    name: "Vinny",
    handle: "hot_town",
    href: "https://x.com/hot_town/status/2079940632080986573",
    quote:
      "I deployed Open SaaS to OpenShip (@openshipio)! It was my first time successfully self-hosting an app on a Hetzner VPS.",
  },
  {
    name: "Basab Jha",
    handle: "BasabJha_",
    href: "https://x.com/BasabJha_/status/2079039864025362572",
    quote:
      "hey @openshipio, thank you for existing. we’ve shifted from resend to OpenShip at @sagea_ai",
  },
  {
    name: "Kareem Safwat",
    handle: "Sf_Kareem",
    href: "https://x.com/Sf_Kareem/status/2108667912169144719",
    quote: "Just moved my sites to Openship Cloud (Hobby), loving it.",
  },
  {
    name: "Toivo Mattila",
    handle: "ToivoMattila",
    href: "https://x.com/ToivoMattila/status/2085980529174732819",
    quote:
      "OpenShip set up was incredibly easy and I was in the OpenShip dashboard in no time",
  },
  {
    name: "Rish",
    handle: "rishflips",
    href: "https://x.com/rishflips/status/2080244273270890823",
    quote:
      "it feels like someone finally built the exact tool I was wishing for every time I finished an app",
  },
  {
    name: "Marcos Placona",
    handle: "marcos_placona",
    href: "https://x.com/marcos_placona/status/2105199781760930225",
    quote: "Not associated, I just really like @openshipio",
  },
  {
    name: "Timidan",
    handle: "Timidan_x",
    href: "https://x.com/Timidan_x/status/2118413828576641526",
    quote: "my self hosted @openshipio at home is now running some of my apps",
  },
  {
    name: "Hatem Hosny",
    handle: "hatem_hosny_",
    href: "https://x.com/hatem_hosny_/status/2082480818430079289",
    quote: "OpenShip is changing the self-hosting game. Impressive!",
  },
] satisfies { name: string; handle: string; href: string; quote: string }[];

const STATS = [
  { value: "500+", label: "Cloud customers" },
  { value: "80,000+", label: "Self-hosters" },
  { value: "15,000+", label: "GitHub stars" },
];

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Testimonials() {
  const copy = useCopy();
  const viewLabel = copy("View post on X");

  /* The row is rendered twice so the loop has no visible seam. The second
     copy is hidden from assistive tech and from keyboard focus. */
  const renderCards = (duplicate: boolean) =>
    QUOTES.map((item) => (
      <li key={item.handle} className="tm-card" aria-hidden={duplicate || undefined}>
        <div className="tm-author">
          <img
            className="tm-avatar"
            src={`/testimonials/${item.handle.toLowerCase().replace(/_+$/, "")}.jpg`}
            alt=""
            width={44}
            height={44}
            decoding="async"
          />
          <div className="tm-who">
            <bdi className="tm-name">{item.name}</bdi>
            <bdi className="tm-handle">@{item.handle}</bdi>
          </div>
          <a
            className="tm-source"
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${viewLabel}: ${item.name}`}
            tabIndex={duplicate ? -1 : undefined}
          >
            <XLogo />
          </a>
        </div>
        <blockquote lang="en">
          <p>{item.quote}</p>
        </blockquote>
      </li>
    ));

  return (
    <section id="testimonials" className="tm-section" aria-labelledby="tm-title">
      <div className="site-container">
        <div className="tm-head">
          <div>
            <p className="tm-eyebrow">{copy("Trusted by developers")}</p>
            <h2 id="tm-title" className="tm-title">
              {copy("What developers say about OpenShip")}
            </h2>
          </div>
          <dl className="tm-stats">
            {STATS.map((stat) => (
              <div key={stat.label} className="tm-stat">
                <dt>{copy(stat.label)}</dt>
                <dd>
                  <bdi>{stat.value}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="tm-marquee" dir="ltr">
        <ul className="tm-track" aria-label={copy("Developer quotes")}>
          {renderCards(false)}
          {renderCards(true)}
        </ul>
      </div>
    </section>
  );
}
