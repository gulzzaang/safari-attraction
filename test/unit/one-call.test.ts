import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { buildGuardedSource, expressionError, type GuardedReading } from "../../src/driver/guarded-source.js";
import { sameUrl, urlForms } from "../../src/driver/url.js";
import { createJxaDriver, opError } from "../../src/driver/jxa-driver.js";
import { HostError, HostTimeoutError } from "../../src/driver/jxa-host.js";
import { ACTION_OPS, buildActionSource, buildEvalSource, buildPendingReadSource } from "../../src/repl/inpage-actions.js";
import { loadPollSource } from "../../src/repl/load-state.js";
import { buildSnapshotSource } from "../../src/snapshot/inpage.js";
import { createHarness } from "../helpers/host-harness.js";

const KEY = "t1.abcd1234";

/** 가짜 페이지(document · location)에서 스크립트를 진짜로 돌린다. */
function runPage(script: string, page: { marker?: string; href?: string; noRoot?: boolean; globals?: Record<string, unknown> } = {}) {
  const dataset: Record<string, string> = page.marker ? { saTab: page.marker } : {};
  const ctx = vm.createContext({
    document: {
      get documentElement() {
        if (page.noRoot) return null;
        return { dataset };
      },
    },
    location: { href: page.href ?? "http://x/" },
    ...page.globals,
  });
  (ctx as Record<string, unknown>).window = ctx;
  const out = vm.runInContext(script, ctx);
  return { reading: JSON.parse(out) as GuardedReading, dataset, ctx };
}
const spec = (o: Partial<{ unstamped: boolean; url: string; altUrl: string }> = {}) => ({ key: KEY, unstamped: false, url: "http://x/", ...o });

