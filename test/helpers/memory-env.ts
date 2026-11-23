import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// vitest setupFiles: 시험 파일마다 기억 폴더를 새 임시 폴더로 돌려 둔다(이미 값이 있어도 덮어쓴다).
// 어떤 시험도 진짜 iCloud 폴더(사파리-어트랙션)에 쓰지 못하게 하는 장치다.
const dir = mkdtempSync(join(tmpdir(), "safari-attraction-env-"));
process.env.SAFARI_ATTRACTION_HOME = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
