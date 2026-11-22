import { getLocale } from "next-intl/server";
import { getCopy } from "@/i18n/copy-server";
import { CardMarquee, MarqueeHeading } from "./card-marquee";
import styles from "./community-stories.module.css";

const github = "https://github.com/oblien/openship";
const milestones = [
  { count: 15_000, label: "GitHub stars", href: github + "/stargazers" },
  { count: 2_600_000, label: "launch post views", href: "https://x.com/openshipio/status/2078143909125923137" },
];

const stargazers = [
  { company: "Microsoft", mark: "/provider-logos/microsoft.svg", profile: "edemkumodzi" },
  { company: "Google DeepMind", mark: "/provider-logos/google-deepmind.png", profile: "cameronking4" },
  { company: "Ultralytics", mark: "/provider-logos/ultralytics.png", profile: "fcakyon" },
  { company: "Cloudflare", mark: "/provider-logos/cloudflare.svg", profile: "NuroDev" },
  { company: "Shopify", mark: "/provider-logos/shopify.svg", profile: "amir-s" },
  { company: "Salesforce", mark: "/provider-logos/salesforce.svg", profile: "tejeirodelrio" },
  { company: "SAP", mark: "/provider-logos/sap.svg", profile: "cyb3rko" },
  { company: "Supabase", mark: "/app-logos/supabase.svg", profile: "apdarr" },
];

const quotes = [
  {
    words: "Openship gives you the same push-to-deploy experience, except it runs on your own servers.",
    author: "r/BestGitHubRepos",
    avatar: "/community/reddit.webp",
    platform: "Reddit",
    href: "https://www.reddit.com/r/BestGitHubRepos/comments/1wvs391/openship_is_a_selfhosted_deployment_platform_that/",
  },
  {
    words: "I can genuinely see myself using it for some of my own projects in the future.",
    author: "@ValenFelizia",
    avatar: "/community/valenfelizia.webp",
    platform: "GitHub",
    href: github + "/issues/92#issuecomment-5050260008",
  },
  {
    words: "The whole premise of easy migration/moving between servers sounds very promising.",
    author: "@Knyntsje",
    avatar: "/community/knyntsje.webp",
    platform: "GitHub",
    href: github + "/issues/264",
  },
];

export async function CommunityStories() {
  const copy = await getCopy();
  const compact = new Intl.NumberFormat(await getLocale(), { notation: "compact" });
  return (
    <section aria-labelledby="community-heading" className="py-14 sm:py-20">
      <MarqueeHeading id="community-heading" title={copy("What developers are saying")}>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {milestones.map(({ count, label, href }) => (
            <a key={label} href={href} className="text-sm th-text-body hover:underline">
              <strong className="block text-2xl font-medium tracking-tight th-text-heading">
                <bdi>{compact.format(count)}+</bdi>
              </strong>
              {copy(label)}
            </a>
          ))}
        </div>
      </MarqueeHeading>
      <div className="site-container">
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <p className="text-sm th-text-body">{copy("Starred on GitHub by developers at")}</p>
          <ul className="grid grid-cols-[repeat(2,max-content)] items-center gap-x-5 gap-y-2 sm:grid-cols-[repeat(4,max-content)] xl:flex xl:flex-wrap">
            {stargazers.map(({ company, mark, profile }) => (
              <li key={company}>
                <a dir="ltr" href={`https://github.com/${profile}?tab=stars&q=openship`} className="flex items-center gap-2 font-medium th-text-strong hover:underline">
                  <img src={mark} alt="" width={20} height={20} className="size-5 object-contain" />
                  {company}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <CardMarquee id="community-quotes" dir="ltr" renderCards={(duplicate) =>
        quotes.map(({ words, author, avatar, platform, href }) => (
          <figure key={href} className={styles.card} lang="en">
            <figcaption className={styles.byline}>
              <a className={styles.source} href={href} tabIndex={duplicate ? -1 : undefined}>
                <img src={avatar} width={48} height={48} alt="" fetchPriority="low" decoding="async" />
                <span>
                  <span className={styles.author}>{author}</span>
                  <span className={styles.platform}>{platform} <span aria-hidden="true">↗</span></span>
                </span>
              </a>
              <span aria-hidden="true" className={styles.mark}>“</span>
            </figcaption>
            <blockquote className={styles.quote} cite={href}>{words}</blockquote>
          </figure>
        ))
      } />
    </section>
  );
}