describe("buildGuardedSource(탭 확인 + 일을 한 스크립트로)", () => {
  test("표시가 키와 같으면 소스를 돌리고 문서 자신의 주소를 돌려준다", () => {
    const { reading } = runPage(buildGuardedSource(spec(), "'안녕'"), { marker: KEY, href: "http://x/새" });
    expect(reading).toEqual({ ok: true, type: "string", value: "안녕", url: "http://x/새", leaving: false });
  });

  test("떠나는 중 깃발(window.__saLeaving)을 같은 호출에서 함께 돌려준다", () => {
    expect(runPage(buildGuardedSource(spec(), "1"), { marker: KEY }).reading).toMatchObject({ ok: true, leaving: false });
    expect(runPage(buildGuardedSource(spec(), "1"), { marker: KEY, globals: { __saLeaving: true } }).reading).toMatchObject({ ok: true, leaving: true });
    expect(runPage(buildGuardedSource(spec(), "(window.__saLeaving = true, 1)"), { marker: KEY }).reading).toMatchObject({ leaving: true }); // 소스가 세운 깃발도 돌아올 때 읽는다
  });

  test("표시가 다른 키면 소스를 돌리지 않고 어긋남을 알린다", () => {
    const { reading, ctx } = runPage(buildGuardedSource(spec(), "(globalThis.ran = 1)"), { marker: "t2.zzzz", globals: { ran: 0 } });
    expect(reading).toMatchObject({ ok: false, marker: "t2.zzzz" });
    expect(ctx.ran).toBe(0);
  });

  test("표시가 없어도 이미 표시한 탭(unstamped 아님)이면 어긋남이다", () => {
    const { reading } = runPage(buildGuardedSource(spec({ unstamped: false }), "1"), { href: "http://x/" });
    expect(reading).toMatchObject({ ok: false, marker: "" });
  });

  test("표시 안 한 탭: 표시가 없고 문서 주소가 기록한 주소와 같으면 표시를 적고 돈다", () => {
    const { reading, dataset } = runPage(buildGuardedSource(spec({ unstamped: true, url: "http://x/a" }), "7"), { href: "http://x/a" });
    expect(reading).toMatchObject({ ok: true, type: "number", value: "7" });
    expect(dataset.saTab).toBe(KEY);
  });

  test("표시 안 한 탭: 대신 받아들일 주소(altUrl)도 된다", () => {
    const { reading, dataset } = runPage(buildGuardedSource(spec({ unstamped: true, url: "http://x/a", altUrl: "http://x/b" }), "7"), { href: "http://x/b" });
    expect(reading.ok).toBe(true);
    expect(dataset.saTab).toBe(KEY);
  });

  test("표시 안 한 탭이어도 주소가 다르면 소스를 돌리지 않고 표시도 적지 않는다", () => {
    const { reading, dataset, ctx } = runPage(buildGuardedSource(spec({ unstamped: true, url: "http://x/a" }), "(globalThis.ran = 1)"), { href: "http://x/zzz", globals: { ran: 0 } });
    expect(reading.ok).toBe(false);
    expect(dataset.saTab).toBeUndefined();
    expect(ctx.ran).toBe(0);
  });

  test("표시 안 한 탭이어도 다른 키의 표시가 있으면 어긋남(표시를 덮어쓰지 않는다)", () => {
    const { reading, dataset } = runPage(buildGuardedSource(spec({ unstamped: true, url: "http://x/" }), "1"), { marker: "t9.other" });
    expect(reading.ok).toBe(false);
    expect(dataset.saTab).toBe("t9.other");
  });

  test("documentElement 가 없는 문서: 표시 없음으로 보고, 표시를 못 적어도 표시 안 한 탭이면 소스는 돈다(예전과 같다)", () => {
    const { reading } = runPage(buildGuardedSource(spec({ unstamped: true, url: "http://x/" }), "5"), { noRoot: true });
    expect(reading).toMatchObject({ ok: true, value: "5" });
    expect(runPage(buildGuardedSource(spec(), "5"), { noRoot: true }).reading.ok).toBe(false);
  });

  test.each([
    ["'abc'", "string", "abc"],
    ["''", "string", ""],
    ["3.5", "number", "3.5"],
    ["0", "number", "0"],
    ["NaN", "number", "NaN"],
    ["1/0", "number", "Infinity"],
    ["true", "boolean", "true"],
    ["false", "boolean", "false"],
    ["null", "null", ""],
    ["undefined", "null", ""],
    ["({a: 1, b: [1, 2]})", "object", '{"a":1,"b":[1,2]}'],
    ["[1, 'a']", "object", '[1,"a"]'],
    ["(function () {})", "function", ""],
    ["Symbol('s')", "symbol", ""],
  ])("값 %s → 종류 %s · 글 %j", (src, type, value) => {
    const { reading } = runPage(buildGuardedSource(spec(), src), { marker: KEY });
    expect(reading).toMatchObject({ ok: true, type, value });
  });

  test("소스 끝의 줄 주석이 닫는 괄호를 먹지 않는다", () => {
    const { reading } = runPage(buildGuardedSource(spec(), "1 + 1 // 주석"), { marker: KEY });
    expect(reading).toMatchObject({ ok: true, value: "2" });
  });

  test("소스가 던진 오류는 삼키지 않고 그대로 올린다(사파리에서는 null 로 보인다)", () => {
    expect(() => runPage(buildGuardedSource(spec(), "(function(){ throw new Error('boom') })()"), { marker: KEY })).toThrow("boom");
  });

  test("소스에서 페이지 전역 이름(m · v · k · t · s)을 그대로 읽는다 — 스크립트의 지역 이름이 가리지 않는다", () => {
    const { reading } = runPage(buildGuardedSource(spec(), "[typeof m, typeof v, typeof k, typeof t, typeof s].join()"), { marker: KEY, globals: { m: 1, v: 'x', k: null, t: {}, s: 2 } });
    expect(reading).toMatchObject({ ok: true, value: "number,string,object,object,number" });
  });

  test("키 · 주소의 따옴표 · 줄바꿈 · 한글이 글자 그대로 안전하게 들어간다", () => {
    const url = `http://x/"q"\n'한글' `;
    const { reading } = runPage(buildGuardedSource(spec({ unstamped: true, url }), "1"), { href: url });
    expect(reading.ok).toBe(true);
  });
});

