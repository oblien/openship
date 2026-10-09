import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Include complete license/notice texts for the modules linked into our binaries. */
export function runnerNotices(directory, modfile, targets) {
  const modules = new Map();
  for (const [os, arch] of targets) {
    const list = spawnSync(
      "go",
      [
        "list",
        `-modfile=${modfile}`,
        "-deps",
        "-f",
        "{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}{{end}}",
        ".",
      ],
      {
        cwd: directory,
        env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (list.status !== 0)
      throw new Error(list.stderr || "Cannot inventory Actions runner licenses");
    for (const line of list.stdout.split(/\r?\n/).filter(Boolean)) {
      const [path, version, dir] = line.split("\t");
      modules.set(path, { version, dir });
    }
  }
  const notices = [readFileSync(join(directory, "NOTICE"), "utf8")];
  for (const [path, module] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    const files = readdirSync(module.dir, { withFileTypes: true }).filter(
      (file) => file.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)/i.test(file.name),
    );
    if (!files.length)
      throw new Error(`Review the missing license for ${path} before distributing the runner`);
    notices.push(`\n${"=".repeat(72)}\n${path} ${module.version}\n`);
    for (const file of files)
      notices.push(`${file.name}\n${readFileSync(join(module.dir, file.name), "utf8")}\n`);
  }
  return notices.join("\n");
}
