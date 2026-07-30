import { stripXmlComments } from "./comments";
import type { WorkspaceDetector } from "./types";

/**
 * Maven multi-module projects - root `pom.xml` declares a `<modules>` block
 * with one `<module>name</module>` per child project:
 *
 *     <project>
 *       <packaging>pom</packaging>
 *       <modules>
 *         <module>app</module>
 *         <module>services/api</module>
 *       </modules>
 *     </project>
 *
 * Returns `[]` for a plain single-module pom.xml.
 *
 * Implementation note: we scope module extraction to the first `<modules>...</modules>`
 * block so we don't accidentally pick up modules listed under `<profiles>` or
 * other irrelevant places. This is the dominant real-world shape; profile-only
 * monorepos are rare. `<!-- … -->` comments are stripped first, so a
 * commented-out `<module>` is not read as a declared one.
 */
function parsePomXml(content: string): string[] {
  const modulesBlock = stripXmlComments(content).match(/<modules\b[^>]*>([\s\S]*?)<\/modules>/i);
  if (!modulesBlock) return [];

  const moduleEntries = modulesBlock[1].matchAll(/<module\b[^>]*>\s*([\s\S]*?)\s*<\/module>/gi);
  const paths: string[] = [];
  for (const match of moduleEntries) {
    const value = match[1].trim();
    if (value) paths.push(value);
  }
  return paths;
}

export const mavenWorkspaceDetector: WorkspaceDetector = {
  id: "maven",
  label: "Maven",
  manifestFiles: ["pom.xml"],
  packageManager: "maven",
  parseSubProjects: parsePomXml,
};
