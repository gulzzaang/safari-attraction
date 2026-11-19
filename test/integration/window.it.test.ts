import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import type { SafariDriver } from "../../src/driver/types.js";
import { describeIt, fixture, frontApp, startFixtures, stopFixtures } from "../helpers/it.js";

// 이 파일이 연 창에만 붙는 꼬리표. 시험은 자기가 openWindow 로 연 창만 닫는다(사용자 창은 건드리지 않는다).
const RUN = `it=win-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;

describeIt("AI 창(열기 · 크기 · 닫기 · 찍기)", () => {
  let d: SafariDriver;
  let userWindowIds: number[] = [];
  const opened: number[] = [];

  async function open(url: string, o?: { width?: number; height?: number }) {
    const r = await d.openWindow(url, o);
    opened.push(r.windowId);
    return r;
  }

  async function closeMine(): Promise<void> {
    while (opened.length > 0) {
      const id = opened.pop()!;
      await d.closeWindow(id).catch((e) => {
        if (e?.code !== "WINDOW_CLOSED") throw e;
      });
    }
  }

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
    userWindowIds = (await d.listWindows()).map((w) => w.id);
  });
  afterEach(closeMine);
  afterAll(async () => {
    try {
      await closeMine();
      await d.closeOwned();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  test("openWindow 는 앞 앱을 바꾸지 않고 사파리 창 맨 뒤에 연다", async () => {
    const front = frontApp();
    const r = await open(mine("basic.html"));
    expect(r.frontAppChanged).toBe(false);
    expect(frontApp()).toBe(front);
    expect(r.tab.owned).toBe(true);
    expect(r.tab.windowId).toBe(r.windowId);
    const wins = await d.listWindows();
    const me = wins.find((w) => w.id === r.windowId)!;
    expect(me).toBeDefined();
    expect(me.owned).toBe(true);
    expect(me.visible).toBe(true);
    expect(me.tabCount).toBe(1);
    // 보이는 창들 가운데 맨 뒤다(안 보이는 창이 사이에 끼어 있어도 맞게 순서끼리 견준다).
    for (const w of wins) if (w.id !== me.id) expect(w.index).toBeLessThan(me.index);
    // 사용자 창은 우리 것이 아니다.
    for (const id of userWindowIds) {
      const w = wins.find((x) => x.id === id);
      if (w) expect(w.owned).toBe(false);
    }
  });

  test("390 폭으로 열면 페이지 innerWidth 가 390", async () => {
    const { tab } = await open(mine("basic.html"), { width: 390, height: 844 });
    expect(await d.runJs(tab.key, "innerWidth")).toBe("390");
  });

  test("setWindowSize 로 1280×700 이 되고 다시 390 이 된다", async () => {
    // 높이는 화면(보이는 영역 870pt 안팎)에 들어가야 하므로 800 이 아니라 700 으로 시험한다.
    const { tab, windowId } = await open(mine("basic.html"));
    const big = await d.setWindowSize(windowId, 1280, 700);
    expect(big).toEqual({ innerWidth: 1280, innerHeight: 700 });
    expect(await d.runJs(tab.key, "innerWidth + 'x' + innerHeight")).toBe("1280x700");
    const small = await d.setWindowSize(windowId, 390, 844);
    expect(small.innerWidth).toBe(390);
    expect(await d.runJs(tab.key, "innerWidth")).toBe("390");
  });

  test("화면보다 큰 높이는 오류가 아니라 실제 값을 돌려준다", async () => {
    const { tab, windowId } = await open(mine("basic.html"));
    const r = await d.setWindowSize(windowId, 1280, 5000);
    expect(r.innerWidth).toBe(1280);
    expect(r.innerHeight).toBeLessThan(5000);
    expect(await d.runJs(tab.key, "innerHeight")).toBe(String(r.innerHeight));
  });

  test("최소 폭보다 좁게 달라고 해도 오류가 아니라 실제 값을 돌려준다", async () => {
    const { windowId } = await open(mine("basic.html"));
    const r = await d.setWindowSize(windowId, 200, 600);
    expect(r.innerWidth).toBeGreaterThan(200);
    expect(r.innerWidth).toBeLessThan(500);
  });

  test("닫은 창은 listWindows 에서 바로 빠진다", async () => {
    const { windowId } = await open(mine("basic.html"));
    expect((await d.listWindows()).some((w) => w.id === windowId)).toBe(true);
    await d.closeWindow(windowId);
    opened.pop();
    expect((await d.listWindows()).some((w) => w.id === windowId)).toBe(false);
    await expect(d.closeWindow(windowId)).rejects.toMatchObject({ code: "SAFARI_ERROR" }); // 이제 기록에도 없다
  });

  test("사용자 창은 closeWindow · setWindowSize 로 건드리지 못한다", async () => {
    const before = await d.listWindows();
    const user = before.find((w) => userWindowIds.includes(w.id));
    if (!user) return; // 사용자 창이 없으면 건너뛴다(시험하려고 만들지 않는다)
    await expect(d.closeWindow(user.id)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    await expect(d.setWindowSize(user.id, 500, 500)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    const after = (await d.listWindows()).find((w) => w.id === user.id)!;
    expect(after).toBeDefined();
    expect(after.bounds).toEqual(user.bounds);
    expect(after.tabCount).toBe(user.tabCount);
  });

  test("closeOwned 는 우리 창을 닫고 사용자 창은 그대로 둔다", async () => {
    const userSnapshot = async () => (await d.listWindows()).filter((w) => userWindowIds.includes(w.id)).map((w) => [w.id, w.tabCount]);
    const before = await userSnapshot();
    await open(mine("basic.html"));
    await open(mine("basic.html"));
    expect(await d.closeOwned()).toBe(2);
    opened.length = 0;
    expect((await d.listWindows()).filter((w) => w.owned)).toHaveLength(0);
    expect(await userSnapshot()).toEqual(before);
    expect(await d.closeOwned()).toBe(0);
  });

  test("captureWindow: 화면 기록 권한이 없으면 SCREEN_CAPTURE_DENIED, 있으면 PNG", async () => {
    const { windowId } = await open(mine("basic.html"), { width: 390, height: 844 });
    if (await d.screenCaptureAllowed()) {
      const png = await d.captureWindow(windowId);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } else {
      await expect(d.captureWindow(windowId)).rejects.toMatchObject({ code: "SCREEN_CAPTURE_DENIED" });
    }
  });

  test("닫힌 창을 찍으려 하면 WINDOW_CLOSED", async () => {
    const { windowId } = await open(mine("basic.html"));
    await d.closeWindow(windowId);
    opened.pop();
    await expect(d.captureWindow(windowId)).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
  });
});
