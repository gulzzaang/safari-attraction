import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { hoistTopLevel } from "../../src/repl/transform.js";
import { SNAPSHOT_LIMIT_BYTES } from "../../src/snapshot/diff.js";
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

  test("display 는 계획 2 안내 오류", async () => {
    expect((await s.run("display()")).error).toContain("AI 전용 창 방식(계획 2)");
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
