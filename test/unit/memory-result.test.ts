import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ActivityLog } from "../../src/memory/activity.js";
import { MemoryHome, machineName } from "../../src/memory/home.js";
import { composeResult } from "../../src/memory/result.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

let tmp: TempHome;
let home: MemoryHome;
let activity: ActivityLog;
const clock = new Date(2026, 10, 23, 14, 5, 0);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const HINT = "… 기억 정리할 때가 됐어요 — memory 도구 tidy";

beforeEach(async () => {
  tmp = await makeTempHome();
  home = new MemoryHome(tmp.dir);
  activity = new ActivityLog(home, () => clock);
});
afterEach(async () => {
  await tmp.remove();
});

async function put(rel: string, text: string) {
  const p = home.path(rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, "utf8");
}
const oldLog = () => put(`기억/일지/2026-11-01-${machineName()}.md`, "- 10:00 「가」 — x · 성공\n");

describe("composeResult — 결과 봉투", () => {
  test("열린 프로젝트 첫 줄 · 충돌본 끝 줄", async () => {
    activity.state.openProject = "이사";
    await put("기억/나.md", "a");
    await put("기억/나 2.md", "b");
    const r = await composeResult({ home, activity }, "본문", { files: ["기억/나.md"] });
    expect(r.text).toBe("열린 프로젝트: 이사\n본문\n충돌본이 있어요: 기억/나 2.md — 합쳐 주세요");
  });

  test("정리 안내는 낡은 일지가 있으면 끝 줄에, 대화당 한 번만", async () => {
    await oldLog();
    const a = await composeResult({ home, activity }, "본문");
    expect(a.text).toBe(`본문\n${HINT}`);
    const b = await composeResult({ home, activity }, "본문");
    expect(b.text).toBe("본문");
  });

  test("충돌본 줄 다음에 안내 줄", async () => {
    await oldLog();
    await put("기억/나.md", "a");
    await put("기억/나 2.md", "b");
    const r = await composeResult({ home, activity }, "본문", { files: ["기억/나.md"] });
    expect(r.text.split("\n").slice(-2)).toEqual(["충돌본이 있어요: 기억/나 2.md — 합쳐 주세요", HINT]);
  });

  test("skipTidyHint 면 안내를 붙이지 않고 아직 안 보인 것으로 둔다", async () => {
    await oldLog();
    const a = await composeResult({ home, activity }, "본문", { skipTidyHint: true });
    expect(a.text).toBe("본문");
    expect(activity.state.tidyHinted).toBe(false);
  });

  test("본문이 8KB 가까이 차도 안내는 남고 본문 끝이 줄어든다", async () => {
    await oldLog();
    activity.state.openProject = "이사";
    const r = await composeResult({ home, activity }, "가".repeat(5000), {});
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text.split("\n").at(-1)).toBe(HINT);
    expect(r.text).toContain("줄였어요");
    expect(r.text.startsWith("열린 프로젝트: 이사\n가가가")).toBe(true);
  });

  test("안내를 계산하다 실패해도 결과는 그대로", async () => {
    activity.planTidyHint = async () => {
      throw new Error("읽기 실패");
    };
    const r = await composeResult({ home, activity }, "본문");
    expect(r.text).toBe("본문");
  });

  test("정리 안내는 결과에 실제로 붙은 뒤에만 보인 것으로 친다(붙지 못하면 다음 결과에 다시)", async () => {
    await oldLog();
    // 8KB 안에 들어가지 못하는 안내(가상) — 붙지 않고 표시도 안 한다.
    const real = activity.planTidyHint.bind(activity);
    activity.planTidyHint = async () => ({ text: "안".repeat(4000), commit: () => { activity.state.tidyHinted = true; } });
    const a = await composeResult({ home, activity }, "본문");
    expect(a.text).toBe("본문");
    expect(activity.state.tidyHinted).toBe(false);
    activity.planTidyHint = real;
    const b = await composeResult({ home, activity }, "본문");
    expect(b.text).toBe(`본문\n${HINT}`);
    expect(activity.state.tidyHinted).toBe(true);
  });

  test("isError 는 그대로 전한다", async () => {
    const r = await composeResult({ home, activity }, "오류", { isError: true });
    expect(r).toEqual({ text: "오류", isError: true });
  });
});
