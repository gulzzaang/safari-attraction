import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { hoistTopLevel } from "../../src/repl/transform.js";
import { SNAPSHOT_LIMIT_BYTES } from "../../src/snapshot/diff.js";
import { SafariError } from "../../src/driver/types.js";
import { createFakeDriver, type FakeDriver } from "../helpers/fake-driver.js";

let d: FakeDriver;
let s: ReplSession;
beforeEach(() => {
  d = createFakeDriver();
  s = createReplSession(d);
});
afterEach(async () => {
  await s.dispose();
});

describe("REPL 실행기", () => {
  test("const 가 다음 호출에도 남는다", async () => {
    await s.run("const x1 = 41");
    expect((await s.run("console.log(x1+1)")).output).toBe("42");
  });

  test("top-level await 가 된다", async () => {
    const r = await s.run('await sleep(1); console.log("ok")');
    expect(r).toEqual({ output: "ok" });
  });

  test("오류는 output 이 아니라 error 로", async () => {
    const r = await s.run('console.log("먼저"); throw new Error("앗")');
    expect(r.error).toContain("앗");
    expect(r.output).toBe("먼저");
  });

  test("openTab 이 page 와 tabs 를 바꾼다", async () => {
    const r = await s.run('const p = await openTab("http://a/"); console.log(p.key, page.key, tabs.length, p === page)');
    expect(d.calls.openTab).toEqual([{ url: "http://a/", windowId: undefined }]);
    expect(r.output).toBe("t1 t1 1 true");
    await s.run('await openTab("http://b/")');
    expect((await s.run("console.log(page.key, tabs.map(t => t.key).join())")).output).toBe("t2 t1,t2");
  });

  test("출력이 길면 16KB 에서 자른다", async () => {
    const r = await s.run('console.log("가".repeat(20000))');
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(SNAPSHOT_LIMIT_BYTES);
    expect(r.output).toContain("16KB 에서 자름");
  });
});

describe("hoistTopLevel", () => {
  test("최상위 선언만 전역 대입으로 바꾼다(함수 안 · 반복문 머리는 그대로)", () => {
    const out = hoistTopLevel("const a = 1, { b } = o; let c; for (let i = 0; i < 2; i++) { const z = i } function f() { const q = 1 }");
    expect(out).toContain("(a = 1, { b } = o);");
    expect(out).toContain("c = undefined");
    expect(out).toContain("for (let i = 0");
    expect(out).toContain("const z = i");
    expect(out).toContain("const q = 1");
  });

  test("문법 오류는 한국어로 던진다", () => {
    expect(() => hoistTopLevel("const = ;")).toThrow(/문법/);
  });
});

describe("세미콜론 없는 코드(ASI)", () => {
  test("세미콜론 없는 문장 뒤의 const · let", async () => {
    expect((await s.run("console.log(1)\nconst a = 2\nconsole.log(a)")).output).toBe("1\n2");
    expect((await s.run("console.log(3)\nlet b = 4\nconsole.log(b)")).output).toBe("3\n4");
  });

  test("세미콜론 없이 두 변수를 선언하고 쓴다", async () => {
    const r = await s.run("const x = 1\nlet y = x + 1\nconst { z } = { z: y * 2 }\nconsole.log(x, y, z)");
    expect(r).toEqual({ output: "1 2 4" });
  });
});

