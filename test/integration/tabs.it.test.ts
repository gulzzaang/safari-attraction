import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { describeIt, fixture, frontApp, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 이 꼬리표가 든 탭만 만지고 닫는다(사용자 탭은 건드리지 않는다).
const RUN = `it=tabs-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

/** 사파리를 직접 부린다(드라이버를 거치지 않고 「사용자가 한 일」을 흉내 낼 때). */
function jxa(body: string): string {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', body], { encoding: 'utf8' }).trim();
}

/** 창 맨 앞에 탭을 하나 끼워 넣는다 — 그 창의 다른 탭들은 순서가 하나씩 밀린다(사용자가 탭을 옮기는 것과 같은 효과). */
function insertAtFront(windowId: number, url: string): void {
  jxa(`const S = Application("Safari"); const w = S.windows.byId(${windowId});
       w.tabs.unshift(S.Tab({ url: ${JSON.stringify(url)} })); delay(0.5); "ok"`);
}

/** 이 파일의 꼬리표가 든 주소의 탭만 사파리에서 직접 닫는다(사용자가 탭을 닫는 것과 같은 효과). */
function closeDirectly(url: string): void {
  if (!url.includes(RUN)) throw new Error('꼬리표 없는 주소는 닫지 않는다');
  jxa(`const S = Application("Safari"); let n = 0;
       S.windows().forEach((w) => { const urls = w.tabs.url();
         for (let i = urls.length - 1; i >= 0; i--) if (String(urls[i]) === ${JSON.stringify(url)}) { w.tabs[i].close(); n++; } });
       String(n)`);
}

// 「창이 없을 때」 시험은 사파리에 창이 하나도 없을 때만 돈다(시험하려고 사용자 창을 닫지 않는다).
const safariWindowCount = process.env.SAFARI_IT
  ? Number(
      jxa(`const S = Application("Safari");
           S.running() ? String(S.windows().filter((w) => { try { return w.tabs.length > 0; } catch (e) { return false; } }).length) : "0"`),
    )
  : -1;

describeIt('탭 키 · 우리 탭 정리', () => {
  let d: SafariDriver;

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
  });

  async function closeIfMine(url: string): Promise<void> {
    if (!url.includes(RUN)) return;
    const found = (await d.listTabs()).find((t) => t.url === url);
    if (found && isMine(found)) await d.closeTab(found.key);
  }

  async function closeMine(): Promise<void> {
    const urls = (await d.listTabs()).filter(isMine).map((t) => t.url);
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

  test('사용자가 탭을 옮겨도 같은 탭을 찾는다', async () => {
    const front = frontApp();
    const { tab } = await d.openTab(mine('basic.html'));
    expect(tab.key).toMatch(/^t\d+$/);
    expect(await d.runJs(tab.key, 'document.title')).toBe('기본 시험 페이지');
    // 사파리가 새로 맨 앞이 되지 않았다(시험 중 사용자가 앱을 바꿔도 깨지지 않게 「새로 사파리가 됨」만 본다).
    if (front !== 'Safari') expect(frontApp()).not.toBe('Safari');
    const indexBefore = (await d.listTabs()).find((t) => t.url === tab.url)!.index;

    insertAtFront(tab.windowId, mine('basic.html')); // 우리 탭의 순서가 하나 밀린다
    const listed = (await d.listTabs()).find((t) => t.url === tab.url)!;
    expect(listed.index).toBe(indexBefore + 1); // 정말 자리가 바뀌었다
    expect(listed.key).toBe(tab.key); // 그래도 같은 키
    expect(listed.owned).toBe(true);
    expect(await d.runJs(tab.key, 'document.title')).toBe('기본 시험 페이지');
    // 방금 끼워 넣은 탭(키가 다른 탭)은 건드리지 않았다.
    const filler = (await d.listTabs()).filter(isMine).find((t) => t.key !== tab.key)!;
    expect(filler.owned).toBe(false);
  });

  test('닫힌 탭은 TAB_CLOSED, 다른 탭은 안 건드림', async () => {
    const { tab: a } = await d.openTab(mine('basic.html'));
    const { tab: b } = await d.openTab(mine('basic.html'));
    closeDirectly(a.url); // 사용자가 닫음 — b 의 순서도 하나 당겨진다
    await expect(d.runJs(a.key, 'document.title')).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(await d.runJs(b.key, 'document.title')).toBe('기본 시험 페이지');
    expect((await d.listTabs()).filter((t) => t.url === a.url)).toHaveLength(0);
    await expect(d.closeTab(a.key)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(await d.closeOwned()).toBe(1); // 닫힌 a 는 우리 탭 목록에서 빠졌다
  });

  test('제자리에서 이동해도 rebindTab 으로 같은 키를 유지한다', async () => {
    const { tab } = await d.openTab(mine('basic.html'));
    const target = mine('alert.html');
    await d.runJs(tab.key, `location.href = ${JSON.stringify(target)}`).catch(() => undefined);
    const rebound = await d.rebindTab(tab.key); // 새 문서가 뜨고 표시가 사라진 탭에 같은 키를 다시 붙인다
    expect(rebound.key).toBe(tab.key);
    expect(rebound.url).toBe(target);
    expect(rebound.owned).toBe(true);
    expect(await d.runJs(tab.key, 'document.title')).toBe('경고창 시험 페이지');
    const listed = (await d.listTabs()).find((t) => t.url === target)!;
    expect(listed.key).toBe(tab.key);
    expect(await d.closeOwned()).toBe(1);
  });

  test.skipIf(safariWindowCount !== 0)('창이 없으면 새 창에 연다', async () => {
    const { tab } = await d.openTab(mine('basic.html'));
    expect((await d.listWindows()).length).toBe(1);
    expect(await d.runJs(tab.key, 'document.title')).toBe('기본 시험 페이지');
  });

  test('closeOwned 는 우리 탭만 닫는다', async () => {
    const userTabs = async () => (await d.listTabs()).filter((t) => !isMine(t)).map((t) => t.url);
    const before = await userTabs();
    await d.openTab(mine('basic.html'));
    await d.openTab(mine('alert.html'));
    expect((await d.listTabs()).filter((t) => isMine(t) && t.owned)).toHaveLength(2);
    expect(await d.closeOwned()).toBe(2);
    expect((await d.listTabs()).filter(isMine)).toHaveLength(0);
    expect(await userTabs()).toEqual(before); // 사용자 탭 수 · 주소가 전후 같다
    expect(await d.closeOwned()).toBe(0);
  });
});