describe("runJs 소스는 식 하나다(탭 확인 스크립트가 `(소스)` 로 끼운다)", () => {
  const sources: Array<[string, string]> = [
    ["snapshot 기본", buildSnapshotSource()],
    ["snapshot interactive · selector · full", buildSnapshotSource({ interactive: true, selector: "e12", full: true })],
    ["loadPollSource domcontentloaded", loadPollSource("domcontentloaded")],
    ["loadPollSource load", loadPollSource("load")],
    ["loadPollSource networkidle", loadPollSource("networkidle")],
    ["pending 읽기", buildPendingReadSource("tok-1")],
    ["evaluate 식", buildEvalSource("1 + 1", undefined, "tok")],
    ["evaluate 함수", buildEvalSource("(a) => a.x", { x: 1 }, "tok")],
    ["evaluate 끝 줄 주석", buildEvalSource("document.title // 제목", undefined, "tok")],
    ["evaluate fetch 식", buildEvalSource("(arg) => fetch(arg.url, arg.init).then((r) => r.text())", { url: "/", init: {} }, "tok")],
    ["document.title", "document.title"],
    ["document.visibilityState", "document.visibilityState"],
    ["doctor 시험", "1+1"],
    ...ACTION_OPS.flatMap((op): Array<[string, string]> => [
      [`동작 ${op}(chain 없음)`, buildActionSource(op, { tok: "t", key: "Enter", text: "ab", url: "http://x/", dir: "back", x: 0, y: 0 })],
      [`동작 ${op}(chain)`, buildActionSource(op, { tok: "t", chain: [{ k: "css", sel: "button" }], value: "v", key: "Enter", text: "ab", wait: { visible: true, enabled: true } })],
    ]),
  ];
  test.each(sources)("%s", (_name, src) => {
    expect(expressionError(src)).toBeNull();
    // 감싼 스크립트 전체도 문법이 맞다
    expect(() => new Function(`return (${buildGuardedSource(spec(), src)})`)).not.toThrow();
    expect(() => new Function("return (" + src + ")")).not.toThrow();
  });

  test("[M1] 식 둘레를 닫고 문장을 끼워 넣는 소스도 걸러낸다(감싼 꼴로 봐서 `(0); x(); (0)` 이 통과하지 않는다)", () => {
    expect(expressionError("0); x(); (0")).not.toBeNull();
    expect(expressionError("0)]; x(); [(0")).not.toBeNull();
    expect(expressionError("0 /* 주석 */")).toBeNull();
    expect(expressionError("a, b")).toBeNull(); // 쉼표식은 식 하나
  });

  test("문장 · 선언은 식이 아니라고 걸러낸다", () => {
    expect(expressionError("var a = 1; a")).not.toBeNull();
    expect(expressionError("window.scrollTo(0, 0); 0")).not.toBeNull();
    expect(expressionError("(window.scrollTo(0, 0), 0)")).toBeNull();
  });
});

