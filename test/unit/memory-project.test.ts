import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ActivityLog, type Touch } from "../../src/memory/activity.js";
import { MemoryHome, machineName } from "../../src/memory/home.js";
import { recentRecords, safeProjectName } from "../../src/memory/projects.js";
import { readSection } from "../../src/memory/sections.js";
import { runProjectTool, type ProjectCtx, type ProjectInput } from "../../src/memory/tool-project.js";
import type { ReplResult } from "../../src/repl/context.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

let tmp: TempHome;
let home: MemoryHome;
let clock: Date;
let ctx: ProjectCtx;
let opened: string[][];
let recorded: Array<{ title: string; touched: Touch[]; ok: boolean; error?: string }>;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function makeCtx(h: MemoryHome): ProjectCtx {
  const now = () => clock;
  return {
    home: h,
    activity: new ActivityLog(h, now),
    now,
    // 사파리 대신 가짜: 받은 주소를 그대로 「열었다」고 한다.
    openTabs: async (urls): Promise<ReplResult> => {
      opened.push(urls);
      return { output: urls.map((u) => `열었어요: ${u}`).join("\n"), touched: urls.map((url) => ({ url, userTab: false, kind: "open" as const })) };
    },
    recordOpened: async (entry) => {
      recorded.push(entry);
      return [];
    },
  };
}

