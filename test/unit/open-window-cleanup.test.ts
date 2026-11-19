import { describe, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import { HostTimeoutError } from "../../src/driver/jxa-host.js";

type Call = { op: string; args: Record<string, unknown> };

/** 호스트를 흉내 낸다: 요청이 닿은 순서를 적고, op 별 답(또는 던질 오류)을 돌려준다. */
function stubHost(answers: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = [];
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

describe("openWindow 가 시간을 넘겼을 때 새 창 치우기", () => {
  test("만들기 전 창 목록에 없던 창 가운데 우리 표시가 있는 것만 닫는다", async () => {
    const { calls, host } = stubHost({
      windowIds: [11, 22],
      openWindow: new HostTimeoutError("openWindow", 40000),
      closeStamped: { closed: 1, unconfirmed: 0 },
      ping: "pong",
    });
    const d = createJxaDriver({ host });
    await expect(d.openWindow("http://x/")).rejects.toMatchObject({ code: "TIMEOUT" });
    const ops = calls.map((c) => c.op);
    expect(ops.slice(0, 3)).toEqual(["windowIds", "openWindow", "closeStamped"]);
    const open = calls[1]!.args;
    const clean = calls[2]!.args;
    expect(clean.beforeIds).toEqual([11, 22]);
    expect(clean.key).toBe(open.key); // 열 때 적으려던 표시와 같다
  });

  test("표시를 못 확인한 새 창이 있으면 남았을 수 있다고 알린다", async () => {
    const { host } = stubHost({
      windowIds: [1],
      openWindow: new HostTimeoutError("openWindow", 40000),
      closeStamped: { closed: 0, unconfirmed: 1 },
    });
    const d = createJxaDriver({ host });
    const err = await d.openWindow("http://x/").catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("창이 남았을 수");
  });

  test("치우기도 못 하면 그 사실을 알리고 원래 오류 코드는 그대로", async () => {
    const { host } = stubHost({
      windowIds: [1],
      openWindow: new HostTimeoutError("openWindow", 40000),
      closeStamped: new Error("호스트 오류"),
    });
    const d = createJxaDriver({ host });
    const err = await d.openWindow("http://x/").catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("창이 남았을 수");
  });

  test("정상으로 열리면 치우기를 부르지 않는다", async () => {
    const { calls, host } = stubHost({
      windowIds: [1],
      openWindow: { windowId: 5, windowIndex: 2, tab: { windowId: 5, index: 1, title: "", url: "http://x/", isActive: true }, stamped: true },
      lsappinfo: "",
    });
    const d = createJxaDriver({ host });
    const r = await d.openWindow("http://x/");
    expect(r.windowId).toBe(5);
    expect(calls.some((c) => c.op === "closeStamped")).toBe(false);
  });
});

describe("showTab", () => {
  const tab = (windowId: number) => ({ windowId, index: 1, title: "", url: "http://x/", isActive: false, stamped: true });

  test("우리가 연 창 안의 탭이면 호스트에 현재 탭으로 만들라고 시킨다", async () => {
    const { calls, host } = stubHost({
      windowIds: [1],
      openWindow: { windowId: 5, tab: { windowId: 5, index: 1, title: "", url: "http://x/", isActive: true }, stamped: true },
      runJs: { value: "1", url: "http://x/" },
      showTab: { value: null },
    });
    const d = createJxaDriver({ host });
    const { tab: t } = await d.openWindow("http://x/");
    await d.showTab(t.key);
    const call = calls.find((c) => c.op === "showTab")!;
    expect(call.args).toMatchObject({ windowId: 5, index: 1 });
  });

  test("사용자 창(우리가 연 창이 아닌 곳)의 탭이면 호스트를 부르지 않고 SAFARI_ERROR", async () => {
    const { calls, host } = stubHost({ openTab: tab(7), showTab: { value: null } });
    const d = createJxaDriver({ host });
    const { tab: t } = await d.openTab("http://x/", { windowId: 7 });
    await expect(d.showTab(t.key)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    expect(calls.some((c) => c.op === "showTab")).toBe(false);
  });
});

describe("adoptWindow(사용자가 AI 전용 창으로 고른 창)", () => {
  const tab = (windowId: number) => ({ windowId, index: 2, title: "", url: "http://x/", isActive: false, stamped: true });
  const state = { gone: false, bounds: { x: 0, y: 0, width: 500, height: 400 }, inner: { innerWidth: 480, innerHeight: 300 } };
  const answers = () => ({
    windowState: state,
    // 요청한 바깥 크기를 그대로 받아들인 것처럼 답한다(테두리 20 · 100 은 그대로).
    setBounds: () => ({ gone: false, bounds: { x: 0, y: 0, width: 420, height: 944 }, inner: { innerWidth: 400, innerHeight: 844 } }),
    openTab: tab(7),
    showTab: { value: null },
    closeTab: { value: null },
    closeWindow: { gone: false, closed: true },
  });

  test("고른 뒤에는 그 창의 탭을 앞에 보이고 크기를 바꿀 수 있다", async () => {
    const { calls, host } = stubHost(answers());
    const d = createJxaDriver({ host });
    await d.adoptWindow(7);
    const { tab: t } = await d.openTab("http://x/", { windowId: 7 });
    await d.showTab(t.key);
    expect(calls.some((c) => c.op === "showTab")).toBe(true);
    await d.setWindowSize(7, 400, 844);
    expect(calls.some((c) => c.op === "setBounds")).toBe(true);
  });

  test("고르지 않은 창은 여전히 막힌다(크기 · 앞에 보이기)", async () => {
    const { calls, host } = stubHost(answers());
    const d = createJxaDriver({ host });
    await expect(d.setWindowSize(7, 400, 844)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    const { tab: t } = await d.openTab("http://x/", { windowId: 7 });
    await expect(d.showTab(t.key)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    expect(calls.some((c) => c.op === "setBounds" || c.op === "showTab")).toBe(false);
  });

  test("없는 창은 WINDOW_CLOSED, 고르지 못한다", async () => {
    const { host } = stubHost({ windowState: { gone: true } });
    const d = createJxaDriver({ host });
    await expect(d.adoptWindow(7)).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
    await expect(d.setWindowSize(7, 400, 400)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
  });

  test("고른 창은 closeWindow 로 닫히지 않고, closeOwned 는 우리 탭만 닫는다", async () => {
    const { calls, host } = stubHost(answers());
    const d = createJxaDriver({ host });
    await d.adoptWindow(7);
    await expect(d.closeWindow(7)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    await d.openTab("http://x/", { windowId: 7 });
    expect(await d.closeOwned()).toBe(1);
    expect(calls.filter((c) => c.op === "closeWindow")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "closeTab")).toHaveLength(1);
    // closeOwned 뒤에는 고른 창도 놓아 준다
    await expect(d.setWindowSize(7, 400, 844)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
  });
});
