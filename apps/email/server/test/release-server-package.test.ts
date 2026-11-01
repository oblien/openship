import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createReleaseServerPackage } from '../../scripts/release-server-package';

const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the shipped manifest keeps reviewed runtime overrides and excludes development hooks', () => {
  const manifest = createReleaseServerPackage({
    ...source,
    scripts: { postinstall: 'unshipped hook' },
  });
  expect(manifest.overrides).toEqual(source.overrides);
  expect(manifest.overrides?.nodemailer).toBe(manifest.dependencies.nodemailer);
  expect(manifest.scripts).toEqual({ start: 'bun run src/main.ts' });
  expect(manifest).not.toHaveProperty('devDependencies');
  expect(manifest).not.toHaveProperty('trustedDependencies');
});

test('an invalid or unreviewed override fails the release instead of being dropped', () => {
  for (const overrides of [
    null,
    [],
    'nodemailer',
    { nodemailer: {} },
    { unknown: '1.0.0' },
    { nodemailer: '8.0.7' },
  ]) {
    expect(() => createReleaseServerPackage({ ...source, overrides })).toThrow();
  }
  for (const version of ['workspace:*', 'file:./mail', 'npm:other@10.1.7']) {
    expect(() =>
      createReleaseServerPackage({
        ...source,
        dependencies: { ...source.dependencies, nodemailer: version },
        overrides: { nodemailer: version },
      }),
    ).toThrow();
  }
});

test('the generated production lock retains the patched nested Nodemailer policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openship-release-mail-policy-'));
  try {
    // Reproduce the committed/tested ImapFlow graph. Its exact 8.0.7 dependency
    // must remain overridden even if a future registry resolution changes peers.
    const fixture = {
      version: source.version,
      dependencies: { imapflow: '1.3.3', nodemailer: '10.1.7' },
      overrides: { nodemailer: '10.1.7' },
    };
    const manifest = createReleaseServerPackage(fixture);
    const resolve = async (pkg: Record<string, unknown>) => {
      await rm(join(directory, 'bun.lock'), { force: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
      await promisify(execFile)(
        process.execPath,
        ['install', '--lockfile-only', '--ignore-scripts'],
        { cwd: directory, timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      return readFile(join(directory, 'bun.lock'), 'utf8');
    };
    const { overrides: _dropped, ...oldManifest } = manifest;
    const before = await resolve(oldManifest);
    expect(before).toContain('"imapflow/nodemailer": ["nodemailer@8.0.7"');
    const after = await resolve(manifest);
    expect(after).toContain('"nodemailer": ["nodemailer@10.1.7"');
    expect(after).not.toContain('"imapflow/nodemailer":');
    expect(after).not.toMatch(/\["nodemailer@8\./);
    // Lock generation must not execute install scripts or populate runtime modules.
    expect(
      await Bun.file(join(directory, 'node_modules', 'nodemailer', 'package.json')).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