describe("REPL 세부", () => {
  test("구조 분해 · let · var · function · class 가 남는다", async () => {
    await s.run("const { a, b: [c] } = { a: 1, b: [2] }; let n; var v = 5; function dbl(x) { return x * 2 } class K { get() { return 7 } }");
    expect((await s.run("console.log(a, c, n, v, dbl(4), new K().get())")).output).toBe("1 2 undefined 5 8 7");
  });

  test("함수 선언은 선언 앞에서도 부를 수 있다", async () => {
    expect((await s.run("console.log(f()); function f() { return 'hi' }")).output).toBe("hi");
  });

  test("문법 오류는 error 로", async () => {
    const r = await s.run("const = ;");
    expect(r.error).toMatch(/문법/);
  });

  test("객체는 util.inspect 로 찍힌다", async () => {
    expect((await s.run("console.log({ a: 1, b: [1, 2] }, 'x')")).output).toBe("{ a: 1, b: [ 1, 2 ] } x");
  });

  test("시간 초과는 error 로, 그때까지의 출력은 남는다", async () => {
    const r = await s.run('console.log("시작"); await sleep(500)', { timeoutMs: 50 });
    expect(r.error).toMatch(/시간/);
    expect(r.output).toBe("시작");
  });

  test("동기 무한 반복도 시간 초과로 끊는다", async () => {
    const r = await s.run("while (true) {}", { timeoutMs: 100 });
    expect(r.error).toMatch(/시간/);
  });

  test("호출이 겹쳐도 차례로 돈다", async () => {
    const [a, b] = await Promise.all([s.run('await sleep(20); console.log("a")'), s.run('console.log("b")')]);
    expect([a.output, b.output]).toEqual(["a", "b"]);
  });

  test("closeTab: 우리가 연 탭은 닫고, page 와 tabs 를 고친다", async () => {
    await s.run('await openTab("http://a/"); await openTab("http://b/")');
    await s.run("await closeTab(page)");
    expect(d.calls.closeTab).toEqual(["t2"]);
    expect((await s.run("console.log(page.key, tabs.length)")).output).toBe("t1 1");
    await s.run("await closeTab(page)");
    expect((await s.run("console.log(page, tabs.length)")).output).toBe("null 0");
  });

  test("listBrowserTabs 는 붙이지 않고, attachBrowserTab 은 page 를 바꾸고 closeTab 은 떼기만 한다", async () => {
    d.userTabs = [{ key: "t9", windowId: 1, index: 1, title: "내 탭", url: "http://u/", isActive: true, owned: false }];
    const r = await s.run("const l = await listBrowserTabs(); console.log(l.length, l[0].title, page)");
    expect(r.output).toBe("1 내 탭 null");
    expect((await s.run("const p = await attachBrowserTab('t9'); console.log(page.key, tabs.length, p === page)")).output).toBe("t9 1 true");
    await s.run("await closeTab(page)");
    expect(d.calls.closeTab).toEqual([]);
    expect((await s.run("console.log(page, tabs.length)")).output).toBe("null 0");
    expect((await s.run("await attachBrowserTab('t99')")).error).toMatch(/t99/);
  });

  test("attachActiveBrowserTab 은 맨 앞 창의 활성 탭을 붙인다", async () => {
    d.userTabs = [
      { key: "t5", windowId: 2, index: 1, title: "", url: "http://other/", isActive: true, owned: false },
      { key: "t6", windowId: 1, index: 1, title: "", url: "http://x/", isActive: false, owned: false },
      { key: "t7", windowId: 1, index: 2, title: "", url: "http://front/", isActive: true, owned: false },
    ];
    expect((await s.run("await attachActiveBrowserTab(); console.log(page.key)")).output).toBe("t7");
  });

  test("snapshot: 처음엔 전체, 그다음 같으면 변화 없음, 바뀌면 diff 가 찍힌다", async () => {
    let text = "- title: \"a\" [url=http://a/]\n- link \"x\" [ref=e1]\n- paragraph \"긴 문단 긴 문단 긴 문단 긴 문단 긴 문단 긴 문단\"\n- paragraph \"또 긴 문단 또 긴 문단 또 긴 문단 또 긴 문단\"";
    d.answer = () => text;
    await s.run('await openTab("http://a/")');
    const first = await s.run("const r = await snapshot(page); console.log(r)");
    expect(first.output).toBe(text);
    expect((await s.run("console.log(await snapshot(page))")).output).toBe("변화 없음");
    text = text.replace("link \"x\"", "link \"y\"");
    const third = await s.run("const r3 = await snapshot(page); console.log(r3); console.log(r3.tree === " + JSON.stringify(text) + ")");
    expect(third.output).toContain('- - link "x" [ref=e1]');
    expect(third.output).toContain('+ - link "y" [ref=e1]');
    expect(third.output.split("\n").at(-1)).toBe("true");
  });

  test("snapshot: 내린 뒤에는 새로 보이는 줄만 찍히고 tree 는 안내 줄 없는 지금 화면", async () => {
    const mk = (y: number, nums: number[]) => `#sa-meta scroll=0,${y} doc=d1\n- title: "a" [url=http://a/]\n` + nums.map((n) => `- paragraph "문단 ${n} 문단 ${n} 문단 ${n}"`).join("\n");
    let text = mk(0, [1, 2, 3]);
    d.answer = () => text;
    await s.run('await openTab("http://a/")');
    const first = await s.run("console.log(await snapshot(page))");
    expect(first.output).not.toContain("#sa-meta");
    expect(first.output).toContain("문단 1");
    text = mk(1000, [3, 4, 5]);
    const r = await s.run("const r2 = await snapshot(page); console.log(r2); console.log(r2.tree.startsWith('- title:'))");
    expect(r.output).toContain("# 내린 뒤 새로 보이는 곳만 (이미 본 줄 1개 · 화면 밖으로 지나간 줄 2개 생략)");
    expect(r.output).toContain("문단 4");
    expect(r.output).not.toContain("문단 1");
    expect(r.output.split("\n").at(-1)).toBe("true");
    text = mk(0, [1, 2, 3]);
    expect((await s.run("console.log(await snapshot(page))")).output).toBe("새로 보이는 곳 없음(이미 읽은 곳)");
  });

  test("snapshot 에 선택지가 JSON 소스로 전달된다", async () => {
    d.answer = () => "x";
    await s.run('await openTab("http://a/"); await snapshot(page, { interactive: true })');
    expect(d.calls.runJs[0]!.source).toContain('"interactive":true');
  });

  test("page 없이 snapshot · fetch 는 분명한 오류", async () => {
    expect((await s.run("await snapshot()")).error).toMatch(/page/);
    expect((await s.run('await fetch("/x")')).error).toMatch(/page/);
  });

  test("fetch 는 페이지 안에서 돌고 text · json 을 돌려준다", async () => {
    d.answer = (_k, src) => {
      if (!src.includes("__saA")) return "";
      return JSON.stringify({ ok: true, r: { s: JSON.stringify({ status: 201, ok: true, statusText: "Created", url: "http://a/api", headers: { "content-type": "application/json" }, body: '{"n":3}' }) } });
    };
    await s.run('await openTab("http://a/")');
    const r = await s.run('const res = await fetch("/api", { method: "POST" }); console.log(res.status, res.ok, res.headers["content-type"], (await res.json()).n, await res.text())');
    expect(r.output).toBe('201 true application/json 3 {"n":3}');
    const sent = d.calls.runJs.find((c) => c.source.includes('__saA'))!.source;
    expect(sent).toContain("/api");
    expect(sent).toContain("POST");
  });

  test("시간 초과한 호출의 늦은 출력이 다음 호출에 섞이지 않는다", async () => {
    const r1 = await s.run('setTimeout(() => console.log("zombie-timer"), 100); await sleep(500)', { timeoutMs: 30 });
    expect(r1.error).toMatch(/시간/);
    const r2 = await s.run('await sleep(250); console.log("mine")');
    expect(r2).toEqual({ output: "mine" });
  });

  test("시간 초과한 호출이 sleep 뒤에 이어 찍는 것도 버린다", async () => {
    await s.run('await sleep(100); console.log("zombie-sleep")', { timeoutMs: 30 });
    const r2 = await s.run('await sleep(250); console.log("mine")');
    expect(r2).toEqual({ output: "mine" });
  });

  test("드라이버 호출을 기다리던 늦은 코드의 출력도 다음 호출에 안 섞인다", async () => {
    // 실제 프로토콜로 답해야 page.evaluate 가 성공해 늦은 console.log 까지 간다(150ms 뒤에 답한다).
    d.answer = (_k, src) => new Promise((r) => setTimeout(() => r(src.includes("__saA") ? JSON.stringify({ ok: true, r: { s: "1" } }) : ""), 150)) as Promise<string>;
    await s.run('await openTab("http://a/")');
    const r1 = await s.run('await page.evaluate("1"); console.log("zombie-driver")', { timeoutMs: 30 });
    expect(r1.error).toMatch(/시간/);
    const r2 = await s.run('await sleep(250); console.log("mine")');
    expect(r2).toEqual({ output: "mine" });
  });

  test("호출 하나 안에서는 await · 타이머 뒤에도 자기 출력에 찍힌다", async () => {
    const r = await s.run('setTimeout(() => console.log("t"), 10); await new Promise((r) => setTimeout(r, 40)); await Promise.resolve(); console.log("p")');
    expect(r).toEqual({ output: "t\np" });
  });
});

