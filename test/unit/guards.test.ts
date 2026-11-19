import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installProcessGuards } from "../../src/guards.js";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { createFakeDriver, type FakeDriver } from "../helpers/fake-driver.js";

const EVENTS = ["unhandledRejection", "uncaughtException"] as const;

let d: FakeDriver;
let s: ReplSession;
let stop: ReturnType<typeof vi.fn>;
let uninstall: () => void;
let saved: Record<string, NodeJS.UnhandledRejectionListener[] | NodeJS.UncaughtExceptionListener[]>;

beforeEach(() => {
  d = createFakeDriver();
  s = createReplSession(d);
  stop = vi.fn();
  // 시험 실행기(vitest) 자신의 처리 안 된 거부 · 오류 감시를 잠깐 떼고, 서버가 쓰는 핸들러만 건다.
  saved = {};
  for (const ev of EVENTS) {
    saved[ev] = process.listeners(ev) as never;
    process.removeAllListeners(ev);
  }
  uninstall = installProcessGuards(process, { handleStray: (r, k) => s.handleStray(r, k), stop, log: () => {} });
});
afterEach(async () => {
  uninstall();
  for (const ev of EVENTS) for (const l of saved[ev] as never[]) process.on(ev as never, l);
  await s.dispose();
});

describe("서버 지키기(프로세스 핸들러)", () => {
  test("기다리지 않은 Promise.reject 는 서버를 죽이지 않고 그 호출 출력에 한 줄 남는다", async () => {
    const r = await s.run('Promise.reject(new Error("x")); await sleep(20); console.log("계속")');
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("계속");
    expect(r.output).toContain("주의: 기다리지 않은 비동기 작업");
    expect(r.output).toContain("x");
    expect(stop).not.toHaveBeenCalled();
    // 세션은 그대로 쓸 수 있다
    expect((await s.run("console.log(1 + 1)")).output).toBe("2");
  });

  test("await 빠진 실패한 locator 동작도 서버를 죽이지 않는다", async () => {
    d.answer = () => {
      throw new Error("페이지 오류");
    };
    const r = await s.run('const p9 = await openTab("http://a/"); p9.locator("e1").click(); await sleep(30); console.log("살아 있음")');
    expect(r.output).toContain("살아 있음");
    expect(r.output).toContain("주의: 기다리지 않은 비동기 작업");
    expect(stop).not.toHaveBeenCalled();
    expect((await s.run("console.log(tabs.length)")).output).toBe("1");
  });

  test("타이머 콜백이 던져도 REPL 코드 것이면 서버는 살고 종료 절차를 밟지 않는다", async () => {
    const r = await s.run('setTimeout(() => { throw new Error("늦은 오류") }, 1); await sleep(30); console.log("계속")');
    expect(r.output).toContain("계속");
    expect(r.output).toContain("타이머나 콜백");
    expect(r.output).toContain("늦은 오류");
    expect(stop).not.toHaveBeenCalled();
    expect((await s.run("console.log(7)")).output).toBe("7");
  });

  test("호출이 끝난 뒤에 거부돼도 다음 호출 출력에 섞이지 않는다", async () => {
    await s.run('setTimeout(() => Promise.reject(new Error("나중")), 20)');
    await new Promise((r) => setTimeout(r, 50));
    expect(stop).not.toHaveBeenCalled();
    expect((await s.run("console.log(3)")).output).toBe("3");
  });

  test("서버 자신의 잡히지 않은 오류(REPL 코드 밖)는 정상 종료 절차로 간다", async () => {
    process.emit("uncaughtException", new Error("서버 버그"), "uncaughtException");
    expect(stop).toHaveBeenCalledWith(1);
  });
});
