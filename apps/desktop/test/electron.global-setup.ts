import { createRequire } from "node:module";

export default function prepareElectron() {
  // Electron 44 downloads its binary on the first require. Resolve it before
  // parallel workers start so they cannot extract over a running executable.
  createRequire(import.meta.url)("electron");
}
