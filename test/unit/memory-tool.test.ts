import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ActivityLog, readMachineState } from "../../src/memory/activity.js";
import { MemoryHome, machineName } from "../../src/memory/home.js";
import { MemoryIndex } from "../../src/memory/search.js";
import { readSection } from "../../src/memory/sections.js";
import { runMemoryTool, type MemoryCtx, type MemoryInput } from "../../src/memory/tool-memory.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

let tmp: TempHome;
let home: MemoryHome;
let clock: Date;
let ctx: MemoryCtx;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function makeCtx(h: MemoryHome): MemoryCtx {
  const now = () => clock;
  return { home: h, index: new MemoryIndex(h, { now }), activity: new ActivityLog(h, now), now };
}

beforeEach(async () => {
  tmp = await makeTempHome();
  home = new MemoryHome(tmp.dir);
  clock = new Date(2026, 10, 23, 14, 5, 0); // 2026-11-23 14:05
  ctx = makeCtx(home);
});
afterEach(async () => {
  await tmp.remove();
});

async function put(rel: string, text: string): Promise<void> {
  const p = home.path(rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, "utf8");
}
const exists = async (rel: string) => stat(home.path(rel)).then(() => true, () => false);
const run = (input: MemoryInput) => runMemoryTool(ctx, input);
const mac = () => machineName();
const logRel = (date: string) => `기억/일지/${date}-${mac()}.md`;

describe("공통", () => {
  test("열린 프로젝트가 있으면 첫 줄에 이름", async () => {
    ctx.activity.state.openProject = "이사 준비";
    const r = await run({ action: "pause", on: false });
    expect(r.text.split("\n")[0]).toBe("열린 프로젝트: 이사 준비");
  });

  test("열린 프로젝트가 없으면 그 줄이 없다", async () => {
    const r = await run({ action: "pause", on: false });
    expect(r.text).not.toContain("열린 프로젝트");
  });

  test("첫 줄에 touch() — 30분이 지나면 열린 프로젝트도 풀린다", async () => {
    ctx.activity.state.openProject = "이사 준비";
    clock = new Date(clock.getTime() + 31 * 60_000);
    const r = await run({ action: "pause", on: false });
    expect(r.text).not.toContain("열린 프로젝트");
  });

  test("읽거나 쓴 파일에 충돌본이 있으면 끝에 알린다", async () => {
    await put("기억/나.md", "- 2026-11-01 가\n");
    await put("기억/나 2.md", "- 2026-11-02 나\n");
    const r = await run({ action: "remember", text: "새 기억" });
    expect(r.text.split("\n").at(-1)).toBe("충돌본이 있어요: 기억/나 2.md — 합쳐 주세요");
  });

  test("다루지 않은 파일의 충돌본은 알리지 않는다", async () => {
    await put("기억/사이트/a.com.md", "x\n");
    await put("기억/사이트/a.com 2.md", "y\n");
    const r = await run({ action: "remember", text: "새 기억" });
    expect(r.text).not.toContain("충돌본");
  });

  test("결과는 8,192 바이트 이하(아주 큰 파일 읽기 + 충돌본 + 프로젝트 이름)", async () => {
    await put("기억/나.md", "가나다라마바사 ".repeat(20_000));
    await put("기억/나 2.md", "x\n");
    ctx.activity.state.openProject = "이사 준비";
    const r = await run({ action: "read", path: "기억/나.md" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text.split("\n")[0]).toBe("열린 프로젝트: 이사 준비");
    expect(r.text.split("\n").at(-1)).toContain("충돌본이 있어요");
  });
});

describe("쓸 수 없는 기억 폴더", () => {
  let bad: MemoryCtx;
  beforeEach(async () => {
    await writeFile(join(tmp.dir, "파일"), "x");
    bad = makeCtx(new MemoryHome(join(tmp.dir, "파일", "아래")));
  });

  for (const input of [
    { action: "remember", text: "가나다" },
    { action: "forget", text: "가나다" },
    { action: "tidy_save", text: "요약" },
  ] as MemoryInput[]) {
    test(`${input.action}: 「기억 폴더에 쓸 수 없어요: 경로 — 이유」 오류`, async () => {
      bad.activity.state.pendingTidy = { files: [], at: 0 };
      const r = await runMemoryTool(bad, input);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^기억 폴더에 쓸 수 없어요: .*아래 — .+/);
    });
  }

  test("찾기 · 읽기는 오류 없이 빈 결과", async () => {
    const s = await runMemoryTool(bad, { action: "search", query: "노트북" });
    expect(s.isError).toBeFalsy();
    expect(s.text).toBe("찾은 기억이 없어요.");
    const r = await runMemoryTool(bad, { action: "read" });
    expect(r.isError).toBeFalsy();
  });
});

