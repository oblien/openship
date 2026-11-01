import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/electron.global-setup.ts"],
  },
});
