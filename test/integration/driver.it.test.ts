import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import type { SafariDriver, TabInfo } from "../../src/driver/types.js";
import { describeIt, fixture, frontApp, startFixtures, stopFixtures } from "../helpers/it.js";

// 이 파일이 연 탭에만 붙는 꼬리표. 닫을 때는 키가 아니라 이 꼬리표로 다시 찾아 확인한 것만 닫는다
// (탭 키 `windowId:index` 는 다른 탭이 닫히면 밀리고, 사용자가 쓰는 사파리라 언제든 밀릴 수 있다).
const RUN = `it=${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

describeIt("사파리 드라이버(JXA)", () => {
  let d: SafariDriver;

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
  });

  // 사용자가 다른 탭을 닫으면 키가 밀린다. 쓰기 직전에 주소로 우리 탭의 지금 키를 다시 찾는다.
  async function keyNow(tab: TabInfo): Promise<string> {
    const found = (await d.listTabs()).find((t) => t.url === tab.url);
    if (!found) throw new Error(`열어 둔 탭이 사라짐: ${tab.url}`);
    return found.key;
  }

  // 우리 탭 하나를 닫는다. 닫기 직전에 다시 목록을 읽어, 그 주소의 탭이 지금 있는 자리(키)를 찾고
  // 꼬리표(RUN)가 든 탭일 때만 닫는다. 아니면(사용자가 탭을 옮기거나 닫음) 닫지 않고 건너뛴다.
  async function closeIfMine(url: string): Promise<void> {
    if (!url.includes(RUN)) return;
    const found = (await d.listTabs()).find((t) => t.url === url);
    if (found && isMine(found)) await d.closeTab(found.key);
  }

  async function closeMine(): Promise<void> {
    const urls = (await d.listTabs()).filter(isMine).map((t) => t.url);
    // 같은 창에서는 뒤 탭부터 닫아야 앞 번호가 밀리지 않는다(listTabs 순서의 거꾸로).
    for (const url of urls.reverse()) await closeIfMine(url);
  }

  afterEach(closeMine);
  afterAll(async () => {
    try {
      await closeMine();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  test('뒤쪽 탭을 열고 읽고 닫는다', async () => {
    const before = frontApp();
    const { tab } = await d.openTab(mine('basic.html'));
    expect(tab.owned).toBe(true);
    expect(tab.isActive).toBe(false); // 활성 탭은 그대로
    expect(await d.runJs(await keyNow(tab), 'document.title')).toBe('기본 시험 페이지');
    // 사파리가 새로 맨 앞이 되지 않았다(사용자가 시험 중 앱을 바꿔도 깨지지 않게 「새로 사파리가 됨」만 본다).
    if (before !== 'Safari') expect(frontApp()).not.toBe('Safari');
    // 키가 아직 우리 탭을 가리키는지 확인한 뒤에만 닫는다.
    const listed = (await d.listTabs()).find((t) => t.url === tab.url);
    expect(listed?.url).toContain(RUN);
    expect(listed?.owned).toBe(true);
    await closeIfMine(tab.url);
    expect((await d.listTabs()).filter(isMine)).toHaveLength(0);
  });

  test('runJs 평균이 80ms 아래', async () => {
    const { tab } = await d.openTab(mine('basic.html'));
    const key = await keyNow(tab);
    await d.runJs(key, '1+1'); // 호스트 띄우기를 평균에서 뺀다
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) expect(await d.runJs(key, '1+1')).toBe('2');
    const avg = (performance.now() - t0) / N;
    console.log(`runJs 평균 ${avg.toFixed(1)}ms (${N}회)`);
    expect(avg).toBeLessThan(80);
  });

  test('alert 가 떠도 다음 호출은 된다', async () => {
    const { tab: a } = await d.openTab(mine('alert.html'));
    const { tab: b } = await d.openTab(mine('basic.html'));
    const [ka, kb] = [await keyNow(a), await keyNow(b)];
    await expect(d.runJs(ka, "document.querySelector('#alert').click()", { timeoutMs: 3000 })).rejects.toMatchObject({
      code: 'ALERT_BLOCKED',
    });
    expect(await d.runJs(kb, '1+1')).toBe('2'); // 다른 탭에서 정상
  }, 30_000); // 호스트를 죽이고 다시 띄우느라 기본 5초를 넘는다

  test('한글이 그대로 오간다', async () => {
    const { tab } = await d.openTab(mine('basic.html'));
    expect(await d.runJs(await keyNow(tab), `'가나다 ' + '😀' + ' ' + document.title.length`)).toBe('가나다 😀 9');
  });

  test('닫힌 탭이면 TAB_CLOSED', async () => {
    const { tab } = await d.openTab(mine('basic.html'));
    const key = await keyNow(tab);
    await closeIfMine(tab.url);
    await expect(d.runJs(key, '1+1')).rejects.toMatchObject({ code: 'TAB_CLOSED' });
  });

  test('windowId 를 주면 그 창에 새 탭을 만든다(있던 탭을 돌려주지 않는다)', async () => {
    const { tab: a } = await d.openTab(mine('basic.html'));
    const winBefore = (await d.listWindows()).find((w) => w.id === a.windowId)!;
    const urlB = mine('basic.html');
    const { tab: b } = await d.openTab(urlB, { windowId: a.windowId });
    const winAfter = (await d.listWindows()).find((w) => w.id === a.windowId)!;
    expect(winAfter.tabCount).toBe(winBefore.tabCount + 1);
    expect(b.windowId).toBe(a.windowId);
    expect(b.url).toBe(urlB); // 주소가 같은 새 탭(a 도 사용자 탭도 아님)
    expect(b.url).not.toBe(a.url);
    expect(b.isActive).toBe(false);
    expect(await d.runJs(await keyNow(b), 'document.title')).toBe('기본 시험 페이지');
  });
});
