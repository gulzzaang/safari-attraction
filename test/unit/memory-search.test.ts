import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryHome } from "../../src/memory/home.js";
import { MemoryIndex, formatHits, tokenize } from "../../src/memory/search.js";
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

async function put(rel: string, text: string, mtime?: Date): Promise<void> {
  const p = home.path(rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, "utf8");
  if (mtime) await utimes(p, mtime, mtime);
}

const NOW = new Date(2026, 10, 23, 12, 0, 0); // 2026-11-23 지역 시각

describe("tokenize", () => {
  test("한글 덩어리는 두 글자씩, 한 글자 덩어리는 그 글자", () => {
    expect(tokenize("노트북")).toEqual(["노트", "트북"]);
    expect(tokenize("본 노트북")).toEqual(["본", "노트", "트북"]);
    expect(tokenize("지난주에")).toEqual(["지난", "난주", "주에"]);
  });

  test("영문 · 숫자는 소문자 낱말(2자 이상), 나머지는 무시", () => {
    expect(tokenize("MacBook Pro 14, a 7 ... #!")).toEqual(["macbook", "pro", "14"]);
    expect(tokenize("LG그램")).toEqual(["lg", "그램"]);
  });

  test("NFD 글자도 NFC 로 맞춘 뒤 쪼갠다", () => {
    expect(tokenize("노트북".normalize("NFD"))).toEqual(["노트", "트북"]);
  });

  test("빈 글 · 기호만 있는 글은 빈 목록", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("  ... --- ")).toEqual([]);
  });
});

