import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import type { SafariDriver } from "../../src/driver/types.js";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { toKorean } from "../../src/errors-ko.js";
import { describeIt, fixture, frontApp, startFixtures, stopFixtures } from "../helpers/it.js";

// 첫 시험은 호스트를 띄우고 사파리를 깨우느라 느리다. 창 열기 · 크기 맞추기도 몇 초 걸린다.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// 이 파일이 연 창 · 탭에만 붙는 꼬리표. 시험은 세션이 연 것(dispose 가 닫는다)만 닫는다.
const RUN = `it=ai-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;

const PNG_SIGNATURE = "89504e470d0a1a0a";

describeIt("AI 전용 창(REPL: openAiWindow · setViewportSize · screenshot · display)", () => {
  let d: SafariDriver;
  let s: ReplSession;
  let userWindowIds: number[] = [];
  let front0 = "";

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
    userWindowIds = (await d.listWindows()).map((w) => w.id).sort((a, b) => a - b);
    front0 = frontApp();
  });
  beforeEach(() => {
    s = createReplSession(d);
  });
  afterEach(async () => {
    await s.dispose(); // 세션이 연 AI 창과 탭을 닫는다
  });
  afterAll(async () => {
    try {
      await d.closeOwned();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  const windowIds = async () => (await d.listWindows()).map((w) => w.id).sort((a, b) => a - b);

  test("openAiWindow(…, 390×844) 뒤 innerWidth 가 390 이고, 끝나면 그 창이 사라지며 사용자 창 · 앞 앱은 그대로", async () => {
    const r = await s.run(
      `const ai = await openAiWindow(${JSON.stringify(mine("basic.html"))}, {width: 390, height: 844});
       console.log(await ai.evaluate(() => innerWidth))`,
    );
    expect(r.error).toBeUndefined();
    // 높이는 화면(보이는 영역)에 막혀 844 보다 작을 수 있다 — 폭만 본다.
    expect(r.output).toBe("390");
    expect(r.output).not.toContain("주의");
    expect(frontApp()).toBe(front0);

    const during = await d.listWindows();
    const mineWin = during.filter((w) => w.owned);
    expect(mineWin).toHaveLength(1);
    expect(during.filter((w) => !w.owned).map((w) => w.id).sort((a, b) => a - b)).toEqual(userWindowIds);

    await s.dispose();
    expect(await windowIds()).toEqual(userWindowIds); // AI 창은 목록에서 사라졌다
    expect(frontApp()).toBe(front0);
  });

  test("두 번째 openAiWindow 는 같은 창의 새 탭이고, screenshot 은 그 탭을 현재 탭으로 만든 뒤 찍는다(권한 없으면 안내)", async () => {
    const r = await s.run(
      `const a1 = await openAiWindow(${JSON.stringify(mine("basic.html"))}, {width: 390, height: 844});
       const a2 = await openAiWindow(${JSON.stringify(mine("basic.html"))});
       console.log(a1.key, a2.key, tabs.length)`,
    );
    expect(r.error).toBeUndefined();
    const [k1, k2] = r.output.split(" ");
    const aiWindows = (await d.listWindows()).filter((w) => w.owned);
    expect(aiWindows).toHaveLength(1);
    expect(aiWindows[0]!.tabCount).toBe(2);
    expect((await d.listTabs()).find((t) => t.key === k1)!.isActive).toBe(true); // 새 탭은 뒤쪽 탭이다

    // 첫 탭을 찍는다 — 찍기 전에 그 탭이 현재 탭이 된다.
    const shot = await s.run(`display(await tabs[0].screenshot()); console.log("찍음")`);
    expect((await d.listTabs()).find((t) => t.key === k1)!.isActive).toBe(true);
    expect((await d.listTabs()).find((t) => t.key === k2)!.isActive).toBe(false);
    // 둘째 탭 쪽으로 옮겨 찍으면 현재 탭이 바뀐다.
    const shot2 = await s.run(`await tabs[1].screenshot()`);
    expect((await d.listTabs()).find((t) => t.key === k2)!.isActive).toBe(true);

    if (await d.screenCaptureAllowed()) {
      expect(shot.error).toBeUndefined();
      expect(shot.images).toHaveLength(1);
      const png = Buffer.from(shot.images![0]!, "base64");
      expect(png.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
      expect(shot2.error).toBeUndefined();
    } else {
      expect(shot.errorCode).toBe("SCREEN_CAPTURE_DENIED");
      expect(shot2.errorCode).toBe("SCREEN_CAPTURE_DENIED");
      expect(toKorean(shot.error, shot.errorCode)).toContain("화면 찍기 권한이 없어요");
    }
    expect(frontApp()).toBe(front0);
  });

  test("setViewportSize 는 실제 크기를 돌려주고, 최소 폭보다 좁게 요청하면 안내가 나온다", async () => {
    const r = await s.run(
      `const ai = await openAiWindow(${JSON.stringify(mine("basic.html"))});
       const a = await ai.setViewportSize({width: 600, height: 500});
       const b = await ai.setViewportSize({width: 200, height: 500});
       console.log(JSON.stringify(a), JSON.stringify(b), await ai.evaluate(() => innerWidth))`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output).toContain('{"width":600,"height":500}');
    expect(r.output).toContain("사파리 창은 약 336px 보다 좁게 못 줄여요");
    const actual = Number(r.output.split(" ").pop());
    expect(actual).toBeGreaterThan(200);
    expect(r.output).toContain(`지금 ${actual} px`);
  });

  test("뒤쪽 탭(사용자 창)의 page 에서 screenshot · setViewportSize 는 안내 오류이고 사용자 창은 안 건드린다", async () => {
    const r = await s.run(`const bg = await openTab(${JSON.stringify(mine("basic.html"))}); await bg.screenshot()`);
    expect(r.error).toContain("AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요");
    const r2 = await s.run(`await page.setViewportSize({width: 390, height: 800})`);
    expect(r2.error).toContain("화면 크기 바꾸기는 AI 전용 창에서만 돼요");
    expect((await d.listWindows()).filter((w) => w.owned)).toHaveLength(0);
    await s.dispose();
    expect(await windowIds()).toEqual(userWindowIds);
  });

  test("AI 창이 닫히면 WINDOW_CLOSED, 다시 openAiWindow 하면 새 창", async () => {
    await s.run(`await openAiWindow(${JSON.stringify(mine("basic.html"))})`);
    const first = (await d.listWindows()).find((w) => w.owned)!;
    await d.closeWindow(first.id); // 사용자가 창을 닫은 것과 같다
    const r = await s.run(`await page.setViewportSize({width: 390, height: 800})`);
    expect(r.errorCode).toBe("WINDOW_CLOSED");
    expect(toKorean(r.error, r.errorCode)).toContain("AI 전용 창이 닫혔어요");
    const r2 = await s.run(`const again = await openAiWindow(${JSON.stringify(mine("basic.html"))}, {width: 390, height: 800}); console.log(await again.evaluate(() => innerWidth))`);
    expect(r2.error).toBeUndefined();
    expect(r2.output).toBe("390");
    const second = (await d.listWindows()).filter((w) => w.owned);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first.id);
  });

  test("useAiWindow: 다른 드라이버가 연 창(우리 창이 아님)을 AI 창으로 고르면 크기 · 탭이 되고, 끝나도 창은 남고 우리 탭만 닫힌다", async () => {
    // 이 시험이 따로 연 창을 「사용자가 열어 둔 창」으로 쓴다(진짜 사용자 창은 고르지 않는다). 두 번째 드라이버가 열었으므로 d 에게는 우리 창이 아니다.
    const other = createJxaDriver();
    let otherId: number | undefined;
    try {
      const w = await other.openWindow(mine("basic.html"), { width: 700, height: 500 });
      otherId = w.windowId;
      expect((await d.listWindows()).find((x) => x.id === otherId)?.owned).toBe(false);

      const r = await s.run(
        `await useAiWindow(${otherId});
         const ai = await openAiWindow(${JSON.stringify(mine("basic.html"))});
         const v = await ai.setViewportSize({width: 600, height: 400});
         const ws = await listWindows();
         console.log(JSON.stringify(v), JSON.stringify(ws.filter((x) => x.isAiWindow).map((x) => [x.id, x.tabCount])))`,
      );
      expect(r.error).toBeUndefined();
      expect(r.output).toContain('{"width":600,"height":400}');
      expect(r.output).toContain(`[[${otherId},2]]`);
      expect(await windowIds()).toEqual([...userWindowIds, otherId!].sort((a, b) => a - b)); // 새 창을 따로 열지 않았다
      // 고른 창의 탭을 앞에 보여 찍는다(권한이 있을 때만).
      if (await d.screenCaptureAllowed()) {
        const shot = await s.run(`display(await page.screenshot())`);
        expect(shot.error).toBeUndefined();
        expect(shot.images).toHaveLength(1);
      }

      await s.dispose();
      const left = (await d.listWindows()).find((x) => x.id === otherId);
      expect(left).toBeDefined(); // 고른 창은 닫히지 않았다
      expect(left!.tabCount).toBe(1); // 우리가 연 탭만 닫혔다(창이 처음 가졌던 탭 하나)
    } finally {
      if (otherId !== undefined) await other.closeWindow(otherId).catch(() => undefined);
      await other.close();
    }
    expect(await windowIds()).toEqual(userWindowIds);
  });
});
