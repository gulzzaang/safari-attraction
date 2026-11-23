import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 시험용 임시 기억 폴더. 진짜 iCloud 폴더에는 절대 쓰지 않는다.
 * (모든 시험은 memory-env.ts 가 SAFARI_ATTRACTION_HOME 을 이미 임시 폴더로 돌려 둔다 — 이 도우미는 자기 폴더가 따로 필요한 시험용.)
 */
export interface TempHome {
  dir: string;
  /** 폴더를 지우고 SAFARI_ATTRACTION_HOME 을 만들기 전 값으로 되돌린다. */
  remove(): Promise<void>;
}

export async function makeTempHome(): Promise<TempHome> {
  const dir = await mkdtemp(join(tmpdir(), "safari-attraction-home-"));
  const before = process.env.SAFARI_ATTRACTION_HOME;
  process.env.SAFARI_ATTRACTION_HOME = dir;
  return {
    dir,
    async remove() {
      if (before === undefined) delete process.env.SAFARI_ATTRACTION_HOME;
      else process.env.SAFARI_ATTRACTION_HOME = before;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