describe("MemoryIndex.search", () => {
  test("「지난주에 본 노트북」으로 일지/보관 의 「LG 그램 노트북 비교」 줄을 1등으로 찾는다", async () => {
    await put(
      "기억/일지/보관/2026-11-16-맥.md",
      "- 09:00 「뉴스 홈」 — naver.com · 성공\n- 14:05 「LG 그램 노트북 비교」 — danawa.com · 성공\n- 15:00 「날씨」 — weather.com · 성공\n",
    );
    await put("기억/일지/2026-11-22-맥.md", "- 10:00 「지난 경기 결과」 — sports.com · 성공\n");
    await put("기억/나.md", "- 2026-11-01 커피는 아침에만 마신다\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    await idx.refresh();
    const hits = await idx.search("지난주에 본 노트북");
    expect(hits[0].file).toBe("기억/일지/보관/2026-11-16-맥.md");
    expect(hits[0].snippet).toContain("LG 그램 노트북 비교");
    expect(hits[0].date).toBe("2026-11-16");
  });

  test("영문 낱말(macbook)은 대소문자와 관계없이 찾는다", async () => {
    await put("기억/나.md", "- 2026-11-20 Macbook Pro 14 를 샀다\n\n- 2026-11-20 점심은 김치찌개\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("MACBOOK");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("Macbook Pro 14");
  });

  test("NFD 로 쓴 질문도 NFC 파일 글을 찾는다", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북 충전기를 잃어버렸다\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북".normalize("NFD"));
    expect(hits).toHaveLength(1);
  });

  test("빈 질문 · 기호뿐인 질문은 빈 결과", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("")).toEqual([]);
    expect(await idx.search("   ")).toEqual([]);
    expect(await idx.search("!!! ...")).toEqual([]);
  });

  test("맞는 게 없으면 빈 결과, 기억이 아예 없어도 오류 없이 빈 결과", async () => {
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("노트북")).toEqual([]);
    await put("기억/나.md", "- 2026-11-20 커피\n");
    expect(await idx.search("노트북")).toEqual([]);
  });

  test("점수가 같고 최근도도 같으면(둘 다 30일 넘게 옛것) 더 최근 날짜가 먼저", async () => {
    await put("기억/일지/2026-01-10-맥.md", "- 10:00 「노트북 비교」\n");
    await put("기억/일지/2026-03-10-맥.md", "- 10:00 「노트북 비교」\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북 비교");
    expect(hits.map((h) => h.date)).toEqual(["2026-03-10", "2026-01-10"]);
    expect(hits[0].score).toBeCloseTo(hits[1].score, 10);
  });

  test("최근 가산: 같은 글이면 최근 것의 점수가 (1+0.5×최근도) 비율만큼 높다", async () => {
    await put("기억/일지/2026-11-20-맥.md", "- 10:00 「노트북 비교」\n"); // 3일 전 → 최근도 0.9
    await put("기억/일지/2026-11-10-맥.md", "- 10:00 「노트북 비교」\n"); // 13일 전 → 최근도 17/30
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북 비교");
    expect(hits.map((h) => h.date)).toEqual(["2026-11-20", "2026-11-10"]);
    const want = (1 + 0.5 * 0.9) / (1 + 0.5 * (17 / 30));
    expect(hits[0].score / hits[1].score).toBeCloseTo(want, 10);
  });

  test("미래 날짜는 오늘로 친다(최근도 1 상한)", async () => {
    await put("기억/일지/2026-12-30-맥.md", "- 10:00 「노트북 비교」\n");
    await put("기억/일지/2026-11-23-맥.md", "- 10:00 「노트북 비교」\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북 비교");
    expect(hits[0].score).toBeCloseTo(hits[1].score, 10);
  });

  test("날짜 규칙: 파일 이름 → 문단 첫 `- YYYY-MM-DD` 줄 → 파일 수정 시각(지역 날짜)", async () => {
    await put("기억/일지/2026-11-05-맥.md", "- 10:00 「가나다라마 이야기」 — 2026-01-01\n");
    await put("기억/나.md", "- 2026-11-18 바사아자차 이야기\n- 2026-11-19 다른 줄\n");
    await put("기억/오래-기억.md", "카타파하 이야기\n", new Date(2026, 9, 2, 23, 59, 0));
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect((await idx.search("가나다라마"))[0].date).toBe("2026-11-05");
    expect((await idx.search("바사아자차"))[0].date).toBe("2026-11-18");
    expect((await idx.search("카타파하"))[0].date).toBe("2026-10-02");
  });

  test("스니펫은 맞은 줄과 앞뒤 한 줄(문단 안), 300자 상한", async () => {
    const lines = ["- 첫째 줄 알파", "- 둘째 줄 베타", "- 셋째 줄 감마 노트북", "- 넷째 줄 델타", "- 다섯째 줄 엡실론"];
    await put("기억/나.md", lines.join("\n") + "\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const [hit] = await idx.search("노트북");
    expect(hit.snippet).toBe(["- 둘째 줄 베타", "- 셋째 줄 감마 노트북", "- 넷째 줄 델타"].join("\n"));

    await put("기억/나.md", `- ${"가".repeat(500)} 노트북\n`);
    const [long] = await idx.search("노트북");
    expect([...long.snippet].length).toBeLessThanOrEqual(300);
  });

  test("문단은 빈 줄로 나뉘고, 스니펫은 다른 문단 줄을 끌어오지 않는다", async () => {
    await put("기억/나.md", "- 윗 문단 줄\n\n- 노트북 이야기\n\n- 아랫 문단 줄\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const [hit] = await idx.search("노트북");
    expect(hit.snippet).toBe("- 노트북 이야기");
  });

  test("limit 기본 5, 지정하면 그만큼", async () => {
    for (let i = 1; i <= 8; i++) await put(`기억/일지/2026-11-0${i}-맥.md`, `- 10:00 「노트북 ${i}번」\n`);
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("노트북")).toHaveLength(5);
    expect(await idx.search("노트북", { limit: 2 })).toHaveLength(2);
    expect(await idx.search("노트북", { limit: 20 })).toHaveLength(8);
  });

  test("scope: memory 는 기억/ 만, projects 는 프로젝트/ 만, 기본은 둘 다", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북 이야기\n");
    await put("프로젝트/여행/프로젝트.md", "노트북 챙기기\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect((await idx.search("노트북")).map((h) => h.file).sort()).toEqual(["기억/나.md", "프로젝트/여행/프로젝트.md"]);
    expect((await idx.search("노트북", { scope: "all" })).length).toBe(2);
    expect((await idx.search("노트북", { scope: "memory" })).map((h) => h.file)).toEqual(["기억/나.md"]);
    expect((await idx.search("노트북", { scope: "projects" })).map((h) => h.file)).toEqual(["프로젝트/여행/프로젝트.md"]);
  });

  test("프로젝트 보관 폴더와 프로젝트 문서도 찾는다", async () => {
    await put("프로젝트/보관/옛일/문서/메모.md", "맥북 구입 메모\n");
    await put("프로젝트/새일/문서/설계.md", "맥북 설계\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const files = (await idx.search("맥북")).map((h) => h.file).sort();
    expect(files).toEqual(["프로젝트/보관/옛일/문서/메모.md", "프로젝트/새일/문서/설계.md"]);
  });

  test("project 지정: 그 프로젝트 파일 점수 ×1.2, 그래도 다른 것과 겨룬다", async () => {
    await put("프로젝트/여행/프로젝트.md", "노트북 챙기기\n");
    await put("프로젝트/출장/프로젝트.md", "노트북 챙기기\n");
    const mtime = new Date(2026, 10, 1);
    await utimes(home.path("프로젝트/여행/프로젝트.md"), mtime, mtime);
    await utimes(home.path("프로젝트/출장/프로젝트.md"), mtime, mtime);
    const idx = new MemoryIndex(home, { now: () => NOW });
    const plain = await idx.search("노트북");
    expect(plain[0].score).toBeCloseTo(plain[1].score, 10);
    const boosted = await idx.search("노트북", { project: "출장" });
    expect(boosted[0].file).toBe("프로젝트/출장/프로젝트.md");
    expect(boosted[0].score).toBeCloseTo(plain[0].score * 1.2, 10);
    expect(boosted[1].score).toBeCloseTo(plain[1].score, 10);
    // NFD 이름도 같은 프로젝트로 본다
    const nfd = await idx.search("노트북", { project: "출장".normalize("NFD") });
    expect(nfd[0].file).toBe("프로젝트/출장/프로젝트.md");
  });

  test("가산이 작으면 더 잘 맞는 다른 파일이 이긴다", async () => {
    await put("프로젝트/여행/프로젝트.md", "노트북\n", new Date(2026, 10, 1));
    await put("기억/나.md", "- 2026-11-22 노트북 충전기 비교\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북 충전기", { project: "여행" });
    expect(hits[0].file).toBe("기억/나.md");
  });

  test(".md 가 아닌 파일 · 점으로 시작하는 이름(임시 · iCloud 자리표시)은 색인하지 않는다", async () => {
    await put("기억/나.md", "- 2026-11-20 커피\n");
    await put("기억/.나.md.123.tmp", "노트북 임시\n");
    await put("기억/.DS_Store", "노트북 찌꺼기\n");
    await put("기억/.오래.md.icloud", "노트북 자리표시\n");
    await put("기억/사이트/메모.txt", "노트북 텍스트\n");
    await put("기억/.숨김/비밀.md", "노트북 숨김 폴더\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("노트북")).toEqual([]);
  });
});

describe("MemoryIndex.refresh", () => {
  test("바뀐 파일만 다시 읽는다 — 변화 없으면 0, 하나 바뀌면 1", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북\n");
    await put("기억/일지/2026-11-21-맥.md", "- 10:00 「커피」\n");
    await put("프로젝트/여행/프로젝트.md", "비행기표\n");
    const read = vi.spyOn(home, "read");
    const idx = new MemoryIndex(home, { now: () => NOW });
    await idx.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    read.mockClear();
    await idx.refresh();
    expect(read).toHaveBeenCalledTimes(0);
    await idx.search("노트북"); // 찾기도 안 바뀐 파일은 다시 읽지 않는다.
    expect(read).toHaveBeenCalledTimes(0);

    await put("기억/일지/2026-11-21-맥.md", "- 10:00 「커피」\n- 11:00 「새 노트북 후기」\n", new Date(2026, 10, 22, 8, 0, 0));
    await idx.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("기억/일지/2026-11-21-맥.md");
    expect((await idx.search("후기")).map((h) => h.file)).toEqual(["기억/일지/2026-11-21-맥.md"]);
  });

  test("바꾼 파일의 옛 글은 결과에서 빠진다", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북\n", new Date(2026, 10, 20, 8, 0, 0));
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("노트북")).toHaveLength(1);
    await put("기억/나.md", "- 2026-11-20 커피\n", new Date(2026, 10, 21, 8, 0, 0));
    expect(await idx.search("노트북")).toEqual([]);
    expect(await idx.search("커피")).toHaveLength(1);
  });

  test("지운 파일은 결과에서 빠지고, 새 파일은 잡힌다", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북\n");
    await put("기억/일지/2026-11-21-맥.md", "- 10:00 「노트북 후기」\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    expect(await idx.search("노트북")).toHaveLength(2);
    await rm(home.path("기억/나.md"));
    expect((await idx.search("노트북")).map((h) => h.file)).toEqual(["기억/일지/2026-11-21-맥.md"]);
    await put("프로젝트/새일/프로젝트.md", "노트북 준비\n");
    expect(await idx.search("노트북")).toHaveLength(2);
  });

  test("지운 파일의 문단은 점수 계산(전체 문단 수 · 낱말 문단 수)에서도 빠진다", async () => {
    await put("기억/가.md", "노트북 이야기\n");
    await put("기억/나.md", "커피 이야기\n\n빵 이야기\n\n차 이야기\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const before = (await idx.search("노트북"))[0].score;
    await rm(home.path("기억/나.md"));
    const after = (await idx.search("노트북"))[0].score;
    // 문단 4개 중 1개 → log(1+4/1), 문단 1개 중 1개 → log(1+1/1)
    expect(after / before).toBeCloseTo(Math.log(2) / Math.log(5), 10);
  });

  test("동시에 refresh 를 불러도 같은 파일이 두 번 색인되지 않는다", async () => {
    await put("기억/나.md", "노트북 이야기\n", new Date(2026, 10, 23, 8, 0, 0));
    const idx = new MemoryIndex(home, { now: () => NOW });
    await Promise.all([idx.refresh(), idx.refresh(), idx.search("노트북")]);
    const hits = await idx.search("노트북");
    expect(hits).toHaveLength(1);
    // 낱말 2개(노트 · 트북) × (문단 1개 중 1개 → log(2)), 오늘 수정 → 최근도 1
    expect(hits[0].score).toBeCloseTo(2 * Math.log(2) * 1.5, 10);
  });
});