describe("호스트 runJsFast · runJs · showTab (가짜 사파리, 이벤트 수를 센다)", () => {
  const args = (o: Record<string, unknown> = {}, source = "1 + 1") => ({
    windowId: 7,
    index: 1,
    key: KEY,
    url: "http://x/",
    unstamped: false,
    ...o,
    script: buildGuardedSource({ key: KEY, unstamped: !!o.unstamped, url: String(o.url ?? "http://x/"), altUrl: o.altUrl as string | undefined }, source),
  });
  const jsEvents = (h: ReturnType<typeof createHarness>) => h.events.filter((e) => e.kind === "doJavaScript").length;
  const urlEvents = (h: ReturnType<typeof createHarness>) => h.events.filter((e) => e.kind === "tabUrl").length;

  test("정상: Apple Event 는 doJavaScript 한 번뿐이다(tab.url() · 표시 읽기 따로 없음)", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: KEY });
    const r = h.ops.runJsFast!(args());
    expect(r).toEqual({ value: "2", url: "http://x/", leaving: false });
    expect(jsEvents(h)).toBe(1);
    expect(urlEvents(h)).toBe(0);
  });

  test("돌려주는 주소는 문서 자신의 주소다 — 이동 중이라 tab.url() 이 목적지여도 옛 문서 주소", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/old", marker: KEY });
    tab!.dest = "http://x/new";
    expect(h.ops.runJsFast!(args({ url: "http://x/old" }))).toEqual({ value: "2", url: "http://x/old", leaving: false });
    expect(urlEvents(h)).toBe(0);
  });

  test("표시 안 한 탭이 주소로 알아봐지면 한 번에 표시를 적고 돈다", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/" });
    expect(h.ops.runJsFast!(args({ unstamped: true }))).toEqual({ value: "2", url: "http://x/", leaving: false });
    expect(tab!.page.dataset.saTab).toBe(KEY);
    expect(jsEvents(h)).toBe(1);
  });

  test("표시가 안 맞으면 소스를 안 돌리고 {fallback} — 느린 길 runJs 가 예전처럼 stale 을 돌려준다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: "t3.other", globals: {} });
    expect(h.ops.runJsFast!(args({}, "(globalThis.ran = 1)"))).toEqual({ fallback: true });
    expect(h.windows.get(7)!.tabs[0]!.page.globals.ran).toBeUndefined();
    expect(h.ops.runJs!({ ...args(), source: "1 + 1" })).toEqual({ stale: true });
  });

  test("느린 길은 예전과 같다: 표시 안 한 탭이 tab.url() 로 알아봐지면 표시를 적고 소스를 돌린다(주소는 문서 자신의 것)", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/" }); // 표시 없음
    tab!.dest = "http://x/";
    const r = h.ops.runJs!({ ...args({ unstamped: true }), source: "1 + 1" });
    expect(r).toEqual({ value: "2", url: "http://x/" }); // 느린 길은 떠나는 중인지 모른다
    expect(tab!.page.dataset.saTab).toBe(KEY);
  });

  test("탭 · 창이 없으면(-1728) 오류로 올리지 않고 {fallback}", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: KEY });
    expect(h.ops.runJsFast!(args({ index: 5 }))).toEqual({ fallback: true });
    expect(h.ops.runJsFast!(args({ windowId: 99 }))).toEqual({ fallback: true });
    h.windows.get(7)!.tabs[0]!.closed = true;
    expect(h.ops.runJsFast!(args())).toEqual({ fallback: true });
  });

  test("「Apple 이벤트에서 JavaScript 허용」이 꺼진 오류는 그대로 올린다", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: KEY });
    tab!.page.jsOff = true;
    expect(() => h.ops.runJsFast!(args())).toThrow(/Apple 이벤트/);
  });

  test("소스가 오류를 던져 사파리가 null 을 돌려주면 소스를 다시 돌리지 않는다 — 자리만 확인해 예전처럼 빈 값", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: KEY, globals: { count: 0 } });
    const throwing = "(function(){ count++; throw new Error('boom') })()";
    expect(h.ops.runJsFast!(args({}, throwing))).toEqual({ value: "" });
    // doJavaScript 는 빠른 길 한 번 + 자리 확인(표시 읽기) 한 번
    expect(jsEvents(h)).toBe(2);
  });

  test("소스가 던진 뒤 자리 확인에서 표시가 안 맞아도 stale 로 되돌리지 않는다(다른 문서에서 다시 돌리지 않는다)", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: KEY });
    const throwing = "(function(){ document.documentElement.dataset.saTab = 'other'; throw new Error('boom') })()";
    expect(tab!.page.dataset.saTab).toBe(KEY);
    expect(h.ops.runJsFast!(args({}, throwing))).toEqual({ value: "" });
  });

  test("[I1] 소스가 돈 뒤 doJavaScript 가 시간 초과(-1712) 같은 오류를 올리면 그대로 올리고 소스는 한 번만 돈 채다(느린 길로 안 간다)", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: KEY });
    tab!.page.throwAfterRun = { message: "AppleEvent timed out.", number: -1712 };
    expect(() => h.ops.runJsFast!(args({}, "(window.runs = (window.runs || 0) + 1)"))).toThrow(/timed out/);
    expect(tab!.page.ctx!.runs).toBe(1);
    expect(jsEvents(h)).toBe(1); // 느린 길 · 자리 확인을 하지 않았다
  });

  test("[I1] 변환 오류(-10000 등) · 알 수 없는 오류도 그대로 올린다", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: KEY });
    tab!.page.throwAfterRun = { message: "Can't convert types.", number: -1700 };
    expect(() => h.ops.runJsFast!(args())).toThrow(/convert/);
  });

  test("[I1] 답 글이 깨졌거나(페이지가 JSON.stringify 를 바꿔 둠) 모르는 꼴이면 돈 것으로 보고 빈 값 — 소스를 다시 돌리지 않는다", () => {
    for (const stringify of [() => "깨진{", () => '{"hello":1}', () => "[1]", () => "123"]) {
      const h = createHarness();
      const [tab] = h.addWindow(7, { url: "http://x/", marker: KEY, globals: { JSON: { stringify, parse: JSON.parse } } });
      expect(h.ops.runJsFast!(args({}, "(window.runs = (window.runs || 0) + 1)"))).toEqual({ value: "" });
      expect(tab!.page.ctx!.runs).toBe(1);
    }
  });

  test("[I1] 표시 불일치({ok:false}) · 탭 없음(-1728 · -1719 · Invalid index)만 소스가 안 돈 것으로 보고 {fallback}", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: "t3.other" });
    expect(h.ops.runJsFast!(args({}, "(window.runs = 1)"))).toEqual({ fallback: true });
    expect(tab!.page.ctx!.runs).toBeUndefined();
    expect(h.ops.runJsFast!(args({ index: 9 }))).toEqual({ fallback: true });
  });

  test("문법이 틀린 소스(식 아님): 스크립트가 안 돌아 표시도 안 적히므로, 표시 안 한 탭이면 느린 확인이 표시를 적는다", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/" });
    tab!.dest = "http://x/";
    expect(h.ops.runJsFast!(args({ unstamped: true }, "var a = 1; a"))).toEqual({ value: "" });
    expect(tab!.page.dataset.saTab).toBe(KEY);
  });

  test("showTab: 표시가 맞으면 doJavaScript 한 번에 현재 탭으로 만든다", () => {
    const h = createHarness();
    const tabs = h.addWindow(7, { url: "http://x/a" }, { url: "http://x/", marker: KEY });
    const r = h.ops.showTab!({ ...args({ index: 2 }, "null") });
    expect(r).toEqual({ value: null });
    expect(h.windows.get(7)!.current).toBe(tabs[1]);
    expect(jsEvents(h)).toBe(1);
    expect(urlEvents(h)).toBe(0);
  });

  test("showTab: 표시가 안 맞으면 예전 확인으로 돌아가 stale", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: "t8.other" });
    expect(h.ops.showTab!({ ...args({}, "null") })).toEqual({ stale: true });
    expect(h.windows.get(7)!.current).toBeUndefined();
  });

  test("showTab: script 가 없는 옛 요청도 예전 확인으로 된다", () => {
    const h = createHarness();
    const tabs = h.addWindow(7, { url: "http://x/", marker: KEY });
    const a = args({}, "null") as Record<string, unknown>;
    delete a.script;
    expect(h.ops.showTab!(a)).toEqual({ value: null });
    expect(h.windows.get(7)!.current).toBe(tabs[0]);
  });
});

