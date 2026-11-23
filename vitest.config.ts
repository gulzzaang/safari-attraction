import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // 통합 시험(*.it.test.ts)은 SAFARI_IT=1 일 때만 돈다.
    exclude: process.env.SAFARI_IT ? ["node_modules/**"] : ["node_modules/**", "**/*.it.test.ts"],
    // 모든 시험 파일의 기억 폴더를 임시 폴더로 돌린다(진짜 iCloud 폴더 보호).
    setupFiles: ["test/helpers/memory-env.ts"],
    passWithNoTests: true,
  },
});
