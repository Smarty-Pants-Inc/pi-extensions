import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/editor-composition.test.ts"],
    setupFiles: ["packages/pi-input-history/test/vitest.setup.ts"],
  },
});