describe("[M3] 주소 꼴 차이(끝 슬래시 · 퍼센트 인코딩)", () => {
  test("sameUrl · urlForms", () => {
    expect(sameUrl("https://a.com", "https://a.com/")).toBe(true);
    expect(sameUrl("https://ko.wikipedia.org/wiki/서울", "https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8")).toBe(true);
    expect(sameUrl("http://a/%ea%b0%80", "http://a/%EA%B0%80")).toBe(true);
    expect(sameUrl("http://a/x", "http://a/y")).toBe(false);
    expect(sameUrl("http://a/#1", "http://a/#2")).toBe(false);
    expect(sameUrl("about:blank", "about:blank")).toBe(true);
    expect(sameUrl(undefined, "http://a/")).toBe(false);
    expect(urlForms(["https://a.com", undefined, "https://a.com/"])).toEqual(["https://a.com", "https://a.com/"]);
  });

  test("표시 안 한 탭: 기록한 주소와 문서 주소의 꼴이 달라도(끝 슬래시 · 한글 인코딩) 알아본다", () => {
    const a = runPage(buildGuardedSource(spec({ unstamped: true, url: "https://a.com" }), "1"), { href: "https://a.com/" });
    expect(a.reading.ok).toBe(true);
    const b = runPage(buildGuardedSource(spec({ unstamped: true, url: "https://ko.wikipedia.org/wiki/서울" }), "1"), { href: "https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8" });
    expect(b.reading.ok).toBe(true);
    const c = runPage(buildGuardedSource(spec({ unstamped: true, url: "https://a.com/x" }), "1"), { href: "https://a.com/y" });
    expect(c.reading.ok).toBe(false);
  });

  test("느린 길 guardTab: tab.url() 이 기록한 주소의 정규화한 꼴이면 알아본다(args.urls)", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/" });
    const r = h.ops.runJs!({ windowId: 7, index: 1, key: KEY, url: "http://x", unstamped: true, urls: ["http://x", "http://x/"], source: "1 + 1" });
    expect(r).toMatchObject({ value: "2" });
  });
});

