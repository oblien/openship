import { writeFileSync } from "node:fs";
import { buildKitGuardEntrypoint } from "../../core/src/build-metadata-policy";

const destination = process.argv[2];
if (!destination) throw new Error("Pass the BuildKit entrypoint output path.");
writeFileSync(destination, buildKitGuardEntrypoint(), { mode: 0o755 });
