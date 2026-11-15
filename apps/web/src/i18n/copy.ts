import type { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Stable catalog identifiers keep the public English source readable at call sites. */
export function messageKey(source: string): string {
  let hash = 2166136261;
  // Cached release text may still contain the older display casing.
  for (const character of source
    .replace(/\bOpenship\b/g, "OpenShip")
    .trim()
    .replace(/\s+/g, " ")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `m${(hash >>> 0).toString(36)}`;
}

export type Copy = {
  <T>(value: T, values?: Record<string, string | number>): T;
  rich(
    source: string,
    values: Record<string, string | number | ((children: ReactNode) => ReactNode)>,
  ): ReactNode;
};

const technicalFields = new Set([
  "id",
  "slug",
  "slugs",
  "href",
  "url",
  "src",
  "image",
  "images",
  "logo",
  "logos",
  "code",
  "command",
  "commands",
  "shell",
  "repository",
  "protocol",
  "transport",
  "category",
  "@type",
  "@context",
  "@id",
  "type",
  "rel",
  "unitCode",
  "priceCurrency",
  "currency",
  "inLanguage",
]);

export function createCopy(t: ReturnType<typeof useTranslations>): Copy {
  const copy = <T>(value: T, values?: Record<string, string | number>): T => {
    if (typeof value !== "string" || !value.trim()) return value;
    const key = messageKey(value);
    if (!t.has(key)) return value;
    const prefix = value.match(/^\s*/)?.[0] ?? "";
    const suffix = value.match(/\s*$/)?.[0] ?? "";
    const translated = values ? t(key, values) : t.raw(key);
    return typeof translated === "string" ? (`${prefix}${translated}${suffix}` as T) : value;
  };
  return Object.assign(copy, {
    rich: (source: string, values: Parameters<Copy["rich"]>[1]) =>
      t.rich(messageKey(source), values),
  });
}

/** Translate public presentation data without mutating shared module constants. */
export function translateCopyData<T>(value: T, copy: Copy): T {
  if (typeof value === "string") return copy(value);
  if (Array.isArray(value)) return value.map((item) => translateCopyData(item, copy)) as T;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !("$$typeof" in value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        technicalFields.has(key) ? entry : translateCopyData(entry, copy),
      ]),
    ) as T;
  }
  return value;
}
