import { describe, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";

type Call = { op: string; args: Record<string, unknown> };

/** 호스트 흉내: 우리 탭 하나를 열어 두고, 그 탭은 어디서도 표시가 안 보인다. tabs 는 사파리의 탭 목록. */
function setup(tabCount: number) {
  const calls: Call[] = [];
  const tabs = Array.from({ length: tabCount }, (_, i) => ({ windowId: 1, index: i + 1, title: "", url: `http://user/${i + 1}`, isActive: i === 0 }));
  const host = {
    async call(op: string, args: object = {}) {
      calls.push({ op, args: args as Record<string, unknown> });
      switch (op) {
        case "openTab":
          return { windowId: 1, index: 1, title: "", url: "http://a/x", isActive: false, stamped: true };
        case "closeTab":
          return { stale: true };
        case "settle":
          return { status: "gone" };
        case "probe":
          return { exists: true, url: "http://user/1", marker: "" };
        case "listTabs":
          return tabs;
        case "readMarkers":
          return (args as { spots: Array<{ windowId: number; index: number }> }).spots.map((s) => ({ ...s, url: `http://user/${s.index}`, marker: "" }));
        default:
          throw new Error(`모르는 op ${op}`);
      }
    },
    async close() {},
  };
  const warned: string[] = [];
  const driver = createJxaDriver({ host, warn: (l) => warned.push(l) });
  return { driver, calls, warned };
}

describe("closeOwned 가 못 찾은 우리 탭을 알린다", () => {
  test("탭을 다 훑고도 표시가 없으면 진짜로 닫힌 것 — 알리지 않는다", async () => {
    const { driver, warned } = setup(5);
    await driver.openTab("http://a/x");
    expect(await driver.closeOwned()).toBe(0);
    expect(warned).toEqual([]);
  });

  test("탭이 60개를 넘어 다 못 훑었으면 한 줄로 알리고, 훑기는 60개 · 탭당 0.5초 · 읽기 전용 op 만 쓴다", async () => {
    const { driver, calls, warned } = setup(150);
    await driver.openTab("http://a/x");
    expect(await driver.closeOwned()).toBe(0);
    expect(warned).toEqual(["우리 탭 1개를 못 찾았어요(이미 닫혔을 수 있어요)"]);
    const reads = calls.filter((c) => c.op === "readMarkers");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect((r.args.spots as unknown[]).length).toBeLessThanOrEqual(60);
      expect(r.args.timeoutMs).toBe(500);
    }
    expect(calls.some((c) => c.op === "stamp")).toBe(false); // 사용자 탭에 아무것도 적지 않는다
  });
});
