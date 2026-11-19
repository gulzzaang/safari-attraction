import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // 통합 시험(*.it.test.ts)은 SAFARI_IT=1 일 때만 돈다.
    exclude: process.env.SAFARI_IT ? ["node_modules/**"] : ["node_modules/**", "**/*.it.test.ts"],
    passWithNoTests: true,
  },
});