describe("remember", () => {
  test("기본은 기억/나.md 에 「- 날짜 내용」 한 줄, 이어서 덧붙인다", async () => {
    const a = await run({ action: "remember", text: "커피는 오트 라떼" });
    expect(a.text).toBe("기억했어요: 기억/나.md");
    await run({ action: "remember", text: "맥은 두 대", about: "나" });
    expect(await home.read("기억/나.md")).toBe("- 2026-11-23 커피는 오트 라떼\n- 2026-11-23 맥은 두 대\n");
  });

  test("끝 줄 바꿈이 없던 기존 파일에도 이어 붙인다", async () => {
    await put("기억/나.md", "- 2026-11-01 옛 메모");
    await run({ action: "remember", text: "새 메모" });
    expect(await home.read("기억/나.md")).toBe("- 2026-11-01 옛 메모\n- 2026-11-23 새 메모\n");
  });

  test("줄 바꿈이 든 내용은 한 줄로", async () => {
    await run({ action: "remember", text: "첫째\n둘째\r\n셋째" });
    expect(await home.read("기억/나.md")).toBe("- 2026-11-23 첫째 둘째 셋째\n");
  });

  test("text 가 없거나 비면 한국어 오류, 아무것도 안 만든다", async () => {
    for (const text of [undefined, "", "   "]) {
      const r = await run({ action: "remember", text });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("text");
    }
    expect(await exists("기억/나.md")).toBe(false);
  });

  test("사이트: 호스트 · 주소 → 기억/사이트/<siteFileName>", async () => {
    const a = await run({ action: "remember", text: "쿠폰은 장바구니에서", about: "사이트:https://www.Coupang.com/np/search?q=a" });
    expect(a.text).toBe("기억했어요: 기억/사이트/coupang.com.md");
    await run({ action: "remember", text: "로켓배송 필터", about: "사이트:m.coupang.com" });
    expect(await home.read("기억/사이트/coupang.com.md")).toBe("- 2026-11-23 쿠폰은 장바구니에서\n- 2026-11-23 로켓배송 필터\n");
  });

  test("사이트: 주소를 못 알아보면 오류", async () => {
    const r = await run({ action: "remember", text: "x", about: "사이트:" });
    expect(r.isError).toBe(true);
  });

  test("R15: 사이트 메모를 쓰면 그 호스트 · 그 메모를 쓰는 아래 도메인을 seenDomains 에서 뺀다", async () => {
    const seen = ctx.activity.state.seenDomains;
    seen.add("coupang.com");
    seen.add("shop.coupang.com");
    seen.add("naver.com");
    await run({ action: "remember", text: "메모", about: "사이트:www.coupang.com" });
    expect([...seen]).toEqual(["naver.com"]);
  });

  test("그 일이 실패(민감 값)하면 seenDomains 는 그대로", async () => {
    ctx.activity.state.seenDomains.add("coupang.com");
    await run({ action: "remember", text: "비밀번호: hunter2", about: "사이트:coupang.com" });
    expect(ctx.activity.state.seenDomains.has("coupang.com")).toBe(true);
  });

  test("프로젝트: 열린 프로젝트 문서의 「메모」 절에 덧붙인다", async () => {
    await put("프로젝트/이사 준비/프로젝트.md", "# 이사 준비\n\n## 요약\n집\n\n## 메모\n- 2026-11-01 첫\n\n## 상태\n진행 중\n");
    ctx.activity.state.openProject = "이사 준비";
    const r = await run({ action: "remember", text: "둘째 메모", about: "프로젝트" });
    expect(r.text).toBe("열린 프로젝트: 이사 준비\n기억했어요: 프로젝트/이사 준비/프로젝트.md");
    const md = (await home.read("프로젝트/이사 준비/프로젝트.md"))!;
    expect(readSection(md, "메모")).toBe("- 2026-11-01 첫\n- 2026-11-23 둘째 메모");
    expect(readSection(md, "상태")).toBe("진행 중");
  });

  test("프로젝트: 열린 프로젝트가 없으면 한국어 오류", async () => {
    const r = await run({ action: "remember", text: "x", about: "프로젝트" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("열린 프로젝트가 없어요");
  });

  test("프로젝트: 문서가 없으면 오류(만들지 않는다)", async () => {
    ctx.activity.state.openProject = "없는";
    const r = await run({ action: "remember", text: "x", about: "프로젝트" });
    expect(r.isError).toBe(true);
    expect(await exists("프로젝트/없는/프로젝트.md")).toBe(false);
  });

  test("알 수 없는 about 은 오류", async () => {
    const r = await run({ action: "remember", text: "x", about: "회사" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("사이트:");
  });

  test("민감한 값은 거절하고 이유를 말한다 · 파일도 안 만든다", async () => {
    const cases: [string, string][] = [
      ["카드는 4111 1111 1111 1111", "카드 번호"],
      ["키 sk-abcdefghijklmnopqrstuvwxyz123456", "토큰"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "토큰"],
      ["비밀번호: hunter2", "비밀번호"],
      ["-----BEGIN PRIVATE KEY-----", "개인 키"],
    ];
    for (const [text, kind] of cases) {
      const r = await run({ action: "remember", text });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(kind);
      expect(r.text).not.toContain("hunter2");
    }
    expect(await exists("기억/나.md")).toBe(false);
  });
});

describe("search", () => {
  test("기억한 것을 찾아 준다", async () => {
    await run({ action: "remember", text: "LG 그램 노트북 비교해 봤다" });
    const r = await run({ action: "search", query: "노트북" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("기억/나.md");
    expect(r.text).toContain("LG 그램");
  });

  test("빈 질문은 오류, 못 찾으면 안내", async () => {
    expect((await run({ action: "search", query: "  " })).isError).toBe(true);
    expect((await run({ action: "search" })).isError).toBe(true);
    expect((await run({ action: "search", query: "없는낱말" })).text).toBe("찾은 기억이 없어요.");
  });

  test("열린 프로젝트의 문서가 같은 점수면 앞선다(가산 1.2배)", async () => {
    await put("기억/나.md", "- 2026-11-23 노트북 비교 메모\n");
    await put("프로젝트/이사 준비/프로젝트.md", "# 이사 준비\n\n## 메모\n- 2026-11-23 노트북 비교 메모\n");
    const before = await run({ action: "search", query: "노트북 비교" });
    expect(before.text.split("\n")[0]).toContain("기억/나.md");
    ctx.activity.state.openProject = "이사 준비";
    const after = await run({ action: "search", query: "노트북 비교" });
    expect(after.text.split("\n")[1]).toContain("프로젝트/이사 준비/프로젝트.md");
  });

  test("일지/보관 에 있는 것도 찾는다", async () => {
    await put("기억/일지/보관/2026-10-01-맥.md", "- 10:00 「LG 그램 노트북 비교」 — https://a.example · 성공\n");
    const r = await run({ action: "search", query: "그램 노트북" });
    expect(r.text).toContain("일지/보관");
  });
});

describe("read", () => {
  test("파일 내용을 돌려준다", async () => {
    await put("기억/나.md", "- 2026-11-01 가\n");
    const r = await run({ action: "read", path: "기억/나.md" });
    expect(r.text).toBe("파일: 기억/나.md\n- 2026-11-01 가\n");
  });

  test("8KB 를 넘으면 줄이고 알린다", async () => {
    await put("기억/나.md", "가".repeat(20_000));
    const r = await run({ action: "read", path: "기억/나.md" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text).toContain("줄였어요");
  });

  test("path 가 비면 집 폴더 맨 위 목록(점 파일은 숨김)", async () => {
    await put("기억/나.md", "x");
    await put("프로젝트/a/프로젝트.md", "x");
    await put(".숨김.json", "{}");
    const r = await run({ action: "read" });
    expect(r.text).toContain("- 기억/");
    expect(r.text).toContain("- 프로젝트/");
    expect(r.text).not.toContain(".숨김");
    const r2 = await run({ action: "read", path: "   " });
    expect(r2.text).toContain("- 기억/");
  });

  test("폴더 경로면 그 폴더 목록(파일 · 폴더 구분)", async () => {
    await put("기억/나.md", "x");
    await put("기억/사이트/a.com.md", "x");
    for (const p of ["기억", "기억/", "/기억/"]) {
      const r = await run({ action: "read", path: p });
      expect(r.text).toBe("폴더: 기억/\n- 나.md\n- 사이트/");
    }
  });

  test("없는 파일은 그 폴더 목록 + 안내, 없는 폴더는 있는 위 폴더로", async () => {
    await put("기억/나.md", "x");
    const a = await run({ action: "read", path: "기억/없는.md" });
    expect(a.isError).toBeFalsy();
    expect(a.text).toContain("없는.md");
    expect(a.text).toContain("폴더: 기억/");
    expect(a.text).toContain("- 나.md");
    const b = await run({ action: "read", path: "기억/없는폴더/아래/x.md" });
    expect(b.text).toContain("폴더: 기억/");
    const c = await run({ action: "read", path: "전혀없는/x.md" });
    expect(c.text).toContain("(기억 폴더 맨 위)");
  });

  test("집 폴더 밖 경로는 오류", async () => {
    for (const p of ["../밖.md", "기억/../../밖.md"]) {
      const r = await run({ action: "read", path: p });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("밖의 경로");
    }
  });

  test("집 폴더 절대 경로는 상대 경로로 본다", async () => {
    await put("기억/나.md", "내용");
    const r = await run({ action: "read", path: join(home.dir, "기억", "나.md") });
    expect(r.text).toContain("내용");
  });

  test("읽은 파일의 충돌본을 알린다", async () => {
    await put("기억/나.md", "a");
    await put("기억/나 2.md", "b");
    const r = await run({ action: "read", path: "기억/나.md" });
    expect(r.text).toContain("충돌본이 있어요: 기억/나 2.md");
  });
});

describe("forget", () => {
  beforeEach(async () => {
    await put("기억/나.md", "- 2026-11-01 커피는 오트 라떼\n- 2026-11-02 맥은 두 대\n- 2026-11-03 커피 원두는 산미 있는 것\n");
    await put("기억/사이트/coupang.com.md", "- 2026-11-04 쿠폰은 장바구니에서\n");
    await put(logRel("2026-11-20"), "- 10:00 「쿠폰 찾기」 — https://a.example · 성공\n");
  });

  test("한 줄만 걸리면 지우고 보여 준다(다른 줄은 그대로)", async () => {
    const r = await run({ action: "forget", text: "오트 라떼" });
    expect(r.text).toBe("지웠어요: 기억/나.md:1\n- 2026-11-01 커피는 오트 라떼");
    expect(await home.read("기억/나.md")).toBe("- 2026-11-02 맥은 두 대\n- 2026-11-03 커피 원두는 산미 있는 것\n");
  });

  test("사이트 메모에서도 지운다", async () => {
    const r = await run({ action: "forget", text: "장바구니" });
    expect(r.text).toContain("지웠어요: 기억/사이트/coupang.com.md:1");
    expect(await home.read("기억/사이트/coupang.com.md")).toBe("");
  });

  test("여러 줄이 걸리면 아무것도 안 지우고 목록(파일 · 줄 번호)을 보여 준다", async () => {
    const before = await readFile(home.path("기억/나.md"), "utf8");
    const r = await run({ action: "forget", text: "커피" });
    expect(r.text).toContain("2줄이 걸려서 아무것도 지우지 않았어요");
    expect(r.text).toContain("- 기억/나.md:1  - 2026-11-01 커피는 오트 라떼");
    expect(r.text).toContain("- 기억/나.md:3  - 2026-11-03 커피 원두는 산미 있는 것");
    expect(r.text).toContain("더 길게");
    expect(await readFile(home.path("기억/나.md"), "utf8")).toBe(before);
  });

  test("0 줄이면 그렇다고 말한다", async () => {
    const r = await run({ action: "forget", text: "없는 말" });
    expect(r.text).toContain("찾지 못했어요");
  });

  test("두 글자 미만은 오류", async () => {
    for (const text of [undefined, "", " ", "가"]) {
      const r = await run({ action: "forget", text });
      expect(r.isError).toBe(true);
    }
  });

  test("일지 · 프로젝트 문서는 건드리지 않는다", async () => {
    await put("프로젝트/a/프로젝트.md", "## 메모\n- 쿠폰 메모\n");
    const r = await run({ action: "forget", text: "쿠폰은" });
    expect(r.text).toContain("지웠어요: 기억/사이트/coupang.com.md");
    expect(await home.read("프로젝트/a/프로젝트.md")).toContain("쿠폰 메모");
    expect(await home.read(logRel("2026-11-20"))).toContain("쿠폰 찾기");
  });

  test("NFD 로 적어도 찾는다", async () => {
    const r = await run({ action: "forget", text: "오트 라떼".normalize("NFD") });
    expect(r.text).toContain("지웠어요");
  });
});

describe("pause", () => {
  test("on 으로 멈추고 off 로 다시 기록", async () => {
    const a = await run({ action: "pause", on: true });
    expect(ctx.activity.state.paused).toBe(true);
    expect(a.text).toContain("멈췄어요");
    const b = await run({ action: "pause", on: false });
    expect(ctx.activity.state.paused).toBe(false);
    expect(b.text).toContain("다시");
  });

  test("on 이 없으면 오류", async () => {
    const r = await run({ action: "pause" });
    expect(r.isError).toBe(true);
    expect(ctx.activity.state.paused).toBe(false);
  });
});

describe("tidy", () => {
  const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;

  async function twentyDays() {
    for (let n = 1; n <= 20; n++) {
      const lines = Array.from({ length: 30 }, (_, i) => `- 10:${String(i).padStart(2, "0")} 「작업 ${n}-${i}」 — https://a.example/p${i} · 성공`);
      await put(logRel(day(n)), lines.join("\n").padEnd(2048, " ") + "\n");
    }
  }

  test("정리할 일지가 없으면 그렇다고 하고 pendingTidy 는 비운다", async () => {
    await put(logRel("2026-11-23"), "- 10:00 「오늘」 — x · 성공\n"); // 오늘 것은 대상이 아님
    const r = await run({ action: "tidy" });
    expect(r.text).toContain("정리할 일지가 없어요");
    expect(ctx.activity.state.pendingTidy).toBeNull();
  });

  test("20일 × 2KB: 8,192 바이트 이하 · 오래된 것부터 파일 통째로 · 남은 날 안내 · pendingTidy", async () => {
    await twentyDays();
    await put("기억/오래-기억.md", "## 2026-10-01 정리\n" + "옛 요약 ".repeat(1000) + "\n맨끝줄\n");
    const r = await run({ action: "tidy" });
    expect(r.isError).toBeFalsy();
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    const p = ctx.activity.state.pendingTidy!;
    expect(p.at).toBe(clock.getTime());
    expect(p.files.length).toBeGreaterThanOrEqual(1);
    expect(p.files.length).toBeLessThan(20);
    // 오래된 날부터, 건너뜀 없이
    expect(p.files).toEqual(Array.from({ length: p.files.length }, (_, i) => `기억/일지/${day(i + 1)}-${mac()}.md`));
    for (const f of p.files) expect(r.text).toContain(`### ${f.split("/").pop()}`);
    expect(r.text).not.toContain(`### ${day(p.files.length + 1)}-`);
    expect(r.text).toContain(`남은 날 ${20 - p.files.length}일 — 한 번 더 tidy`);
    expect(r.text).toContain("tidy_save");
    expect(r.text).toContain("맨끝줄");
    expect(r.text).toContain("끝 1,500바이트만");
    // 파일은 통째로(잘림 표시 없음)
    expect(r.text).not.toContain("줄 생략");
  });

  test("오래-기억 은 끝 1,500 바이트만, 없으면 「아직 없어요」", async () => {
    await put(logRel("2026-11-01"), "- 10:00 「가」 — x · 성공\n");
    const none = await run({ action: "tidy" });
    expect(none.text).toContain("(아직 없어요)");
    await put("기억/오래-기억.md", "처음줄\n" + "나".repeat(3000) + "\n끝줄\n");
    const r = await run({ action: "tidy" });
    expect(r.text).not.toContain("처음줄");
    expect(r.text).toContain("끝줄");
  });

  test("6KB 짜리 하루 하나: 가운데를 줄여 5,000바이트 몫 안에 담고 보관 대상에 넣는다", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `- 줄${String(i).padStart(3, "0")} ${"가".repeat(14)}`);
    await put(logRel("2026-11-01"), lines.join("\n") + "\n");
    expect(bytes(lines.join("\n"))).toBeGreaterThan(5000);
    await put(logRel("2026-11-02"), "- 10:00 「둘째 날」 — x · 성공\n");
    const r = await run({ action: "tidy" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text).toMatch(/… \d+줄 생략 …/);
    expect(r.text).toContain("줄000");
    expect(r.text).toContain("줄119");
    expect(r.text).not.toContain("줄060");
    expect(ctx.activity.state.pendingTidy!.files).toEqual([logRel("2026-11-01")]);
    expect(r.text).toContain("남은 날 1일 — 한 번 더 tidy");
  });

  test("줄 하나가 몫보다 길어도 몫 안으로", async () => {
    await put(logRel("2026-11-01"), "가".repeat(9000) + "\n");
    const r = await run({ action: "tidy" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(ctx.activity.state.pendingTidy!.files).toEqual([logRel("2026-11-01")]);
  });

  test("다른 맥 일지도 담고, 보관/ · 오늘 일지는 뺀다", async () => {
    await put("기억/일지/2026-11-01-다른맥.md", "- 10:00 「남의 맥」 — x · 성공\n");
    await put(logRel("2026-11-02"), "- 10:00 「내 맥」 — x · 성공\n");
    await put("기억/일지/보관/2026-10-01-맥.md", "- 10:00 「이미 보관」 — x · 성공\n");
    await put(logRel("2026-11-23"), "- 10:00 「오늘」 — x · 성공\n");
    const r = await run({ action: "tidy" });
    expect(r.text).toContain("남의 맥");
    expect(r.text).toContain("내 맥");
    expect(r.text).not.toContain("이미 보관");
    expect(r.text).not.toContain("「오늘」");
    expect(ctx.activity.state.pendingTidy!.files).toHaveLength(2);
  });

  test("열린 프로젝트 이름 · 충돌본 줄이 붙어도 8,192 바이트 이하", async () => {
    await twentyDays();
    await put("기억/오래-기억.md", "가".repeat(4000));
    await put("기억/오래-기억 2.md", "x");
    ctx.activity.state.openProject = "가".repeat(64);
    const r = await run({ action: "tidy" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text).toContain("tidy_save");
    expect(r.text).toContain("한 번 더 tidy");
  });
});

describe("tidy_save", () => {
  async function prepared() {
    await put(logRel("2026-11-01"), "- 10:00 「첫날」 — x · 성공\n");
    await put(logRel("2026-11-02"), "- 10:00 「둘째 날」 — x · 성공\n");
    await put(logRel("2026-11-23"), "- 10:00 「오늘」 — x · 성공\n");
    await run({ action: "tidy" });
  }

  test("tidy 없이 부르면 오류 · 아무것도 안 옮긴다", async () => {
    await put(logRel("2026-11-01"), "- 10:00 「첫날」 — x · 성공\n");
    const r = await run({ action: "tidy_save", text: "요약" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("먼저 tidy 를 불러 주세요");
    expect(await exists(logRel("2026-11-01"))).toBe(true);
    expect(await exists("기억/오래-기억.md")).toBe(false);
  });

  test("30분이 지나 풀렸으면 같은 오류", async () => {
    await prepared();
    clock = new Date(clock.getTime() + 31 * 60_000);
    const r = await run({ action: "tidy_save", text: "요약" });
    expect(r.isError).toBe(true);
    expect(await exists(logRel("2026-11-01"))).toBe(true);
  });

  test("요약을 오래-기억에 더하고 일지를 보관으로 옮긴다(오늘 일지는 그대로)", async () => {
    await prepared();
    await put("기억/오래-기억.md", "## 2026-10-01 정리\n옛 요약\n");
    const r = await run({ action: "tidy_save", text: "11월 초에는 노트북을 비교했다." });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("정리했어요: 기억/오래-기억.md 에 요약을 더하고 일지 2개를 기억/일지/보관/ 으로 옮겼어요.");
    expect(await home.read("기억/오래-기억.md")).toBe("## 2026-10-01 정리\n옛 요약\n\n## 2026-11-23 정리\n11월 초에는 노트북을 비교했다.\n");
    expect(await exists(logRel("2026-11-01"))).toBe(false);
    expect(await exists(logRel("2026-11-02"))).toBe(false);
    expect(await exists(`기억/일지/보관/2026-11-01-${mac()}.md`)).toBe(true);
    expect(await exists(`기억/일지/보관/2026-11-02-${mac()}.md`)).toBe(true);
    expect(await exists(logRel("2026-11-23"))).toBe(true);
    expect(ctx.activity.state.pendingTidy).toBeNull();
    expect((await readMachineState(home)).lastTidy).toBe(clock.toISOString());
  });

  test("오래-기억이 없으면 새로 만든다", async () => {
    await prepared();
    await run({ action: "tidy_save", text: "요약" });
    expect(await home.read("기억/오래-기억.md")).toBe("## 2026-11-23 정리\n요약\n");
  });

  test("한 번 더 부르면 오류(pendingTidy 가 비었으므로)", async () => {
    await prepared();
    await run({ action: "tidy_save", text: "요약" });
    expect((await run({ action: "tidy_save", text: "요약" })).isError).toBe(true);
  });

  test("민감한 값은 거절 · 아무것도 안 옮기고 pendingTidy 도 그대로", async () => {
    await prepared();
    const r = await run({ action: "tidy_save", text: "비밀번호: hunter2" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("hunter2");
    expect(await exists(logRel("2026-11-01"))).toBe(true);
    expect(await exists("기억/오래-기억.md")).toBe(false);
    expect(ctx.activity.state.pendingTidy).not.toBeNull();
    expect((await readMachineState(home)).lastTidy).toBeUndefined();
  });

  test("text 가 비면 오류", async () => {
    await prepared();
    expect((await run({ action: "tidy_save", text: "  " })).isError).toBe(true);
    expect(await exists(logRel("2026-11-01"))).toBe(true);
  });

  test("그사이 사라진 파일은 건너뛴다", async () => {
    await prepared();
    const { rm } = await import("node:fs/promises");
    await rm(home.path(logRel("2026-11-01")));
    const r = await run({ action: "tidy_save", text: "요약" });
    expect(r.text).toContain("일지 1개를");
    expect(await exists(`기억/일지/보관/2026-11-02-${mac()}.md`)).toBe(true);
  });

  test("보관에 같은 이름이 이미 있으면 덮어쓰지 않는다", async () => {
    await put(`기억/일지/보관/2026-11-01-${mac()}.md`, "이미 보관된 것\n");
    await prepared();
    await run({ action: "tidy_save", text: "요약" });
    expect(await home.read(`기억/일지/보관/2026-11-01-${mac()}.md`)).toBe("이미 보관된 것\n");
    expect(await home.read(`기억/일지/보관/2026-11-01-${mac()}-2.md`)).toContain("첫날");
  });

  test("tidy 로 담지 않은(남은) 날은 그대로 둔다", async () => {
    for (let n = 1; n <= 20; n++) await put(logRel(`2026-11-${String(n).padStart(2, "0")}`), "가".repeat(2000) + "\n");
    await run({ action: "tidy" });
    const taken = ctx.activity.state.pendingTidy!.files.length;
    expect(taken).toBeLessThan(20);
    await run({ action: "tidy_save", text: "요약" });
    expect(await exists(logRel("2026-11-20"))).toBe(true);
    expect(await exists(logRel("2026-11-01"))).toBe(false);
  });

  test("정리한 뒤에는 보관 일지도 찾기로 찾아진다", async () => {
    await put(logRel("2026-11-01"), "- 10:00 「LG 그램 노트북 비교」 — x · 성공\n");
    await run({ action: "tidy" });
    await run({ action: "tidy_save", text: "요약" });
    const r = await run({ action: "search", query: "그램 노트북" });
    expect(r.text).toContain("일지/보관/2026-11-01");
  });
});
