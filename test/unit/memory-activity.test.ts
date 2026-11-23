import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ActivityLog, readMachineState, writeMachineState, type Touch } from "../../src/memory/activity.js";
import { MemoryHome, machineName } from "../../src/memory/home.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";

let tmp: TempHome;
let home: MemoryHome;
let clock: Date;
let log: ActivityLog;

beforeEach(async () => {
  tmp = await makeTempHome();
  home = new MemoryHome(tmp.dir);
  clock = new Date(2026, 10, 23, 14, 5, 0); // 2026-11-23 14:05 지역 시각
  log = new ActivityLog(home, () => clock);
});
afterEach(async () => {
  await tmp.remove();
});

async function put(rel: string, text: string): Promise<void> {
  const p = home.path(rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, "utf8");
}

const dayFile = (date: string) => `기억/일지/${date}-${machineName()}.md`;
const open = (url: string, userTab = false): Touch => ({ url, userTab, kind: "open" });

describe("ActivityLog.record — 하루 기록 한 줄", () => {
  test("형식: - HH:MM 「제목」 — 주소 · 성공", async () => {
    await log.record({ title: "서울 문서 읽기", touched: [open("https://ko.example.org/wiki/서울")], ok: true });
    expect(await home.read(dayFile("2026-11-23"))).toBe("- 14:05 「서울 문서 읽기」 — https://ko.example.org/wiki/서울 · 성공\n");
  });

  test("주소의 쿼리 · # 는 남기지 않는다", async () => {
    await log.record({ title: "t", touched: [open("https://a.example/p?token=abc&q=1#frag")], ok: true });
    const text = (await home.read(dayFile("2026-11-23")))!;
    expect(text).toContain("https://a.example/p");
    expect(text).not.toMatch(/[?#]|token|frag/);
  });

  test("사용자 탭은 도메인만 남긴다", async () => {
    await log.record({ title: "t", touched: [{ url: "https://mail.example.com/inbox/secret-thread", userTab: true, kind: "attach" }], ok: true });
    const text = (await home.read(dayFile("2026-11-23")))!;
    expect(text).toContain("— mail.example.com ·");
    expect(text).not.toContain("inbox");
  });

  test("여러 사이트는 쉼표로 잇고, 같은 모양은 한 번만", async () => {
    await log.record({
      title: "t",
      touched: [open("https://a.example/x"), open("https://b.example/y"), { url: "https://c.example/1", userTab: true, kind: "attach" }, { url: "https://c.example/2", userTab: true, kind: "nav" }],
      ok: true,
    });
    expect(await home.read(dayFile("2026-11-23"))).toBe("- 14:05 「t」 — https://a.example/x, https://b.example/y, c.example · 성공\n");
  });

  test("실패는 · 실패(이유), 이유 속 주소의 쿼리도 뺀다", async () => {
    await log.record({ title: "t", touched: [open("https://a.example/")], ok: false, error: "https://a.example/p?secret=1234 에서 시간 초과" });
    const text = (await home.read(dayFile("2026-11-23")))!;
    expect(text).toContain("· 실패(https://a.example/p 에서 시간 초과)");
    expect(text).not.toContain("secret");
  });

  test("이유는 80자, 제목은 60자 안(…로 끝)", async () => {
    await log.record({ title: "가".repeat(100), touched: [open("https://a.example/")], ok: false, error: "나".repeat(200) });
    const line = (await home.read(dayFile("2026-11-23")))!;
    const title = /「(.*)」/.exec(line)![1]!;
    const why = /실패\((.*)\)/.exec(line)![1]!;
    expect([...title]).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
    expect([...why]).toHaveLength(80);
  });

  test("제목이 비면 (제목 없음)", async () => {
    await log.record({ title: "  ", touched: [open("https://a.example/")], ok: true });
    expect(await home.read(dayFile("2026-11-23"))).toContain("「(제목 없음)」");
  });

  test("제목에 민감한 값이 있으면 가린다", async () => {
    await log.record({ title: "비밀번호: hunter2 로 로그인", touched: [open("https://a.example/")], ok: true });
    const text = (await home.read(dayFile("2026-11-23")))!;
    expect(text).not.toContain("hunter2");
    expect(text).toContain("「(가림)」");
  });

  test("닿은 곳이 없고 성공이면 아무것도 안 쓴다", async () => {
    await log.record({ title: "계산만", touched: [], ok: true });
    expect(await home.list("기억/일지")).toEqual([]);
  });

  test("닿은 곳이 없어도 실패면 쓴다", async () => {
    await log.record({ title: "문법 오류", touched: [], ok: false, error: "SyntaxError" });
    const text = (await home.read(dayFile("2026-11-23")))!;
    expect(text).toContain("「문법 오류」");
    expect(text).toContain("실패(SyntaxError)");
  });

  test("열린 프로젝트가 있으면 줄 끝에 이름, 프로젝트 기록에도 같은 줄", async () => {
    log.state.openProject = "쿠팡 가격";
    await log.record({ title: "t", touched: [open("https://a.example/")], ok: true });
    const line = "- 14:05 「t」 — https://a.example/ · 성공 · 프로젝트: 쿠팡 가격\n";
    expect(await home.read(dayFile("2026-11-23"))).toBe(line);
    expect(await home.read(`프로젝트/쿠팡 가격/기록-${machineName()}.md`)).toBe(line);
  });

  test("paused 면 안 쓴다", async () => {
    log.state.paused = true;
    log.state.openProject = "p";
    await log.record({ title: "t", touched: [open("https://a.example/")], ok: false, error: "x" });
    expect(await home.list("기억")).toEqual([]);
    expect(await home.list("프로젝트")).toEqual([]);
  });

  test("이 맥 시간대 기준 날짜: Asia/Seoul 00:30 은 그날(지역) 파일", async () => {
    const before = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    try {
      clock = new Date("2026-11-22T15:30:00Z"); // 서울 2026-11-23 00:30
      await log.record({ title: "t", touched: [open("https://a.example/")], ok: true });
      expect(await home.read(dayFile("2026-11-23"))).toContain("- 00:30 「t」");
      expect(await home.list("기억/일지")).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  test("같은 맥의 두 기록이 동시에 각각 50줄을 덧붙여도 100줄", async () => {
    const other = new ActivityLog(new MemoryHome(tmp.dir), () => clock);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(log.record({ title: `a${i}`, touched: [open("https://a.example/")], ok: true }));
      jobs.push(other.record({ title: `b${i}`, touched: [open("https://b.example/")], ok: true }));
    }
    await Promise.all(jobs);
    const lines = (await home.read(dayFile("2026-11-23")))!.trim().split("\n");
    expect(lines).toHaveLength(100);
    expect(new Set(lines).size).toBe(100);
  });
});

describe("ActivityLog.siteNoteFor — 사이트 메모 붙이기", () => {
  test("처음 닿은 도메인의 메모를 `… 이 사이트 메모(도메인): 내용` 으로, 다시 닿으면 없다", async () => {
    await put("기억/사이트/coupang.com.md", "로그인 필요\n로켓배송 필터 있음");
    expect(await log.siteNoteFor([open("https://www.coupang.com/np/search?q=a")])).toBe("… 이 사이트 메모(coupang.com): 로그인 필요 로켓배송 필터 있음");
    expect(await log.siteNoteFor([open("https://coupang.com/")])).toBeNull();
    expect(log.state.seenDomains.has("coupang.com")).toBe(true);
  });

  test("메모 파일이 없는 도메인도 본 것으로 쳐서, 나중에 만들어도 이번 대화엔 안 붙인다", async () => {
    expect(await log.siteNoteFor([open("https://new.example/")])).toBeNull();
    await put("기억/사이트/new.example.md", "나중에 생김");
    expect(await log.siteNoteFor([open("https://new.example/")])).toBeNull();
  });

  test("위 도메인 메모로 대체: cafe.naver.com 은 naver.com.md", async () => {
    await put("기억/사이트/naver.com.md", "네이버 공통 메모");
    expect(await log.siteNoteFor([open("https://cafe.naver.com/x")])).toBe("… 이 사이트 메모(cafe.naver.com): 네이버 공통 메모");
  });

  test("정확한 호스트 메모가 위 도메인 메모보다 먼저", async () => {
    await put("기억/사이트/naver.com.md", "위");
    await put("기억/사이트/cafe.naver.com.md", "정확");
    expect(await log.siteNoteFor([open("https://cafe.naver.com/")])).toContain(": 정확");
  });

  test("메모는 합쳐서 600자 안", async () => {
    await put("기억/사이트/a.example.md", "가".repeat(2000));
    await put("기억/사이트/b.example.md", "나".repeat(2000));
    const note = (await log.siteNoteFor([open("https://a.example/"), open("https://b.example/")]))!;
    expect([...note].length).toBeLessThanOrEqual(600);
    expect(note).toContain("이 사이트 메모(a.example)");
  });

  test("여러 도메인은 줄을 바꿔 잇는다", async () => {
    await put("기억/사이트/a.example.md", "A 메모");
    await put("기억/사이트/b.example.md", "B 메모");
    expect(await log.siteNoteFor([open("https://a.example/"), open("https://b.example/")])).toBe(
      "… 이 사이트 메모(a.example): A 메모\n… 이 사이트 메모(b.example): B 메모",
    );
  });

  test("about: · 주소가 아닌 것은 건너뛴다", async () => {
    expect(await log.siteNoteFor([open("about:blank"), open("not a url")])).toBeNull();
  });
});

describe("ActivityLog.tidyHint — 정리 안내", () => {
  const HINT = "… 기억 정리할 때가 됐어요 — memory 도구 tidy";

  test("오늘보다 이전 일지가 있고 정리한 적 없으면 한 줄, 한 번만", async () => {
    await put("기억/일지/2026-11-20-맥.md", "- x\n");
    expect(await log.tidyHint()).toBe(HINT);
    expect(await log.tidyHint()).toBeNull();
    expect(log.state.tidyHinted).toBe(true);
  });

  test("오늘 일지만 있으면 안내하지 않는다", async () => {
    await put("기억/일지/2026-11-23-맥.md", "- x\n");
    expect(await log.tidyHint()).toBeNull();
  });

  test("보관/ 안의 옛 일지는 세지 않는다", async () => {
    await put("기억/일지/보관/2026-10-01-맥.md", "- x\n");
    expect(await log.tidyHint()).toBeNull();
  });

  test("24시간 안에 정리했으면 안내하지 않고, 지나면 다시 안내한다", async () => {
    await put("기억/일지/2026-11-20-맥.md", "- x\n");
    await writeMachineState(home, { lastTidy: new Date(clock.getTime() - 23 * 3600_000).toISOString() });
    expect(await log.tidyHint()).toBeNull();
    await writeMachineState(home, { lastTidy: new Date(clock.getTime() - 25 * 3600_000).toISOString() });
    expect(await log.tidyHint()).toBe(HINT);
  });
});

describe("ActivityLog.touch — 세션 상태", () => {
  test("처음 상태", () => {
    expect(log.state).toMatchObject({ openProject: null, paused: false, tidyHinted: false, pendingTidy: null, writeWarned: false });
    expect(log.state.seenDomains.size).toBe(0);
  });

  test("마지막 사용 뒤 30분 안이면 그대로, 넘으면 초기값으로", async () => {
    log.touch();
    log.state.openProject = "p";
    log.state.paused = true;
    log.state.tidyHinted = true;
    log.state.writeWarned = true;
    log.state.seenDomains.add("a.example");
    log.state.pendingTidy = { files: ["x"], at: 1 };
    clock = new Date(clock.getTime() + 1_800_000); // 정확히 30분은 아직 그대로
    log.touch();
    expect(log.state.openProject).toBe("p");
    expect(log.state.lastUse).toBe(clock.getTime());
    clock = new Date(clock.getTime() + 1_800_001);
    log.touch();
    expect(log.state).toMatchObject({ openProject: null, paused: false, tidyHinted: false, pendingTidy: null, writeWarned: false, lastUse: clock.getTime() });
    expect(log.state.seenDomains.size).toBe(0);
  });

  test("초기화해도 같은 state 객체다(밖에서 들고 있어도 따라온다)", () => {
    const s = log.state;
    log.touch();
    clock = new Date(clock.getTime() + 2_000_000);
    s.openProject = "p";
    log.touch();
    expect(log.state).toBe(s);
    expect(s.openProject).toBeNull();
  });
});

describe("기록 쓰기 실패 안내", () => {
  test("집 폴더가 파일이면 이유와 함께 한 줄, 같은 대화에선 한 번만", async () => {
    const bad = new MemoryHome(tmp.dir + "/막힘");
    await writeFile(tmp.dir + "/막힘", "파일");
    const l = new ActivityLog(bad, () => clock);
    let err: unknown;
    try {
      await l.record({ title: "t", touched: [open("https://a.example/")], ok: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const line = await l.writeFailureNotice(err);
    expect(line).toMatch(/^기억 폴더에 쓸 수 없어요: .*막힘 — .+/);
    expect(await l.writeFailureNotice(err)).toBeNull();
  });
});

describe("머신 상태 파일", () => {
  test("없거나 깨졌으면 {}", async () => {
    expect(await readMachineState(home)).toEqual({});
    await put(`기억/.상태-${machineName()}.json`, "{깨짐");
    expect(await readMachineState(home)).toEqual({});
  });

  test("쓰면 합쳐서 저장하고 다시 읽힌다", async () => {
    await writeMachineState(home, { lastTidy: "2026-11-23T05:00:00.000Z" });
    expect(await readMachineState(home)).toEqual({ lastTidy: "2026-11-23T05:00:00.000Z" });
    await writeMachineState(home, {});
    expect(await readMachineState(home)).toEqual({ lastTidy: "2026-11-23T05:00:00.000Z" });
    expect(await home.list("기억")).toEqual([`.상태-${machineName()}.json`]);
  });
});