describe("dispose", () => {
  test("돌고 있는 호출이 멈춰 있어도 우리 탭부터 바로 닫는다", async () => {
    const d2 = createFakeDriver();
    d2.answer = () => new Promise<string>(() => {}); // 영원히 안 오는 답
    const s2 = createReplSession(d2);
    const running = s2.run('const hp = await openTab("http://a/"); await hp.title()', { timeoutMs: 3000 });
    while (d2.calls.runJs.length === 0) await new Promise((r) => setTimeout(r, 10)); // 호출이 멈춘 자리에 닿을 때까지
    const t0 = Date.now();
    await s2.dispose();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await d2.listTabs()).length).toBe(0);
    const r = await running;
    expect(r.error).toBeTruthy(); // 시간 초과로 끝남
  });

  test("끝난 뒤에는 openTab 이 거절된다", async () => {
    const d2 = createFakeDriver();
    const s2 = createReplSession(d2);
    await s2.dispose();
    const r = await s2.run('await openTab("http://a/")');
    expect(r.error).toContain("끝나는 중");
    expect(d2.calls.openTab).toHaveLength(0);
  });
});

describe("page.url()", () => {
  test("openTab 직후 await 없이 부르면 열린 주소 글이 나온다(Promise 가 아니다)", async () => {
    const r = await s.run('const up = await openTab("http://a/"); console.log(typeof up.url(), up.url())');
    expect(r.error).toBeFalsy();
    expect(r.output).toContain("string http://a/");
  });
});

