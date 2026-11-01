import type { CSSProperties } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { extToLangMap } from "@/utils/extToLang.js";

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff"]);
const archiveExtensions = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]);
const textExtensions = new Set(["txt", "md", "mdx", "rst", "pdf", "doc", "docx", "rtf"]);
const textLanguages = new Set(["plaintext", "text", "markdown", "mdx", "restructuredtext"]);

/** File categories share the UI catalog; unknown files always have a glyph. */
export function fileIconName(fileName: string, language?: string): IconName {
  const baseName = fileName.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const extension = baseName.includes(".") ? baseName.split(".").at(-1)! : "";
  if (imageExtensions.has(extension)) return "file-image";
  if (archiveExtensions.has(extension)) return "file-archive";
  if (textExtensions.has(extension)) return "file-text";
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.") || language?.toLowerCase() === "dockerfile") return "docker";
  if (language && textLanguages.has(language.toLowerCase())) return "file-text";
  if (Object.hasOwn(extToLangMap, extension) || language) return "file-code";
  return "file";
}

export default function FileIcon({
  language,
  fileName = "",
  style,
}: {
  language?: string;
  fileName?: string;
  style?: CSSProperties;
}) {
  return <Icon name={fileIconName(fileName, language)} size={16} className="me-1 shrink-0 text-muted-foreground" style={style} />;
}