describe("기록 파일은 줄마다 찾기(R10)", () => {
  test("30줄 일지에서 「LG 그램 노트북」 한 줄만 맞고, 흔한 낱말 가득한 다른 날 일지보다 먼저 나온다", async () => {
    const plain = (i: number) => `- 10:${String(i).padStart(2, "0")} 「주말 영화 ${i}」 — naver.com · 성공`;
    // 흔한 낱말: 대부분의 줄에 「지난주에 본」이 들어 있고, 두 줄에는 「노트」 · 「스트북」(→ 트북)이 따로 있다(한 줄에 다 있진 않다).
    const generic = (i: number) =>
      i === 3
        ? "- 10:03 「노트 정리」 — a.com · 성공"
        : i === 9
          ? "- 10:09 「스트북」 — b.com · 성공"
          : `- 10:${String(i).padStart(2, "0")} 「지난주에 본 소식 ${i}」 — ko.wikipedia.org/wiki/성공 · 성공`;
    const day = (f: (i: number) => string, special?: [number, string]) =>
      Array.from({ length: 30 }, (_, i) => (special && special[0] === i ? special[1] : f(i))).join("\n") + "\n";
    const lg = "- 14:05 「LG 그램 노트북 비교」 — danawa.com · 성공";
    await put("기억/일지/2026-11-16-맥.md", day(plain, [17, lg]));
    await put("기억/일지/2026-11-20-맥.md", day(generic));
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("지난주에 본 노트북");
    expect(hits[0].file).toBe("기억/일지/2026-11-16-맥.md");
    expect(hits[0].date).toBe("2026-11-16");
    expect(hits[0].snippet).toBe([plain(16), lg, plain(18)].join("\n"));
  });

  test("같은 날 일지의 맞는 두 줄은 따로 두 건", async () => {
    await put(
      "기억/일지/2026-11-20-맥.md",
      "- 09:00 「노트북 후기」 — a.com · 성공\n- 09:30 「커피」 — b.com · 성공\n- 10:00 「노트북 가격」 — c.com · 성공\n",
    );
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.file)).toEqual(["기억/일지/2026-11-20-맥.md", "기억/일지/2026-11-20-맥.md"]);
    expect(hits.map((h) => h.date)).toEqual(["2026-11-20", "2026-11-20"]);
    const joined = hits.map((h) => h.snippet).join("|");
    expect(joined).toContain("노트북 후기");
    expect(joined).toContain("노트북 가격");
  });

  test("프로젝트 기록(기록-맥.md, 보관 아래 포함)도 줄마다 찾고 날짜는 줄 앞 날짜 규칙 → 수정 시각", async () => {
    await put("프로젝트/여행/기록-맥.md", "- 2026-11-10 항공권 확인\n- 2026-11-12 노트북 챙김\n", new Date(2026, 10, 15));
    await put("프로젝트/보관/옛일/기록-맥.md", "- 2026-11-01 노트북 수리\n- 2026-11-02 커피\n", new Date(2026, 10, 15));
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북");
    expect(hits.map((h) => h.file).sort()).toEqual(["프로젝트/보관/옛일/기록-맥.md", "프로젝트/여행/기록-맥.md"]);
    // 줄마다 따로: 두 줄 파일이 한 문단이 아니라 줄 하나씩이라 스니펫은 맞은 줄 + 이웃 줄
    expect(hits.find((h) => h.file === "프로젝트/여행/기록-맥.md")!.snippet).toBe("- 2026-11-10 항공권 확인\n- 2026-11-12 노트북 챙김");
    expect(hits.find((h) => h.file === "프로젝트/여행/기록-맥.md")!.date).toBe("2026-11-12");
  });

  test("일지가 아닌 파일(나.md · 프로젝트 문서 · 프로젝트.md)은 그대로 문단 단위", async () => {
    await put("기억/나.md", "- 2026-11-20 노트북 이야기\n- 2026-11-21 커피\n");
    await put("프로젝트/여행/프로젝트.md", "노트북\n커피\n");
    const idx = new MemoryIndex(home, { now: () => NOW });
    const hits = await idx.search("노트북");
    expect(hits).toHaveLength(2); // 파일마다 문단 하나 → 한 건씩
    expect(hits.find((h) => h.file === "기억/나.md")!.date).toBe("2026-11-20");
  });
});