describe("앞 창 알림", () => {
  test("openTab 이 사파리를 맨 앞으로 불러냈으면 그 호출 출력에 한국어 주의가 남는다", async () => {
    d.frontAppChanged = true;
    const r = await s.run('await openTab("http://a/"); console.log("열림")');
    expect(r.output).toContain("주의: 사파리가 맨 앞으로 나왔어요");
    expect(r.output).toContain("열림");
  });

  test("바뀌지 않았으면 주의가 없다", async () => {
    const r = await s.run('await openTab("http://a/"); console.log("열림")');
    expect(r.output).toBe("열림");
  });
});

describe("AI 전용 창", () => {
  test("openAiWindow 는 처음엔 창을 열고 두 번째엔 같은 창에 탭을 연다", async () => {
    const r = await s.run(
      'const a1 = await openAiWindow("http://a/", {width: 390, height: 844}); const a2 = await openAiWindow("http://b/"); console.log(a1.key, a2.key, tabs.length, page === a2)',
    );
    expect(r.error).toBeUndefined();
    expect(d.calls.openWindow).toEqual([{ url: "http://a/", width: 390, height: 844 }]);
    expect(d.calls.openTab).toHaveLength(1);
    expect(d.calls.openTab[0]!.windowId).toBe(101);
    expect(d.calls.openTab[0]!.url).toBe("http://b/");
    expect(r.output).toBe("t1 t2 2 true");
  });

  test("기본 크기는 1280×800 이고 주소는 about:blank", async () => {
    await s.run("await openAiWindow()");
    expect(d.calls.openWindow).toEqual([{ url: "about:blank", width: 1280, height: 800 }]);
  });

  test("이미 열린 창에 크기를 명시하면 그 창 크기를 바꾼다", async () => {
    await s.run('await openAiWindow("http://a/"); await openAiWindow("http://b/", {width: 500, height: 600})');
    expect(d.calls.setWindowSize).toEqual([{ windowId: 101, width: 500, height: 600 }]);
  });

  test("setViewportSize 는 실제 크기를 돌려주고, 최소 폭에 막히면 안내가 나온다", async () => {
    d.setWindowSize = async (_id, w, h) => ({ innerWidth: Math.max(w, 336), innerHeight: h });
    const r = await s.run('await openAiWindow("http://a/"); const v = await page.setViewportSize({width: 200, height: 500}); console.log(JSON.stringify(v))');
    expect(r.output).toContain("사파리 창은 약 336px 보다 좁게 못 줄여요(지금 336 px)");
    expect(r.output).toContain('{"width":336,"height":500}');
  });

  test("setViewportSize 가 요청 그대로면 안내가 없다", async () => {
    const r = await s.run('await openAiWindow("http://a/"); const v = await page.setViewportSize({width: 390, height: 844}); console.log(JSON.stringify(v))');
    expect(r.output).toBe('{"width":390,"height":844}');
  });

  test("뒤쪽 탭 page 에서 screenshot · setViewportSize 는 안내 오류", async () => {
    await s.run('await openTab("http://a/")');
    const r = await s.run("await page.screenshot()");
    expect(r.error).toContain("AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요");
    const r2 = await s.run("await page.setViewportSize({width: 390, height: 800})");
    expect(r2.error).toContain("화면 크기 바꾸기는 AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요");
    expect(d.calls.captureWindow).toHaveLength(0);
    expect(d.calls.setWindowSize).toHaveLength(0);
  });

  test("screenshot 은 탭을 창의 현재 탭으로 만든 뒤 찍는다", async () => {
    const r = await s.run('await openAiWindow("http://a/"); await openAiWindow("http://b/"); const buf = await page.screenshot(); console.log(buf.length)');
    expect(r.error).toBeUndefined();
    expect(r.output).toBe("8");
    expect(d.calls.showTab).toEqual(["t2"]);
    expect(d.calls.captureWindow).toEqual([101]);
  });

  test("display 한 이미지는 결과에 base64 로 붙는다", async () => {
    const r = await s.run('await openAiWindow("http://a/"); display(await page.screenshot()); console.log("찍음")');
    expect(r.output).toBe("찍음");
    expect(r.images).toEqual([d.png.toString("base64")]);
  });

  test("이미지가 5장이면 4장만 붙고 안내 줄", async () => {
    const r = await s.run('await openAiWindow("http://a/"); const b = await page.screenshot(); for (let i = 0; i < 5; i++) display(b)');
    expect(r.images).toHaveLength(4);
    expect(r.output).toContain("이미지는 한 번에 4장까지");
  });

  test("display 는 이미지가 아닌 것을 거절한다", async () => {
    const r = await s.run('display("글")');
    expect(r.error).toContain("display");
  });

  test("이미지가 없으면 결과에 images 가 없다", async () => {
    expect(await s.run('console.log("x")')).toEqual({ output: "x" });
  });

  test("오류가 나도 그 전에 display 한 이미지는 남는다", async () => {
    const r = await s.run('await openAiWindow("http://a/"); display(await page.screenshot()); throw new Error("앗")');
    expect(r.error).toContain("앗");
    expect(r.images).toHaveLength(1);
  });

  test("SCREEN_CAPTURE_DENIED 는 errorCode 로 온다", async () => {
    d.screenAllowed = false;
    const r = await s.run('await openAiWindow("http://a/"); await page.screenshot()');
    expect(r.errorCode).toBe("SCREEN_CAPTURE_DENIED");
  });

  test("AI 창이 닫히면 WINDOW_CLOSED, 다시 openAiWindow 하면 새 창", async () => {
    await s.run('await openAiWindow("http://a/")');
    d.calls.openWindow.length = 0;
    await d.closeWindow(101); // 사용자가 창을 닫음
    const r = await s.run("await page.screenshot()");
    expect(r.errorCode).toBe("WINDOW_CLOSED");
    expect(d.calls.captureWindow).toHaveLength(0);
    // 닫힌 창의 옛 탭에서 다시 해도 같은 오류(「AI 창이 아니다」가 아님)
    expect((await s.run("await page.setViewportSize({width: 390, height: 800})")).errorCode).toBe("WINDOW_CLOSED");
    const r2 = await s.run('const again = await openAiWindow("http://c/"); console.log(again.key)');
    expect(r2.error).toBeUndefined();
    expect(d.calls.openWindow).toHaveLength(1);
    expect(d.calls.openTab).toHaveLength(0);
    // 새 창에서는 다시 찍힌다
    expect((await s.run("await page.screenshot()")).error).toBeUndefined();
  });

  test("openAiWindow 는 창이 이미 닫혀 있으면 막지 않고 새 창을 연다", async () => {
    await s.run('await openAiWindow("http://a/")');
    await d.closeWindow(101);
    const r = await s.run('await openAiWindow("http://b/")');
    expect(r.error).toBeUndefined();
    expect(d.calls.openWindow).toHaveLength(2);
    expect(r.output).toContain("AI 전용 창이 닫혀 있어서 새로 열었어요");
  });

  test("AI 창 탭을 닫아도 열린 창은 dispose 때 닫힌다", async () => {
    await s.run('await openAiWindow("http://a/")');
    await s.dispose();
    expect(await d.listWindows()).toHaveLength(1); // 사용자 창만 남음
  });

  test("사파리가 앞으로 나왔으면 알린다", async () => {
    d.frontAppChanged = true;
    const r = await s.run('await openAiWindow("http://a/")');
    expect(r.output).toContain("주의: 사파리가 맨 앞으로 나왔어요");
  });

  test("끝난 뒤에는 openAiWindow 가 거절된다", async () => {
    await s.dispose();
    const r = await s.run('await openAiWindow("http://a/")');
    expect(r.error).toContain("끝나는 중");
    expect(d.calls.openWindow).toHaveLength(0);
  });

  test("screenshot 중 드라이버가 WINDOW_CLOSED 를 던져도 상태를 비우고 알린다", async () => {
    await s.run('await openAiWindow("http://a/")');
    d.captureWindow = async () => {
      throw new SafariError("WINDOW_CLOSED", "창 닫힘");
    };
    expect((await s.run("await page.screenshot()")).errorCode).toBe("WINDOW_CLOSED");
    d.calls.openWindow.length = 0;
    await s.run('await openAiWindow("http://x/")');
    expect(d.calls.openWindow).toHaveLength(1);
  });
});