describe("호스트 settle 빠른 길(같은 문서면 doJavaScript 한 번 + currentTab 한 번)", () => {
  const sargs = (o: Record<string, unknown> = {}) => ({ windowId: 7, index: 1, key: KEY, url: "http://x/", ...o });
  const count = (h: ReturnType<typeof createHarness>, kind: string) => h.events.filter((e) => e.kind === kind).length;

  test("표시가 키면 Apple Event 둘(doJavaScript · currentTab)로 same 을 돌려준다 — tab.url() · tab.name() 없음", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/a", marker: KEY, globals: { __saLeaving: true } });
    tab!.page.title = "제목";
    tab!.dest = "http://x/목적지"; // 이동 중이라 tab.url() 은 목적지 — 쓰지 않는다
    const r = h.ops.settle!(sargs());
    expect(r).toEqual({ status: "same", leaving: true, tab: { windowId: 7, index: 1, title: "제목", url: "http://x/a", isActive: true } });
    expect(count(h, "doJavaScript")).toBe(1);
    expect(count(h, "currentTab")).toBe(1);
    expect(count(h, "tabUrl")).toBe(0);
  });

  test("떠나는 중 깃발이 없으면 leaving false", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: KEY });
    expect(h.ops.settle!(sargs())).toMatchObject({ status: "same", leaving: false });
  });

  test("표시가 없으면(새 문서) 빠른 길은 물러나 예전 확인이 한다 — tab.url() 을 읽는다", () => {
    const h = createHarness();
    const [tab] = h.addWindow(7, { url: "http://x/", marker: "" });
    (tab as unknown as { name: () => string }).name = () => "";
    h.ops.settle!(sargs({ waitUntil: "commit" }));
    expect(count(h, "tabUrl")).toBeGreaterThan(0);
  });

  test("다른 키의 표시 · 없는 탭은 예전처럼 other · gone", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://x/", marker: "t9.other" });
    expect(h.ops.settle!(sargs())).toEqual({ status: "other" });
    expect(h.ops.settle!(sargs({ index: 4 }))).toEqual({ status: "gone" });
  });
});

