import type { AppLocale } from "@repo/core/locale";
import type { Copy } from "@/i18n/copy";
import { localizedHref } from "@/i18n/routing";
import { FEATURES, CATEGORY_ORDER, CATEGORY_BLURB } from "./features";
import {
  COMPARISONS,
  COMPARISONS_REVIEWED_AT,
  comparisonName,
  comparisonRows,
} from "./comparisons";
import {
  CONTROL_PLANE_MODES,
  PRODUCT_ADVANTAGES,
  PRODUCT_QUESTIONS,
  PRODUCT_SUMMARY,
} from "./product";
import { SITE_URL } from "./sitemap-builder";

/** Explicit public pages only: this is never a filesystem or URL proxy. */
export const PRODUCT_MARKDOWN_PATHS = [
  "/features",
  ...FEATURES.map(({ slug }) => `/features/${slug}`),
  "/compare",
  ...COMPARISONS.map(({ slug }) => `/compare/${slug}`),
];

export function productMarkdown(path: string, copy: Copy, locale: AppLocale): string | undefined {
  if (!PRODUCT_MARKDOWN_PATHS.includes(path)) return undefined;
  const url = (href: string) => SITE_URL + localizedHref(href, locale);
  const link = (title: string, href: string) => `[${copy(title)}](${url(href)})`;
  const modes = CONTROL_PLANE_MODES.map(
    (mode) =>
      `### ${copy(mode.title)}\n\n${copy(mode.description)}\n\n${link("Get started", mode.href)}`,
  ).join("\n\n");
  const questions = PRODUCT_QUESTIONS.map(
    ({ question, answer }) => `### ${copy(question)}\n\n${copy(answer)}`,
  ).join("\n\n");
  const introduction = `${copy(PRODUCT_SUMMARY)}\n\n## ${copy("Three ways to run OpenShip")}\n\n${modes}`;
  const heading = (title: string) => `# ${title}\n\nURL: ${url(path)}\n\n`;

  if (path === "/features") {
    return (
      heading(copy("Platform features")) +
      introduction +
      "\n\n" +
      CATEGORY_ORDER.map(
        (category) =>
          `## ${copy(category)}\n\n${copy(CATEGORY_BLURB[category])}\n\n` +
          FEATURES.filter((feature) => feature.category === category)
            .map(
              (feature) =>
                `- [${copy(feature.title)}](${url(`/features/${feature.slug}`)}.md): ${copy(feature.tagline)}`,
            )
            .join("\n"),
      ).join("\n\n") +
      `\n\n## ${copy("Know the platform")}\n\n${questions}\n`
    );
  }
  const feature = FEATURES.find((item) => path === `/features/${item.slug}`);
  if (feature) {
    return (
      heading(copy(feature.title)) +
      [
        copy(feature.tagline),
        copy(feature.summary),
        ...feature.body.map((p) => copy(p)),
        ...feature.highlights.map((item) => `## ${copy(item.title)}\n\n${copy(item.desc)}`),
        ...(feature.availability ? [copy(feature.availability)] : []),
        link("Read the guide", feature.guide),
      ].join("\n\n") +
      "\n"
    );
  }
  if (path === "/compare") {
    return (
      heading(copy("Compare OpenShip with other deployment platforms")) +
      introduction +
      "\n\n" +
      Object.values(PRODUCT_ADVANTAGES)
        .map(
          (item) =>
            `## ${copy(item.title)}\n\n${copy(item.description)}\n\n${link("Explore this capability", `/features/${item.feature}`)}`,
        )
        .join("\n\n") +
      `\n\n## ${copy("All comparisons")}\n\n` +
      COMPARISONS.map(
        (item) =>
          `- [${copy("OpenShip vs {name}", { name: comparisonName(item, copy) })}](${url(`/compare/${item.slug}`)}.md): ${copy(item.summary)}`,
      ).join("\n") +
      "\n"
    );
  }
  const item = COMPARISONS.find((item) => path === `/compare/${item.slug}`)!;
  const name = comparisonName(item, copy);
  const cell = (value: string) => copy(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  return (
    heading(copy("OpenShip vs {name}", { name })) +
    [
      copy(item.summary),
      link("Migrate to OpenShip", item.migration.href),
      `## ${copy("Why choose OpenShip")}\n\n${copy(item.reason)}`,
      ...item.advantages.map((key) => {
        const advantage = PRODUCT_ADVANTAGES[key];
        return `### ${copy(advantage.title)}\n\n${copy(advantage.description)}\n\n${link("Explore this capability", `/features/${advantage.feature}`)}`;
      }),
      `## ${copy("The practical differences")}\n\n| ${copy("What matters")} | OpenShip | ${name} |\n| --- | --- | --- |\n` +
        comparisonRows(item)
          .map((row) => `| ${cell(row.label)} | ${cell(row.ours)} | ${cell(row.theirs)} |`)
          .join("\n"),
      `## ${copy("Three ways to run OpenShip")}\n\n${modes}`,
      `## ${copy("Where {name} fits", { name })}\n\n${copy(item.strength)}`,
      `## ${copy("Plan your move")}\n\n${copy(item.migration.method)}\n\n${copy(item.migration.preparation)}\n\n${link("Open migration guide", item.migration.href)}`,
      `## ${copy("Check the details")}\n\n${copy("Reviewed on {date}", { date: COMPARISONS_REVIEWED_AT })}\n\n` +
        item.sources.map((source) => `- [${copy(source.title)}](${source.href})`).join("\n"),
      link("OpenShip documentation", "/docs"),
    ].join("\n\n") +
    "\n"
  );
}
