import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/test/**/*.test.ts", "app/test/**/*.test.ts", "job/test/**/*.test.ts"],
  },
});
