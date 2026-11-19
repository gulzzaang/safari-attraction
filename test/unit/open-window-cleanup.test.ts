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
