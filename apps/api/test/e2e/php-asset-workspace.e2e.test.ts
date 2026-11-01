/** Execute the generated PHP asset stage with an installer-created stylesheet.
 * The fixture builder supplies Composer's output without compiling PHP extensions;
 * the Node asset stage and its COPY/RUN instructions come from the real recipe. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { BuildConfig } from "@repo/adapters";
import { generateDockerfile } from "../../../../packages/adapters/src/runtime/docker-build-plan";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const dockerEnv = { ...process.env, DOCKER_HOST: `unix://${dockerSocketPath}` };

describeDockerE2E("PHP dependency assets reach the generated Node stage", () => {
  it.each([
    { rootDirectory: "", vendor: "vendor" },
    { rootDirectory: "apps/web", vendor: "packages/php" },
  ])(
    "builds a stylesheet in $rootDirectory with dependencies in $vendor",
    async ({ rootDirectory, vendor }) => {
      await requireDocker();
      const dir = await mkdtemp(join(tmpdir(), "openship-php-assets-"));
      const image = `openship-test-php-assets:${randomUUID()}`;
      try {
        const recipe = generateDockerfile({
          buildImage: "php:8.4-cli",
          runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
          installCommand: "composer install",
          buildCommand: "node build.cjs",
          startCommand: "frankenphp run",
          stack: "laravel",
          packageManager: "composer",
          rootDirectory,
          outputDirectory: "public",
          port: 8000,
          envVars: {},
        } as BuildConfig);
        const start = recipe.indexOf("FROM node:");
        const end = recipe.indexOf("\nFROM ", start + 1);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const assets = recipe.slice(start, end);
        const assetImage = assets.match(/^FROM (\S+) AS assets/)![1];
        const sourceDir = join(dir, rootDirectory);
        await mkdir(sourceDir, { recursive: true });
        const cssPath = `${vendor}/acme/theme.css`;
        await writeFile(
          join(sourceDir, "build.cjs"),
          `
        const fs = require('node:fs');
        const css = fs.readFileSync(${JSON.stringify(cssPath)}, 'utf8');
        fs.mkdirSync('public', {recursive:true});
        fs.writeFileSync('public/bundle.css', css);
      `,
        );
        const installed = [rootDirectory, cssPath].filter(Boolean).join("/");
        await writeFile(
          join(dir, "install.cjs"),
          `
        const fs = require('node:fs');
        const path = require('node:path');
        const target = ${JSON.stringify(installed)};
        fs.mkdirSync(path.dirname(target), {recursive:true});
        fs.writeFileSync(target, '.composer-package { color: green; }');
      `,
        );
        // Dependencies are created only inside builder, never in the source context.
        await writeFile(
          join(dir, "Dockerfile"),
          `FROM ${assetImage} AS builder
WORKDIR /workspace
COPY . /workspace
RUN node install.cjs
${assets}
`,
        );
        await exec("docker", ["build", "--target", "assets", "-t", image, dir], {
          env: dockerEnv,
          timeout: 240_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const result = await exec(
          "docker",
          [
            "run",
            "--rm",
            image,
            "node",
            "-p",
            "require('node:fs').readFileSync('public/bundle.css', 'utf8')",
          ],
          { env: dockerEnv, timeout: 30_000 },
        );
        expect(result.stdout.trim()).toBe(".composer-package { color: green; }");
      } finally {
        await exec("docker", ["rmi", "-f", image], { env: dockerEnv, timeout: 30_000 }).catch(
          () => {},
        );
        await rm(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