beforeEach(async () => {
  tmp = await makeTempHome();
  home = new MemoryHome(tmp.dir);
  clock = new Date(2026, 10, 23, 14, 5, 0); // 2026-11-23 14:05
  opened = [];
  recorded = [];
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
const run = (input: ProjectInput) => runProjectTool(ctx, input);
const PM = (name: string) => `프로젝트/${name}/프로젝트.md`;

describe("safeProjectName", () => {
  const ok = (raw: string) => {
    const r = safeProjectName(raw);
    if (!r.ok) throw new Error(`거절됨: ${r.error}`);
    return r.name;
  };
  const bad = (raw: string) => {
    const r = safeProjectName(raw);
    if (r.ok) throw new Error(`통과함: ${r.name}`);
    return r.error;
  };

  test("앞뒤 공백을 떼고 / \\ : 는 - 로 바꾼다", () => {
    expect(ok("  이사 준비  ")).toBe("이사 준비");
    expect(ok("a/b")).toBe("a-b");
    expect(ok("a\\b:c")).toBe("a-b-c");
  });

  test("이모지 · 안쪽 공백은 그대로", () => {
    expect(ok("여행 ✈️ 계획")).toBe("여행 ✈️ 계획");
  });

  test("NFD 로 들어와도 NFC 로 맞춘다", () => {
    expect(ok("이사 준비".normalize("NFD"))).toBe("이사 준비".normalize("NFC"));
  });

  test("빈 이름 · .. · 점으로 시작 · 65자는 한국어 오류", () => {
    expect(bad("   ")).toMatch(/이름/);
    expect(bad("..")).toMatch(/\.\./);
    expect(bad("a..b")).toMatch(/\.\./);
    expect(bad(".숨김")).toMatch(/점/);
    expect(bad("가".repeat(65))).toMatch(/64/);
  });

  test("64자는 통과(자르지 않는다), 글자 수는 코드 포인트로", () => {
    expect(ok("가".repeat(64))).toBe("가".repeat(64));
    expect([...ok("😀".repeat(64))]).toHaveLength(64);
    expect(bad("😀".repeat(65))).toMatch(/64/);
  });

  test("보관 은 보관 폴더 이름이라 못 쓰고, 제어 문자도 못 쓴다", () => {
    expect(bad("보관")).toMatch(/보관/);
    expect(bad("가\u0000나")).toMatch(/제어/);
  });
});

describe("create", () => {
  test("프로젝트.md 꼴: 제목 · 요약 · 조건 · 사이트 · 메모 · 상태", async () => {
    const r = await run({ action: "create", name: "이사 준비", text: "6월에 옮길 집 알아보기" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("이사 준비");
    const md = (await home.read(PM("이사 준비")))!;
    expect(md.split("\n")[0]).toBe("# 이사 준비");
    expect(readSection(md, "요약")).toBe("6월에 옮길 집 알아보기");
    for (const h of ["조건", "사이트", "메모"]) expect(readSection(md, h)).toBe("");
    expect(readSection(md, "상태")).toBe("진행 중");
    expect([...md.matchAll(/^## (.*)$/gm)].map((m) => m[1])).toEqual(["요약", "조건", "사이트", "메모", "상태"]);
  });

  test("만들어도 열리지는 않는다(open 으로 연다)", async () => {
    await run({ action: "create", name: "p" });
    expect(ctx.activity.state.openProject).toBeNull();
  });

  test("이름이 없으면 오류", async () => {
    const r = await run({ action: "create" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/name/);
  });

  test("같은 이름(NFD · 앞뒤 공백 · 대소문자 달라도)은 「이미 있어요」", async () => {
    await run({ action: "create", name: "Move Plan" });
    for (const n of ["Move Plan", "  Move Plan ", "move plan"]) {
      const r = await run({ action: "create", name: n });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("이미 있어요");
    }
    await run({ action: "create", name: "이사 준비" });
    const r = await run({ action: "create", name: "이사 준비".normalize("NFD") });
    expect(r.text).toContain("이미 있어요");
  });

  test("보관된 이름과도 겹치면 「이미 있어요」", async () => {
    await run({ action: "create", name: "옛일" });
    await run({ action: "archive", name: "옛일" });
    const r = await run({ action: "create", name: "옛일" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("이미 있어요");
  });

  test("이름 규칙 위반은 파일을 만들지 않는다", async () => {
    for (const n of ["..", ".x", "가".repeat(65), "보관"]) {
      const r = await run({ action: "create", name: n });
      expect(r.isError).toBe(true);
    }
    expect(await home.list("프로젝트")).toEqual([]);
  });

  test("a/b 는 a-b 폴더로 만든다", async () => {
    const r = await run({ action: "create", name: "a/b" });
    expect(r.isError).toBeFalsy();
    expect(await exists(PM("a-b"))).toBe(true);
    expect(r.text).toContain("a-b");
  });

  test("요약에 민감한 값이 있으면 거절하고 아무것도 안 만든다", async () => {
    const r = await run({ action: "create", name: "키", text: "토큰 ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("토큰");
    expect(await exists(PM("키"))).toBe(false);
  });

  test("요약이 4,000자를 넘으면 거절", async () => {
    const r = await run({ action: "create", name: "긴", text: "가".repeat(4001) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/4,000/);
    const ok = await run({ action: "create", name: "긴", text: "가".repeat(4000) });
    expect(ok.isError).toBeFalsy();
  });

  test("요약에 ## 절 제목 줄이 있으면 거절(파일 짜임을 지킨다)", async () => {
    const r = await run({ action: "create", name: "깨짐", text: "첫 줄\n## 메모\n가짜 절" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/##/);
  });
});

describe("list", () => {
  test("프로젝트가 없으면 안내", async () => {
    const r = await run({ action: "list" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/없어요/);
  });

  test("진행 중과 보관을 나눠 이름 · 요약 첫 줄 · 마지막 기록 날짜를 보인다", async () => {
    await run({ action: "create", name: "이사 준비", text: "6월 이사\n둘째 줄" });
    await run({ action: "create", name: "옛일", text: "끝난 일" });
    await put(`프로젝트/이사 준비/기록-맥A.md`, "- 2026-11-01 09:00 「가」 — https://a.example/ · 성공\n- 2026-11-20 10:00 「나」 — https://b.example/ · 성공\n");
    await put(`프로젝트/이사 준비/기록-맥B.md`, "- 2026-11-10 08:00 「다」 — https://c.example/ · 성공\n");
    await run({ action: "archive", name: "옛일" });
    const r = await run({ action: "list" });
    const [head, ...rest] = r.text.split("\n");
    expect(head).toMatch(/진행 중/);
    const text = rest.join("\n");
    expect(text).toContain("- 이사 준비 · 6월 이사 · 마지막 기록 2026-11-20");
    expect(text).not.toContain("둘째 줄");
    const archivedAt = r.text.indexOf("보관");
    expect(archivedAt).toBeGreaterThan(r.text.indexOf("이사 준비"));
    expect(r.text.slice(archivedAt)).toContain("- 옛일 · 끝난 일 · 기록 없음");
    expect(r.text.slice(0, archivedAt)).not.toContain("옛일");
  });

  test("요약이 비면 요약 없음", async () => {
    await run({ action: "create", name: "빈" });
    const r = await run({ action: "list" });
    expect(r.text).toContain("- 빈 · 요약 없음 · 기록 없음");
  });

  test("보관 폴더 이름이나 파일은 프로젝트로 보이지 않는다", async () => {
    await put("프로젝트/메모.txt", "x");
    await run({ action: "create", name: "하나" });
    await run({ action: "archive", name: "하나" });
    const r = await run({ action: "list" });
    expect(r.text).not.toMatch(/^- 보관 /m);
    expect(r.text).not.toContain("메모.txt");
  });
});

describe("open", () => {
  async function seed() {
    await run({ action: "create", name: "이사 준비", text: "6월에 이사" });
    await run({ action: "update", name: "이사 준비", section: "조건", text: "예산 3억 이하" });
    await run({ action: "update", name: "이사 준비", section: "사이트", text: "https://a.example/list\nhttps://b.example/" });
    await run({ action: "save_doc", name: "이사 준비", doc: "체크리스트", text: "- 이삿짐센터 견적" });
  }

  test("열면 state.openProject 가 서고 요약 · 조건 · 사이트 · 문서 · 최근 기록이 나온다", async () => {
    await seed();
    await put(`프로젝트/이사 준비/기록-${machineName()}.md`, "- 2026-11-20 10:00 「가격 보기」 — https://a.example/ · 성공\n");
    const r = await run({ action: "open", name: "이사 준비" });
    expect(r.isError).toBeFalsy();
    expect(ctx.activity.state.openProject).toBe("이사 준비");
    expect(r.text.split("\n")[0]).toBe("열린 프로젝트: 이사 준비");
    expect(r.text).toContain("6월에 이사");
    expect(r.text).toContain("예산 3억 이하");
    expect(r.text).toContain("- https://a.example/list");
    expect(r.text).toContain("문서/체크리스트.md");
    expect(r.text).toContain("2026-11-20 10:00 「가격 보기」");
  });

  test("최근 기록 5줄: 두 맥의 기록을 합쳐 날짜 · 시각 최신순", async () => {
    await run({ action: "create", name: "p" });
    await put("프로젝트/p/기록-맥A.md", ["- 2026-11-01 09:00 「a1」 — x", "- 2026-11-05 23:50 「a2」 — x", "- 2026-11-07 07:00 「a3」 — x"].join("\n") + "\n");
    await put("프로젝트/p/기록-맥B.md", ["- 2026-11-05 08:00 「b1」 — x", "- 2026-11-07 07:30 「b2」 — x", "- 2026-11-09 12:00 「b3」 — x"].join("\n") + "\n");
    const recent = await recentRecords(home, "프로젝트/p", 5);
    expect(recent.map((l) => /「(.*?)」/.exec(l)![1])).toEqual(["b3", "b2", "a3", "a2", "b1"]);
    const r = await run({ action: "open", name: "p" });
    const idx = ["b3", "b2", "a3", "a2", "b1"].map((t) => r.text.indexOf(`「${t}」`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(r.text).not.toContain("「a1」");
  });

  test("날짜 없는 옛 형식 줄은 최근 기록에 넣지 않는다", async () => {
    await run({ action: "create", name: "p" });
    await put(`프로젝트/p/기록-맥A.md`, "- 14:05 「옛」 — x\n- 2026-11-02 10:00 「새」 — x\n");
    const recent = await recentRecords(home, "프로젝트/p", 5);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("「새」");
  });

  test("빈 이름이면 닫는다", async () => {
    await seed();
    await run({ action: "open", name: "이사 준비" });
    const r = await run({ action: "open", name: "" });
    expect(r.isError).toBeFalsy();
    expect(ctx.activity.state.openProject).toBeNull();
    expect(r.text).not.toContain("열린 프로젝트:");
    const again = await run({ action: "open" });
    expect(again.isError).toBeFalsy();
  });

  test("없는 이름은 한국어 오류와 있는 프로젝트 목록", async () => {
    await seed();
    await run({ action: "create", name: "여행" });
    const r = await run({ action: "open", name: "없는일" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("없는일");
    expect(r.text).toContain("이사 준비");
    expect(r.text).toContain("여행");
    expect(ctx.activity.state.openProject).toBeNull();
  });

  test("프로젝트가 하나도 없을 때 없는 이름 오류", async () => {
    const r = await run({ action: "open", name: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/프로젝트가 없어요|없어요/);
  });

  test("보관된 프로젝트는 열 수 없다(오류, 열린 것 그대로)", async () => {
    await run({ action: "create", name: "옛일" });
    await run({ action: "archive", name: "옛일" });
    const r = await run({ action: "open", name: "옛일" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("보관");
    expect(ctx.activity.state.openProject).toBeNull();
  });

  test("이름이 규칙에 어긋나면 오류", async () => {
    const r = await run({ action: "open", name: ".." });
    expect(r.isError).toBe(true);
  });

  test("NFD 로 만든 폴더 「이사 준비」를 NFC 이름으로 연다", async () => {
    const nfdDir = "이사 준비".normalize("NFD");
    const md = "# 이사 준비\n\n## 요약\n한글 폴더\n\n## 조건\n\n## 사이트\n\n## 메모\n\n## 상태\n진행 중\n";
    await mkdir(`${tmp.dir}/프로젝트/${nfdDir}`, { recursive: true });
    await writeFile(`${tmp.dir}/프로젝트/${nfdDir}/프로젝트.md`, md, "utf8");
    const r = await run({ action: "open", name: "이사 준비".normalize("NFC") });
    expect(r.isError).toBeFalsy();
    expect(ctx.activity.state.openProject).toBe("이사 준비".normalize("NFC"));
    expect(r.text).toContain("한글 폴더");
    const again = await run({ action: "create", name: "이사 준비" });
    expect(again.text).toContain("이미 있어요");
  });

  test("요약 · 조건이 아주 커도 결과는 8KB 안이고 최근 기록은 남는다", async () => {
    await run({ action: "create", name: "큰" });
    await put(PM("큰"), `# 큰\n\n## 요약\n${"가나다라 ".repeat(1000)}\n\n## 조건\n${"마바사 ".repeat(1500)}\n\n## 사이트\n${"- https://a.example/x\n".repeat(400)}\n## 메모\n\n## 상태\n진행 중\n`);
    for (let i = 0; i < 40; i++) await put(`프로젝트/큰/문서/문서${i}.md`, "x");
    await put(`프로젝트/큰/기록-${machineName()}.md`, "- 2026-11-20 10:00 「마지막 일」 — https://a.example/ · 성공\n");
    const r = await run({ action: "open", name: "큰" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    expect(r.text).toContain("「마지막 일」");
  });

  test("가장 나쁜 경우(절 셋이 꽉 차고, 긴 이름 문서 20개 · 긴 기록 줄 5개)에도 8KB 안이고 최근 기록 5줄이 다 남는다", async () => {
    await run({ action: "create", name: "최악" });
    const fill = (w: string) => w.repeat(600); // 한글 1,800바이트 = 절 상한(1,200)을 넘긴다
    await put(PM("최악"), `# 최악\n\n## 요약\n${fill("가")}\n\n## 조건\n${fill("나")}\n\n## 사이트\n${fill("다")}\n\n## 메모\n\n## 상태\n진행 중\n`);
    for (let i = 0; i < 25; i++) await put(`프로젝트/최악/문서/${"긴이름".repeat(18)}${i}.md`, "x"); // 한글 54자 + 번호
    const lines = Array.from({ length: 6 }, (_, i) => `- 2026-11-2${i} 10:00 「${"기록".repeat(80)}${i}」 — https://a.example/ · 성공`).join("\n");
    await put(`프로젝트/최악/기록-${machineName()}.md`, lines + "\n");
    const r = await run({ action: "open", name: "최악" });
    expect(bytes(r.text)).toBeLessThanOrEqual(8192);
    for (let i = 1; i < 6; i++) expect(r.text).toContain(`2026-11-2${i} 10:00`); // 최신 5줄
    expect(r.text).not.toContain("2026-11-20 10:00");
    expect(r.text).not.toContain("…" + "\n8KB"); // 본문이 잘려 나가지 않았다
    expect(r.text).not.toContain("8KB 를 넘는 부분");
  });

  test("열면 touch() — 30분이 지나면 열려 있던 것이 풀린다", async () => {
    await run({ action: "create", name: "p" });
    await run({ action: "open", name: "p" });
    clock = new Date(clock.getTime() + 31 * 60_000);
    const r = await run({ action: "list" });
    expect(r.text).not.toContain("열린 프로젝트:");
  });
});

describe("update", () => {
  beforeEach(async () => {
    await run({ action: "create", name: "p", text: "처음 요약" });
  });

  test("열린 프로젝트의 절을 replace(기본)로 바꾼다, 다른 절은 그대로", async () => {
    await run({ action: "open", name: "p" });
    await run({ action: "update", section: "조건", text: "예산 1억" });
    const r = await run({ action: "update", section: "요약", text: "새 요약" });
    expect(r.isError).toBeFalsy();
    const md = (await home.read(PM("p")))!;
    expect(readSection(md, "요약")).toBe("새 요약");
    expect(readSection(md, "조건")).toBe("예산 1억");
    expect(readSection(md, "상태")).toBe("진행 중");
    expect(md.split("\n")[0]).toBe("# p");
  });

  test("append 는 절 끝에 덧붙인다", async () => {
    await run({ action: "update", name: "p", section: "메모", text: "- 첫 메모" });
    await run({ action: "update", name: "p", section: "메모", text: "- 둘째 메모", mode: "append" });
    expect(readSection((await home.read(PM("p")))!, "메모")).toBe("- 첫 메모\n- 둘째 메모");
  });

  test("name 을 주면 열린 프로젝트가 없어도, 다른 프로젝트여도 그 프로젝트에", async () => {
    await run({ action: "create", name: "q" });
    await run({ action: "open", name: "q" });
    await run({ action: "update", name: "p", section: "조건", text: "p 조건" });
    expect(readSection((await home.read(PM("p")))!, "조건")).toBe("p 조건");
    expect(readSection((await home.read(PM("q")))!, "조건")).toBe("");
  });

  test("열린 프로젝트도 name 도 없으면 한국어 오류", async () => {
    const r = await run({ action: "update", section: "요약", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/프로젝트/);
  });

  test("없는 프로젝트 · 잘못된 section · text 없음은 오류", async () => {
    expect((await run({ action: "update", name: "없음", section: "요약", text: "x" })).isError).toBe(true);
    expect((await run({ action: "update", name: "p", section: "상태" as never, text: "x" })).isError).toBe(true);
    expect((await run({ action: "update", name: "p", text: "x" })).isError).toBe(true);
    expect((await run({ action: "update", name: "p", section: "요약" })).isError).toBe(true);
    expect((await run({ action: "update", name: "p", section: "요약", text: "x", mode: "합치기" as never })).isError).toBe(true);
  });

  test("민감한 값은 거절하고 파일은 그대로", async () => {
    const before = await home.read(PM("p"));
    const r = await run({ action: "update", name: "p", section: "메모", text: "비밀번호: hunter22" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("비밀번호");
    expect(await home.read(PM("p"))).toBe(before);
  });

  test("4,000자 넘으면 거절, 4,000자는 통과(글자 = 코드 포인트)", async () => {
    const big = await run({ action: "update", name: "p", section: "메모", text: "가".repeat(4001) });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/4,000/);
    expect((await run({ action: "update", name: "p", section: "메모", text: "😀".repeat(4000) })).isError).toBeFalsy();
  });

  test("## 로 시작하는 줄은 거절(절 짜임을 깨지 못한다), # · ### 는 통과(절을 끊지 않는다)", async () => {
    expect((await run({ action: "update", name: "p", section: "메모", text: "## 새 절" })).isError).toBe(true);
    expect((await run({ action: "update", name: "p", section: "메모", text: "# 셸 주석 같은 줄" })).isError).toBeFalsy();
    expect((await run({ action: "update", name: "p", section: "메모", text: "### 작은 제목\n내용" })).isError).toBeFalsy();
    const md = (await home.read(PM("p")))!;
    expect([...md.matchAll(/^## (.*)$/gm)].map((m) => m[1])).toEqual(["요약", "조건", "사이트", "메모", "상태"]);
  });

  test("사이트 절은 줄마다 「- 」를 붙여 저장한다", async () => {
    await run({ action: "update", name: "p", section: "사이트", text: "https://a.example/\n- https://b.example/" });
    expect(readSection((await home.read(PM("p")))!, "사이트")).toBe("- https://a.example/\n- https://b.example/");
  });

  test("보관된 프로젝트는 고치지 않는다", async () => {
    await run({ action: "archive", name: "p" });
    const r = await run({ action: "update", name: "p", section: "요약", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("보관");
  });

  test("동시에 여러 번 덧붙여도 줄이 사라지지 않는다", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => run({ action: "update", name: "p", section: "메모", text: `- 줄${i}`, mode: "append" })));
    const body = readSection((await home.read(PM("p")))!, "메모")!;
    for (let i = 0; i < 12; i++) expect(body).toContain(`- 줄${i}`);
  });
});

describe("save_doc", () => {
  beforeEach(async () => {
    await run({ action: "create", name: "p" });
    await run({ action: "open", name: "p" });
  });

  test("문서/<doc>.md 로 저장(replace), 다시 저장하면 덮어쓴다", async () => {
    const r = await run({ action: "save_doc", doc: "비교표", text: "처음" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("프로젝트/p/문서/비교표.md");
    expect(await home.read("프로젝트/p/문서/비교표.md")).toBe("처음");
    await run({ action: "save_doc", doc: "비교표", text: "고침" });
    expect(await home.read("프로젝트/p/문서/비교표.md")).toBe("고침");
  });

  test("doc 이름은 안전하게(a/b → a-b, 끝의 .md 는 한 번만), 위험한 이름은 거절", async () => {
    await run({ action: "save_doc", doc: "a/b", text: "x" });
    await run({ action: "save_doc", doc: "메모.md", text: "y" });
    expect((await home.list("프로젝트/p/문서")).sort()).toEqual(["a-b.md", "메모.md"]);
    for (const d of ["..", ".숨김", "가".repeat(65), "   "]) {
      expect((await run({ action: "save_doc", doc: d, text: "x" })).isError).toBe(true);
    }
    expect((await run({ action: "save_doc", text: "x" })).isError).toBe(true);
    expect(await exists("프로젝트/문서")).toBe(false);
  });

  test("name 이 없고 열린 프로젝트도 없으면 오류", async () => {
    await run({ action: "open", name: "" });
    const r = await run({ action: "save_doc", doc: "x", text: "y" });
    expect(r.isError).toBe(true);
  });

  test("20,000자 넘으면 거절, 민감한 값도 거절", async () => {
    const big = await run({ action: "save_doc", doc: "큰", text: "가".repeat(20001) });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/20,000/);
    expect((await run({ action: "save_doc", doc: "큰", text: "가".repeat(20000) })).isError).toBeFalsy();
    const secret = await run({ action: "save_doc", doc: "키", text: "AIza" + "a".repeat(35) });
    expect(secret.isError).toBe(true);
    expect(await exists("프로젝트/p/문서/키.md")).toBe(false);
  });

  test("text 가 비면 오류", async () => {
    expect((await run({ action: "save_doc", doc: "x", text: "" })).isError).toBe(true);
  });
});

describe("open_sites", () => {
  async function withSites(lines: string) {
    await run({ action: "create", name: "p" });
    await put(PM("p"), `# p\n\n## 요약\n\n## 조건\n\n## 사이트\n${lines}\n\n## 메모\n\n## 상태\n진행 중\n`);
    await run({ action: "open", name: "p" });
  }

  test("사이트 절의 주소를 차례로 연다 · 결과에 개수와 주소", async () => {
    await withSites("- https://a.example/1\n- http://b.example/2");
    const r = await run({ action: "open_sites" });
    expect(r.isError).toBeFalsy();
    expect(opened).toEqual([["https://a.example/1", "http://b.example/2"]]);
    expect(r.text).toContain("2개");
    expect(r.text).toContain("https://a.example/1");
    expect(r.text).toContain("http://b.example/2");
    expect(r.text.split("\n")[0]).toBe("열린 프로젝트: p");
  });

  test("하루 기록: 제목 「프로젝트 사이트 열기」 와 닿은 곳을 recordOpened 로 넘긴다", async () => {
    await withSites("- https://a.example/1");
    await run({ action: "open_sites" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.title).toBe("프로젝트 사이트 열기");
    expect(recorded[0]!.ok).toBe(true);
    expect(recorded[0]!.touched.map((t) => t.url)).toEqual(["https://a.example/1"]);
  });

  test("recordOpened 가 돌려준 글(사이트 메모 등)은 결과 끝에 붙는다", async () => {
    await withSites("- https://a.example/1");
    ctx.recordOpened = async () => ["… 이 사이트 메모(a.example): 메모"];
    const r = await run({ action: "open_sites" });
    expect(r.text).toContain("… 이 사이트 메모(a.example): 메모");
  });

  test("11개면 앞 10개만 열고 안내", async () => {
    await withSites(Array.from({ length: 11 }, (_, i) => `- https://a.example/${i}`).join("\n"));
    const r = await run({ action: "open_sites" });
    expect(opened[0]).toHaveLength(10);
    expect(opened[0]![9]).toBe("https://a.example/9");
    expect(r.text).toMatch(/10개/);
    expect(r.text).toMatch(/11개/);
  });

  test("http · https 가 아닌 주소 · 주소 아닌 줄은 건너뛰고 알린다, 같은 주소는 한 번", async () => {
    await withSites("- https://a.example/1\n- javascript:alert(1)\n- file:///etc/passwd\n- 그냥 글\n- https://a.example/1\n- ftp://x.example/");
    const r = await run({ action: "open_sites" });
    expect(opened).toEqual([["https://a.example/1"]]);
    expect(r.text).toMatch(/건너/);
    expect(r.text).toContain("javascript:alert(1)");
  });

  test("열 주소가 하나도 없으면 연 일 없이 오류", async () => {
    await withSites("- file:///x");
    const r = await run({ action: "open_sites" });
    expect(r.isError).toBe(true);
    expect(opened).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("사이트 절이 비어 있으면 오류", async () => {
    await run({ action: "create", name: "q" });
    const r = await run({ action: "open_sites", name: "q" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/사이트/);
  });

  test("열린 프로젝트도 name 도 없으면 오류", async () => {
    const r = await run({ action: "open_sites" });
    expect(r.isError).toBe(true);
  });

  test("탭을 열지 못한 오류(error)는 오류 결과로, 그래도 기록은 남긴다", async () => {
    await withSites("- https://a.example/1");
    ctx.openTabs = async () => ({ output: "못 열었어요: https://a.example/1 — x", error: "열린 탭이 없어요" });
    const r = await run({ action: "open_sites" });
    expect(r.isError).toBe(true);
    expect(recorded[0]!.ok).toBe(false);
    expect(recorded[0]!.error).toBe("열린 탭이 없어요");
  });

  test("연결 도구가 없으면(openTabs 없음) 오류", async () => {
    await withSites("- https://a.example/1");
    ctx.openTabs = undefined;
    expect((await run({ action: "open_sites" })).isError).toBe(true);
  });
});

describe("archive", () => {
  test("프로젝트/<이름>/ 을 프로젝트/보관/<이름>/ 으로 옮기고 상태를 보관으로", async () => {
    await run({ action: "create", name: "p", text: "요약" });
    await put("프로젝트/p/문서/a.md", "문서");
    const r = await run({ action: "archive", name: "p" });
    expect(r.isError).toBeFalsy();
    expect(await exists("프로젝트/p")).toBe(false);
    expect(await home.read("프로젝트/보관/p/문서/a.md")).toBe("문서");
    expect(readSection((await home.read("프로젝트/보관/p/프로젝트.md"))!, "상태")).toBe("보관");
    expect(r.text).toContain("프로젝트/보관/p");
  });

  test("같은 이름이 이미 보관돼 있으면 -2, -3", async () => {
    for (let i = 0; i < 3; i++) {
      // 이름을 비우려고 보관된 것은 그대로 두고, 새로 만들 수 없으니 폴더를 직접 만든다
      await put("프로젝트/x/프로젝트.md", "# x\n\n## 요약\n\n## 상태\n진행 중\n");
      if (i > 0) expect(await exists("프로젝트/보관/x")).toBe(true);
      const r = await run({ action: "archive", name: "x" });
      expect(r.isError).toBeFalsy();
    }
    expect((await home.list("프로젝트/보관")).sort()).toEqual(["x", "x-2", "x-3"]);
  });

  test("열려 있던 프로젝트면 닫는다(첫 줄 이름도 없다), 다른 것이 열려 있으면 그대로", async () => {
    await run({ action: "create", name: "p" });
    await run({ action: "create", name: "q" });
    await run({ action: "open", name: "q" });
    const other = await run({ action: "archive", name: "p" });
    expect(ctx.activity.state.openProject).toBe("q");
    expect(other.text.split("\n")[0]).toBe("열린 프로젝트: q");
    const mine = await run({ action: "archive", name: "q" });
    expect(ctx.activity.state.openProject).toBeNull();
    expect(mine.text).not.toContain("열린 프로젝트:");
  });

  test("name 이 없으면 열린 프로젝트를 보관", async () => {
    await run({ action: "create", name: "p" });
    await run({ action: "open", name: "p" });
    expect((await run({ action: "archive" })).isError).toBeFalsy();
    expect(await exists("프로젝트/보관/p/프로젝트.md")).toBe(true);
    expect((await run({ action: "archive" })).isError).toBe(true);
  });

  test("없는 이름 · 이미 보관된 것은 오류", async () => {
    expect((await run({ action: "archive", name: "없음" })).isError).toBe(true);
    await run({ action: "create", name: "p" });
    await run({ action: "archive", name: "p" });
    const again = await run({ action: "archive", name: "p" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("보관");
  });

  test("보관 뒤 list 의 보관 칸에 나온다", async () => {
    await run({ action: "create", name: "p", text: "끝난 일" });
    await run({ action: "archive", name: "p" });
    const r = await run({ action: "list" });
    const archived = r.text.slice(r.text.indexOf("보관"));
    expect(archived).toContain("- p · 끝난 일");
    expect(r.text.slice(0, r.text.indexOf("보관"))).not.toContain("- p ·");
  });
});

describe("공통", () => {
  test("알 수 없는 action 은 오류", async () => {
    const r = await run({ action: "해줘" as never });
    expect(r.isError).toBe(true);
  });

  test("쓸 수 없는 기억 폴더: 쓰는 action 은 한 줄 오류, list 는 그대로", async () => {
    await writeFile(tmp.dir + "/막힘", "파일");
    const blocked = new MemoryHome(tmp.dir + "/막힘/아래");
    const c = makeCtx(blocked);
    const r = await runProjectTool(c, { action: "create", name: "p" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^기억 폴더에 쓸 수 없어요: .*막힘\/아래 — /);
    expect((await runProjectTool(c, { action: "list" })).isError).toBeFalsy();
  });

  test("정리 안내는 여기서도 한 번 붙는다", async () => {
    await put(`기억/일지/2026-11-01-${machineName()}.md`, "- 09:00 「가」 — https://a.example/ · 성공\n");
    const first = await run({ action: "list" });
    expect(first.text).toContain("기억 정리할 때가 됐어요");
    const second = await run({ action: "list" });
    expect(second.text).not.toContain("기억 정리할 때가 됐어요");
  });

  test("만든 파일 목록(readdir)에 임시 파일이 남지 않는다", async () => {
    await run({ action: "create", name: "p" });
    await run({ action: "update", name: "p", section: "메모", text: "x" });
    expect((await readdir(home.path("프로젝트/p"))).sort()).toEqual(["프로젝트.md"]);
  });

  test("충돌본이 있으면 끝 줄에 알린다", async () => {
    await run({ action: "create", name: "p" });
    await put("프로젝트/p/프로젝트 2.md", "# p\n");
    const r = await run({ action: "update", name: "p", section: "메모", text: "x" });
    expect(r.text).toContain("충돌본이 있어요");
    expect(r.text).toContain("프로젝트/p/프로젝트 2.md");
  });
});
