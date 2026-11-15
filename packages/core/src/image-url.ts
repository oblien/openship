/** Image URLs are displayed by the browser, never fetched by the control plane. */
export const MAX_IMAGE_URL_LENGTH = 2048;

export function isImageUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^https?:\/\//i.test(value) ||
    value.length > MAX_IMAGE_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** One precedence rule for every project and deployment presentation. */
export function projectIconUrl(
  project: { iconUrl?: string | null; favicon?: string | null } | null | undefined,
): string | null {
  return project?.iconUrl || project?.favicon || null;
}
