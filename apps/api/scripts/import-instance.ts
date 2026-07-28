/**
 * Headless sealed-instance import — the target-side entry for
 * migrate-control-plane → server. Runs ON the destination box (over SSH,
 * like packages/db/scripts/restore.ts) so `importInstance` executes in the
 * TARGET's env: it opens the passphrase-sealed bundle, wipe-restores under the
 * migration lock, and re-encrypts every secret under THIS box's key.
 *
 *   OPENSHIP_IMPORT_PASSPHRASE=… bun --cwd apps/api scripts/import-instance.ts \
 *     --in /tmp/openship-export.osx --mode wipe
 *
 * The passphrase comes from the environment, NEVER argv (keeps it out of the
 * process table / shell history — the orchestrator sets it via a 0600 env-file).
 * GATE 1 inside importInstance refuses if this box is a multi-tenant (CLOUD_MODE)
 * instance, so a mis-pointed import can't wipe a SaaS.
 */

import { readFileSync } from "node:fs";
import { importInstance } from "../src/modules/system/data-transfer/import.service";
import type { DataTransferFile, ImportMode } from "../src/modules/system/data-transfer/types";

async function main() {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf("--in");
  const inPath = inIdx >= 0 ? args[inIdx + 1] : null;
  const modeIdx = args.indexOf("--mode");
  const mode: ImportMode = args[modeIdx + 1] === "merge" ? "merge" : "wipe";
  const passphrase = process.env.OPENSHIP_IMPORT_PASSPHRASE || undefined;

  if (!inPath) {
    console.error("[import-instance] --in <path/to/export.osx> is required.");
    process.exit(1);
  }

  let file: DataTransferFile;
  try {
    file = JSON.parse(readFileSync(inPath, "utf8")) as DataTransferFile;
  } catch (err) {
    console.error(`[import-instance] could not read/parse ${inPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await importInstance({ file, passphrase, mode });
    // Machine-readable single line — the orchestrator harvests this over SSH.
    console.log(`[import-instance] ${JSON.stringify(result)}`);
    if (result.secretsSkipped && file.secrets) {
      console.error(
        "[import-instance] WARNING: secrets present but not restored — supply OPENSHIP_IMPORT_PASSPHRASE.",
      );
    }
    process.exit(0);
  } catch (err) {
    console.error(`[import-instance] failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