describe("창 고르기(listWindows · useWindow · useAiWindow)", () => {
  /** 사용자가 창을 하나 더 열어 둔 상태를 흉내 낸다(가짜 드라이버의 창 하나, 번호 101). */
  const openSecondWindow = async () => (await d.openWindow("http://w/", { width: 800, height: 600 })).windowId;

  test("listWindows 는 창 고르는 근거(제목 · 탭 수 · 크기 · 표시)를 돌려준다", async () => {
    d.windows[0]!.title = "첫 창 탭";
    d.windows[0]!.tabCount = 3;
    await openSecondWindow();
    const r = await s.run("console.log(JSON.stringify(await listWindows()))");
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.output)).toEqual([
      { id: 1, index: 1, title: "첫 창 탭", tabCount: 3, width: 1200, height: 800, isAiWindow: false, isWorkWindow: false },
      { id: 101, index: 2, title: "", tabCount: 1, width: 800, height: 600, isAiWindow: false, isWorkWindow: false },
    ]);
  });

  test("useWindow 뒤 openTab 은 그 창에 열리고, listWindows 가 표시한다", async () => {
    const id = await openSecondWindow();
    const r = await s.run(`await useWindow(${id}); const p = await openTab("http://a/"); console.log(JSON.stringify((await listWindows()).map(w => [w.id, w.isWorkWindow])))`);
    expect(r.error).toBeUndefined();
    expect(d.calls.openTab).toEqual([{ url: "http://a/", windowId: id }]);
    expect(r.output).toBe("[[1,false],[101,true]]");
  });

  test("useWindow(null) 이면 맨 앞 창(기본)으로 돌아간다", async () => {
    const id = await openSecondWindow();
    await s.run(`await useWindow(${id}); await openTab("http://a/"); await useWindow(null); await openTab("http://b/")`);
    expect(d.calls.openTab).toEqual([
      { url: "http://a/", windowId: id },
      { url: "http://b/", windowId: undefined },
    ]);
  });

  test("고른 창이 사라지면 안내 한 줄을 남기고 맨 앞 창으로 돌아가며, 그다음엔 안내가 없다", async () => {
    const id = await openSecondWindow();
    await s.run(`await useWindow(${id})`);
    await d.closeWindow(id); // 사용자가 창을 닫음
    const r = await s.run('await openTab("http://a/")');
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("고른 창이 닫혀서 맨 앞 창으로 돌아갑니다");
    expect(d.calls.openTab).toEqual([{ url: "http://a/", windowId: undefined }]);
    const r2 = await s.run('await openTab("http://b/")');
    expect(r2.output).toBe("");
    expect(d.calls.openTab[1]).toEqual({ url: "http://b/", windowId: undefined });
  });

  test("확인한 뒤 열기 전에 창이 닫혀 openTab 이 실패해도 맨 앞 창으로 다시 연다", async () => {
    const id = await openSecondWindow();
    await s.run(`await useWindow(${id})`);
    const real = d.openTab.bind(d);
    d.openTab = async (url, opts) => {
      if (opts?.windowId === id) {
        await d.closeWindow(id); // 확인과 열기 사이에 창이 닫힘
        throw new SafariError("SAFARI_ERROR", "Can't get window");
      }
      return real(url, opts);
    };
    const r = await s.run('const q = await openTab("http://a/"); console.log(q.key)');
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("고른 창이 닫혀서 맨 앞 창으로 돌아갑니다");
    expect(d.calls.openTab.at(-1)).toEqual({ url: "http://a/", windowId: undefined });
  });

  test("창이 살아 있는데 openTab 이 실패하면 그 오류를 그대로 올린다", async () => {
    const id = await openSecondWindow();
    await s.run(`await useWindow(${id})`);
    d.openTab = async () => {
      throw new SafariError("SAFARI_ERROR", "열기 실패");
    };
    const r = await s.run('await openTab("http://a/")');
    expect(r.error).toContain("열기 실패");
  });

  test("없는 창 번호는 오류(useWindow · useAiWindow)", async () => {
    for (const code of ["await useWindow(999)", "await useWindow('abc')", "await useWindow()", "await useAiWindow(999)"]) {
      const r = await s.run(code);
      expect(r.error).toBe("그런 창이 없어요 — listWindows() 로 확인하세요");
    }
    expect(d.calls.adoptWindow).toHaveLength(0);
  });

  test("useAiWindow 창에는 우리 탭이 열리고 크기 · 찍기가 되며, 창은 dispose 때 닫지 않고 우리 탭만 닫는다", async () => {
    d.userTabs.push({ key: "u1", windowId: 1, index: 1, title: "내 탭", url: "http://mine/", isActive: true, owned: false });
    const r = await s.run(`await useAiWindow(1);
      const ai = await openAiWindow("http://a/");
      const v = await page.setViewportSize({width: 390, height: 844});
      display(await page.screenshot());
      console.log(ai.key, JSON.stringify(v), JSON.stringify((await listWindows()).map(w => [w.id, w.isAiWindow])))`);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe('t1 {"width":390,"height":844} [[1,true]]');
    expect(d.calls.adoptWindow).toEqual([1]);
    expect(d.calls.openWindow).toHaveLength(0); // 새 창을 열지 않고 고른 창을 쓴다
    expect(d.calls.openTab).toEqual([{ url: "http://a/", windowId: 1 }]);
    expect(d.calls.setWindowSize).toEqual([{ windowId: 1, width: 390, height: 844 }]);
    expect(d.calls.showTab).toEqual(["t1"]);
    expect(d.calls.captureWindow).toEqual([1]);
    expect(r.images).toHaveLength(1);

    await s.dispose();
    expect(d.calls.closeWindow).toEqual([]); // 사용자의 창은 닫지 않았다
    expect((await d.listWindows()).map((w) => w.id)).toEqual([1]);
    expect((await d.listTabs()).map((t) => t.key)).toEqual(["u1"]); // 우리가 연 탭만 사라졌다
  });

  test("고르지 않은 사용자 창에서는 크기 바꾸기가 드라이버에서도 막힌다", async () => {
    await expect(d.setWindowSize(1, 400, 400)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
  });

  test("useAiWindow 로 고른 창이 닫히면 WINDOW_CLOSED, 다시 openAiWindow 하면 새 창", async () => {
    const id = await openSecondWindow();
    await s.run(`await useAiWindow(${id}); await openAiWindow("http://a/")`);
    await d.closeWindow(id); // fake 에서는 우리 창이라 닫힌다(사용자가 닫은 것과 같다)
    expect((await s.run("await page.screenshot()")).errorCode).toBe("WINDOW_CLOSED");
    d.calls.openWindow.length = 0;
    expect((await s.run('await openAiWindow("http://b/")')).error).toBeUndefined();
    expect(d.calls.openWindow).toHaveLength(1);
  });

  test("다른 창을 AI 창으로 고르면 옛 AI 창의 살아 있는 탭은 「AI 창이 아니다」 안내", async () => {
    const other = await openSecondWindow();
    await s.run('await openAiWindow("http://a/")'); // 창 102(세션이 연 것)
    await s.run(`await useAiWindow(${other})`);
    const r = await s.run("await page.screenshot()"); // page 는 옛 AI 창의 탭
    expect(r.error).toContain("AI 전용 창에서만 돼요");
    expect(r.errorCode).toBeUndefined();
  });
});

