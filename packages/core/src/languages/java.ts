import type { LanguageDetector, PortDetectionContext } from "./types";

/**
 * Java / Kotlin (JVM) - `pom.xml` (Maven) and `build.gradle` / `build.gradle.kts`
 * (Gradle) mark the language. We don't extract a dep map from either format
 * (no Maven XML parser, no Gradle DSL parser) - those manifests are surfaced
 * here so the prepare service fetches them, and the stack detector relies on
 * STACKS `contentPatterns` to identify Spring Boot / Quarkus / Kotlin directly
 * from the manifest text.
 *
 * `application.properties` / `application.yml` are surfaced too so port
 * detection can read an explicitly configured `server.port`.
 *
 * If Java dep extraction becomes worthwhile (e.g. for a Java framework whose
 * detection rule can't be expressed in `contentPatterns`), implement parsers
 * here and the registry plumbing requires no other changes.
 */
function parseJavaManifest(_filename: string, _content: string): Record<string, string> {
  return {};
}

function clampPort(raw: string): number | null {
  const port = parseInt(raw, 10);
  return port > 0 && port <= 65535 ? port : null;
}

const YAML_PORT_RE = /^port:\s*["']?(\d{2,5})/;

/**
 * `server.port` from a YAML document: the `port:` scalar that is a direct child
 * of a top-level `server:` mapping, in block or flow form. Returns null when the
 * document has no such key.
 */
function springYamlPort(yml: string): string | null {
  const inline = yml.match(/^server:\s*\{[^}]*\bport:\s*["']?(\d{2,5})/m);
  if (inline) return inline[1]!;

  let inServer = false;
  let childIndent: number | null = null;
  for (const raw of yml.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (inServer) {
      if (indent > 0) {
        if (childIndent === null) childIndent = indent;
        if (indent === childIndent) {
          const m = trimmed.match(YAML_PORT_RE);
          if (m) return m[1]!;
        }
        continue;
      }
      inServer = false;
    }

    if (indent === 0 && /^server:$/.test(trimmed)) {
      inServer = true;
      childIndent = null;
    }
  }
  return null;
}

/**
 * Recover the port from Spring-style config. `server.port=9090` in
 * application.properties, or a `server:\n  port: 9090` block (or a top-level
 * bare `port:`) in application.yml/yaml.
 *
 * Deliberately does NOT match `server.port=${PORT:8080}` — when the app reads
 * the port from an env var the runtime already injects `PORT`, so the stack's
 * default is correct and we return null.
 */
function detectJavaPort(context: PortDetectionContext): number | null {
  const fc = context.fileContents;
  if (!fc) return null;

  const props = fc["application.properties"];
  if (props) {
    const m = props.match(/^\s*server\.port\s*=\s*(\d{2,5})\s*$/m);
    if (m) return clampPort(m[1]);
  }

  for (const name of ["application.yml", "application.yaml"]) {
    const yml = fc[name];
    if (!yml) continue;
    const port = springYamlPort(yml) ?? yml.match(/^port:\s*["']?(\d{2,5})/m)?.[1];
    if (port) return clampPort(port);
  }

  return null;
}

export const javaLanguageDetector: LanguageDetector = {
  id: "java",
  label: "Java / Kotlin",
  manifestFiles: [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "application.properties",
    "application.yml",
    "application.yaml",
  ],
  parseManifest: parseJavaManifest,
  detectPort: detectJavaPort,
};
