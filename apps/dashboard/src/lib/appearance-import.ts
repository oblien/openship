import {
  APPEARANCE_MAX_BYTES,
  mergeAppearanceImport,
  type AppearancePreferences,
} from "@repo/core";
export function importAppearance(
  value: string,
  current: AppearancePreferences,
): AppearancePreferences {
  if (new TextEncoder().encode(value).length > APPEARANCE_MAX_BYTES)
    throw new Error("Theme JSON exceeds 1 MiB");
  return mergeAppearanceImport(JSON.parse(value), current);
}
/** Fetch in the browser with CORS. No server proxy, session cookie, or SSRF surface. */
export async function fetchAppearanceJson(address: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(address);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS theme JSON URL");
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Theme download returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > APPEARANCE_MAX_BYTES) throw new Error("Theme JSON exceeds 1 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function downloadTheme(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