describe("드라이버 runJs: 빠른 길 → 안 되면 느린 길(가짜 호스트로 부름 순서를 본다)", () => {
  type Call = { op: string; args: Record<string, any> };
  function setup(script: (op: string, args: Record<string, any>) => unknown) {
    const calls: Call[] = [];
    const tab = { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false };
    const host = {
      async call(op: string, a: object = {}) {
        calls.push({ op, args: a as Record<string, any> });
        if (op === "openTab") return { ...tab, stamped: true };
        if (op === "openWindow") return { windowId: 5, windowIndex: 1, tab, stamped: true };
        return script(op, a as Record<string, any>);
      },
      async close() {},
    };
    return { calls, d: createJxaDriver({ host }) };
  }

  test("정상: runJsFast 한 번만 부르고 느린 길은 부르지 않는다. 주소 기록도 돌려준 값으로 새로 한다", async () => {
    const { calls, d } = setup((op) => (op === "runJsFast" ? { value: "2", url: "http://x/moved" } : undefined));
    const { tab } = await d.openTab("http://x/");
    expect(await d.runJs(tab.key, "1+1")).toBe("2");
    expect(calls.map((c) => c.op)).toEqual(["openTab", "runJsFast"]);
    expect(d.lastUrl(tab.key)).toBe("http://x/moved");
    const fast = calls[1]!.args;
    expect(fast).toMatchObject({ windowId: 5, index: 1, unstamped: false });
    expect(fast.script).toContain("1+1");
    expect(fast.source).toBeUndefined(); // 소스를 두 번 보내지 않는다
  });

  test("runJsDetailed: 값 · 문서 주소 · 떠나는 중 · 시키기 전 주소를 돌려준다(느린 길이면 떠나는 중은 모름)", async () => {
    let n = 0;
    const { d } = setup((op) => {
      if (op === "runJsFast") return ++n === 1 ? { value: "a", url: "http://x/#h", leaving: false } : { fallback: true };
      if (op === "runJs") return { value: "b", url: "http://x/" };
      return undefined;
    });
    const { tab } = await d.openTab("http://x/");
    expect(await d.runJsDetailed!(tab.key, "1")).toEqual({ value: "a", url: "http://x/#h", leaving: false, urlBefore: "http://x/", owned: true });
    // 첫 호출이 주소를 #h 로 새로 했으니 다음 호출의 urlBefore 는 그 주소
    expect(await d.runJsDetailed!(tab.key, "1")).toEqual({ value: "b", url: "http://x/", leaving: undefined, urlBefore: "http://x/#h", owned: true });
  });

  test("{fallback} 이면 느린 길 runJs 로 소스를 보낸다", async () => {
    const { calls, d } = setup((op) => (op === "runJsFast" ? { fallback: true } : op === "runJs" ? { value: "느림", url: "http://x/" } : undefined));
    const { tab } = await d.openTab("http://x/");
    expect(await d.runJs(tab.key, "document.title")).toBe("느림");
    expect(calls.map((c) => c.op)).toEqual(["openTab", "runJsFast", "runJs"]);
    expect(calls[2]!.args.source).toBe("document.title");
    expect(calls[2]!.args.script).toBeUndefined();
  });

  test("느린 길도 stale 이면 탭을 다시 찾고(우리 탭은 settle) 처음부터 다시 한다", async () => {
    let fastCalls = 0;
    const { calls, d } = setup((op) => {
      if (op === "runJsFast") return ++fastCalls === 1 ? { fallback: true } : { value: "ok", url: "http://x/" };
      if (op === "runJs") return { stale: true };
      if (op === "settle") return { status: "navigated", tab: { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false }, stamped: true };
      return undefined;
    });
    const { tab } = await d.openTab("http://x/");
    expect(await d.runJs(tab.key, "1")).toBe("ok");
    expect(calls.map((c) => c.op)).toEqual(["openTab", "runJsFast", "runJs", "settle", "runJsFast"]);
  });

  test("빠른 길이 stale 이면(소스가 던진 뒤 자리 확인 실패) 탭을 다시 찾는다", async () => {
    let n = 0;
    const { calls, d } = setup((op) => {
      if (op === "runJsFast") return ++n === 1 ? { stale: true } : { value: "ok" };
      if (op === "settle") return { status: "same", leaving: false, tab: { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false } };
      return undefined;
    });
    const { tab } = await d.openTab("http://x/");
    expect(await d.runJs(tab.key, "1")).toBe("ok");
    expect(calls.map((c) => c.op)).toEqual(["openTab", "runJsFast", "settle", "runJsFast"]);
  });

  test("식이 아닌 소스는 호스트에 보내지 않고 오류로 알린다(사파리가 조용히 빈 값을 주기 때문)", async () => {
    const { calls, d } = setup(() => ({ value: "x" }));
    const { tab } = await d.openTab("http://x/");
    await expect(d.runJs(tab.key, "var a = 1; a")).rejects.toMatchObject({ code: "SAFARI_ERROR", message: expect.stringContaining("식 하나") });
    expect(calls.map((c) => c.op)).toEqual(["openTab"]);
  });

  test("showTab 은 확인 스크립트를 함께 보낸다(우리 창 안 탭만)", async () => {
    const { calls, d } = setup((op) => (op === "showTab" ? { value: null } : undefined));
    const w = await d.openWindow("http://x/");
    await d.showTab(w.tab.key);
    const show = calls.find((c) => c.op === "showTab")!;
    expect(show.args.script).toContain("dataset.saTab");
    expect(show.args.windowId).toBe(5);
  });

  test("runJsFast 의 오류도 runJs 와 같게 가른다(경고창 시간 초과 · 탭 사라짐 · JS 꺼짐)", () => {
    expect(opError("runJsFast", new HostTimeoutError("runJsFast", 3000)).code).toBe("ALERT_BLOCKED");
    expect(opError("runJsFast", new HostError("x", -1728)).code).toBe("TAB_CLOSED");
    expect(opError("runJsFast", new HostError("Safari에서 Apple 이벤트의 JavaScript를 허용하지 않습니다.")).code).toBe("JS_FROM_APPLE_EVENTS_OFF");
    expect(opError("showTab", new HostTimeoutError("showTab", 3000)).code).toBe("TIMEOUT");
  });
});