describe("AI 창 기억 정리(Task 3 검토 반영)", () => {
  test("옛 AI 창이 닫힌 뒤 새 AI 창을 열어도 옛 탭은 WINDOW_CLOSED", async () => {
    await s.run('const old = await openAiWindow("http://a/")');
    await d.closeWindow(101); // 사용자가 창을 닫음
    const r = await s.run('await openAiWindow("http://b/")'); // 새 창 102
    expect(r.output).toContain("이전 AI 전용 창이 닫혀 있어서 새로 열었어요");
    const r2 = await s.run("await old.screenshot()");
    expect(r2.errorCode).toBe("WINDOW_CLOSED");
    expect(r2.error).not.toContain("AI 전용 창에서만 돼요");
    expect((await s.run("await page.screenshot()")).error).toBeUndefined(); // 새 창의 탭은 그대로 된다
  });

  test("closeTab 한 탭에서 다시 찍으면 TAB_CLOSED(「AI 창이 아니다」 아님)", async () => {
    await s.run('const gone = await openAiWindow("http://a/"); await openAiWindow("http://b/"); await closeTab(gone)');
    const r = await s.run("await gone.screenshot()");
    expect(r.errorCode).toBe("TAB_CLOSED");
    expect(r.error).not.toContain("AI 전용 창에서만 돼요");
  });
});
