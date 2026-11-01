import { posix } from "node:path";

/** Conservative bounds for text configuration persisted in a service's JSONB row. */
import { MAX_GENERATED_CONFIG_FILES, MAX_GENERATED_CONFIG_PATH_BYTES, MAX_GENERATED_CONFIG_FILE_BYTES, MAX_GENERATED_CONFIG_TOTAL_BYTES } from "@repo/core";
export { MAX_GENERATED_CONFIG_FILES, MAX_GENERATED_CONFIG_PATH_BYTES, MAX_GENERATED_CONFIG_FILE_BYTES, MAX_GENERATED_CONFIG_TOTAL_BYTES };

export interface GeneratedConfigFile {
  path: string;
  content: string;
}

/**
 * Validate generated config before it can become either host state or a Docker
 * bind specification. This is deliberately repeated at the deploy boundary:
 * service rows can also originate from internal import/install paths or an older
 * database, rather than the current HTTP schema.
 */
export function assertValidGeneratedConfigFiles(
  value: unknown,
): asserts value is GeneratedConfigFile[] {
  if (!Array.isArray(value)) {
    throw new Error("generated-config-files-invalid");
  }
  if (value.length > MAX_GENERATED_CONFIG_FILES) {
    throw new Error(`generated-config-files-limit:${MAX_GENERATED_CONFIG_FILES}`);
  }

  const paths: string[] = [];
  let totalBytes = 0;

  for (const [index, file] of value.entries()) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof (file as GeneratedConfigFile).path !== "string" ||
      typeof (file as GeneratedConfigFile).content !== "string"
    ) {
      throw new Error(`generated-config-file-invalid:${index}`);
    }

    const { path, content } = file as GeneratedConfigFile;
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (
      path === "/" ||
      !path.startsWith("/") ||
      path.endsWith("/") ||
      posix.normalize(path) !== path ||
      /[:\u0000-\u001f\u007f]/u.test(path) ||
      pathBytes > MAX_GENERATED_CONFIG_PATH_BYTES
    ) {
      throw new Error(`generated-config-path-invalid:${index}`);
    }

    if (
      paths.some(
        (known) => path === known || path.startsWith(`${known}/`) || known.startsWith(`${path}/`),
      )
    ) {
      throw new Error(`generated-config-path-conflict:${path}`);
    }
    paths.push(path);

    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_GENERATED_CONFIG_FILE_BYTES) {
      throw new Error(`generated-config-file-too-large:${path}`);
    }
    totalBytes += contentBytes;
    if (totalBytes > MAX_GENERATED_CONFIG_TOTAL_BYTES) {
      throw new Error(`generated-config-files-too-large:${MAX_GENERATED_CONFIG_TOTAL_BYTES}`);
    }
  }
}
