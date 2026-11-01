import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", native: "src/native.ts", client: "src/client.ts" },
  format: ["esm", "cjs"],
  dts: { resolve: [/^@repo\//] },
  clean: true,
  noExternal: [/^@repo\//],
});
