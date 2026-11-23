import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeMachineState } from "../../src/memory/activity.js";
import { MemoryHome } from "../../src/memory/home.js";
import { memoryStatusLines } from "../../src/memory/status.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

let tmp: TempHome;
let home: MemoryHome;

beforeEach(async () => {
  tmp = await makeTempHome();
  home = new MemoryHome(tmp.dir);
});
afterEach(async () => {
  await tmp.remove();
});

const touch = async (rel: string) => {
  await mkdir(join(tmp.dir, rel, ".."), { recursive: true });
  await writeFile(join(tmp.dir, rel), "x", "utf8");
};

describe("기억 상태 줄(memoryStatusLines)", () => {
  test("폴더 경로 · 위치 종류 · 쓰기 가능 · 충돌본 없음 · 정리 아직 없음", async () => {
    const r = await memoryStatusLines(home, "icloud");
    expect(r.writable).toBe(true);
    expect(r.lines[0]).toBe(`✓ 기억 폴더: ${tmp.dir} · iCloud`);
    const t = r.lines.join("\n");
    expect(t).toContain("쓰기: 가능");
    expect(t).toContain("충돌본: 없음");
    expect(t).toContain("마지막 정리: 아직 없음");
  });

  test("위치 종류 이름: icloud · local · env", async () => {
    expect((await memoryStatusLines(home, "local")).lines[0]).toBe(`✓ 기억 폴더: ${tmp.dir} · 이 맥에만`);
    expect((await memoryStatusLines(home, "env")).lines[0]).toBe(`✓ 기억 폴더: ${tmp.dir} · 환경 변수`);
  });

  test("쓸 수 없으면 ✗ + 이유 + 사파리 조작은 그대로라는 말", async () => {
    await writeFile(join(tmp.dir, "파일"), "x", "utf8");
    const bad = new MemoryHome(join(tmp.dir, "파일", "하위"));
    const r = await memoryStatusLines(bad, "icloud");
    expect(r.writable).toBe(false);
    expect(r.lines[0]).toMatch(/^✗ 기억 폴더: .*하위 · iCloud$/);
    const t = r.lines.join("\n");
    expect(t).toMatch(/쓰기: 안 돼요 — /);
    expect(t).toContain("ENOTDIR");
    expect(t).toContain("사파리 조작은 그대로");
    expect(t).toContain("마지막 정리: 아직 없음");
  });

  test("충돌본: 개수와 이름 3개까지, 나머지는 「외 N개」", async () => {
    await touch("기억/나.md");
    for (const n of ["나 2.md", "나 3.md", "나 4.md", "나 5.md"]) await touch(`기억/${n}`);
    await touch("기억/사이트/a.com.md");
    await touch("기억/사이트/a.com 2.md");
    await touch("기억/혼자 2.md"); // 원본이 없으면 충돌본이 아니다
    const t = (await memoryStatusLines(home, "icloud")).lines.join("\n");
    expect(t).toContain("충돌본 5개:");
    expect(t).toContain("기억/나 2.md");
    expect(t).toContain("외 2개");
    expect(t).not.toContain("혼자 2.md");
  });

  test("마지막 정리 시각은 이 맥 시간대의 읽기 쉬운 글", async () => {
    const d = new Date(2026, 10, 22, 14, 3, 0);
    await writeMachineState(home, { lastTidy: d.toISOString() });
    const t = (await memoryStatusLines(home, "icloud")).lines.join("\n");
    expect(t).toContain("마지막 정리: 2026-11-22 14:03");
  });

  test("깨진 정리 시각은 「아직 없음」", async () => {
    await writeMachineState(home, { lastTidy: "엉터리" });
    expect((await memoryStatusLines(home, "icloud")).lines.join("\n")).toContain("마지막 정리: 아직 없음");
  });

  test("한 가지가 실패해도 나머지 줄은 그대로(충돌본 읽기 실패)", async () => {
    home.conflicts = async () => {
      throw new Error("읽기 실패");
    };
    const r = await memoryStatusLines(home, "icloud");
    const t = r.lines.join("\n");
    expect(r.writable).toBe(true);
    expect(t).toContain("쓰기: 가능");
    expect(t).toContain("충돌본: 확인하지 못했어요");
    expect(t).toContain("마지막 정리: 아직 없음");
  });

  test("폴더가 멈춰도 2초(시험에서는 짧게) 안에 줄을 돌려주고 던지지 않는다", async () => {
    home.writable = () => new Promise(() => {});
    home.conflicts = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await memoryStatusLines(home, "icloud", { timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1500);
    const t = r.lines.join("\n");
    expect(t).toContain("기억 폴더: ");
    expect(t).toContain("쓰기: 확인하지 못했어요");
    expect(t).toContain("충돌본: 확인하지 못했어요");
  });
});