describe("formatHits", () => {
  test("파일 · 날짜 · 스니펫을 번호 붙여 보여 준다", () => {
    const out = formatHits([
      { file: "기억/나.md", date: "2026-11-20", score: 3.2, snippet: "- 2026-11-20 노트북\n- 둘째" },
      { file: "기억/오래-기억.md", score: 1, snippet: "커피" },
    ]);
    expect(out).toContain("1. 기억/나.md (2026-11-20)");
    expect(out).toContain("노트북");
    expect(out).toContain("2. 기억/오래-기억.md");
    expect(out).not.toContain("더 있음");
  });

  test("빈 결과는 한 줄 안내", () => {
    expect(formatHits([])).toBe("찾은 기억이 없어요.");
  });

  test("8,192 바이트를 넘으면 뒤를 자르고 「… 더 있음」", () => {
    const snippet = "가".repeat(300);
    const hits = Array.from({ length: 40 }, (_, i) => ({ file: `기억/일지/2026-11-${String(i + 1).padStart(2, "0")}-맥.md`, date: "2026-11-01", score: 1, snippet }));
    const out = formatHits(hits);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192);
    expect(out.endsWith("… 더 있음")).toBe(true);
    expect(out).toContain("1. 기억/일지/2026-11-01-맥.md");
  });

  test("한 건만으로 상한을 넘어도(아주 긴 파일 이름) 상한 안으로 자른다", () => {
    const out = formatHits([{ file: "기억/" + "가".repeat(5000) + ".md", score: 1, snippet: "나".repeat(300) }]);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192);
    expect(out.endsWith("… 더 있음")).toBe(true);
  });
});

describe("큰 기억(Review Focus 4)", () => {
  test("약 3MB · 2만 줄에서 refresh + 찾기 1초 안, 출력 8KB 안", async () => {
    // 시험 도구: 낱말 모음에서 결정적으로 뽑아 줄을 만든다(「노트북」 · 「macbook」 낱말은 모음에 없다).
    const vocab = Array.from({ length: 400 }, (_, i) => {
      const a = 0xac00 + ((i * 37) % 11000);
      return String.fromCharCode(a, a + 1 + (i % 7), a + 3 + (i % 11)).replace(/[^가-힣]/g, "가");
    });
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const lineText = () => {
      const words = Array.from({ length: 14 }, () => vocab[Math.floor(rnd() * vocab.length)]);
      return `- 14:05 「${words.slice(0, 5).join(" ")}」 — ${words[6]}.com, ${words[7]}.kr/${words[8]} · ${words.slice(9).join(" ")} · 성공`;
    };
    const FILES = 40;
    const PER_FILE = 500; // 40 × 500 = 20,000 줄
    let total = 0;
    for (let f = 0; f < FILES; f++) {
      const lines: string[] = [];
      for (let i = 0; i < PER_FILE; i++) {
        lines.push(lineText());
        if (i % 50 === 49) lines.push(""); // 문단 몇 개
      }
      if (f === 17) lines.splice(120, 0, "- 09:30 「LG 그램 노트북 비교」 — danawa.com · 성공");
      const text = lines.join("\n") + "\n";
      total += Buffer.byteLength(text, "utf8");
      await put(`기억/일지/보관/2026-10-${String((f % 28) + 1).padStart(2, "0")}-맥${f}.md`, text);
    }
    expect(total).toBeGreaterThan(2_500_000);

    const idx = new MemoryIndex(home, { now: () => NOW });
    const t0 = performance.now();
    await idx.refresh();
    const hits = await idx.search("지난주에 본 노트북", { limit: 50 });
    const many = await idx.search(`${vocab[0]} ${vocab[1]} ${vocab[2]}`, { limit: 50 }); // 흔한 낱말: 결과가 많은 질문
    const ms = performance.now() - t0;
    const out = formatHits(hits);
    const outMany = formatHits(many);

    expect(hits[0].file).toBe("기억/일지/보관/2026-10-18-맥17.md");
    expect(hits[0].snippet).toContain("LG 그램 노트북 비교");
    expect(ms).toBeLessThan(1000);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192);
    expect(many.length).toBeGreaterThan(10);
    expect(Buffer.byteLength(outMany, "utf8")).toBeLessThanOrEqual(8192);
  });
});
