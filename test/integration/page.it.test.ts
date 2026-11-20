import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';
import { buildSnapshotSource } from '../../src/snapshot/inpage.js';
import { describeIt, fixture, frontApp, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 이 꼬리표가 든 탭만 만지고 닫는다(사용자 탭은 건드리지 않는다).
// 첫 시험은 호스트를 띄우고 사파리를 깨우느라 느리다.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const RUN = `it=page-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

describeIt('페이지 조작(Page)', () => {
  let d: SafariDriver;
  let front0 = '';

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
    front0 = frontApp();
  });

  async function closeMine(): Promise<void> {
    // 이동하면 주소가 바뀌어도 꼬리표는 따라온다 — 목록을 다시 읽어 꼬리표가 든 탭만 하나씩 닫는다.
    for (let i = 0; i < 10; i++) {
      const found = (await d.listTabs()).find(isMine);
      if (!found) return;
      await d.closeTab(found.key);
    }
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

  const open = async (name: string) => {
    const { tab } = await d.openTab(mine(name));
    return new Page(d, tab.key);
  };
  const refOf = async (page: Page, pattern: RegExp) => {
    const snap = await d.runJs(page.key, buildSnapshotSource());
    const m = pattern.exec(snap);
    if (!m) throw new Error(`snapshot 에 없음: ${pattern}\n${snap}`);
    return m[1]!;
  };

  test('fill 은 프레임워크 입력칸에도 값이 들어간다', async () => {
    const page = await open('form.html');
    // 보통 대입은 프레임워크가 못 알아챈다(시험 페이지의 흉내가 제대로 작동하는지 먼저 확인).
    await page.evaluate(() => {
      (document.getElementById('name') as HTMLInputElement).value = '그냥 대입';
      document.getElementById('name')!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.locator('#preview').textContent()).toBe('미리보기: ');

    const ref = await refOf(page, /- textbox "이름을 입력" \[ref=(e\d+)\]/);
    await page.locator(ref).fill('홍길동');
    expect(await page.locator('#preview').textContent()).toBe('미리보기: 홍길동');
    expect(await page.evaluate(() => (document.getElementById('name') as HTMLInputElement).value)).toBe('홍길동');
    expect(page.url()).toContain('form.html'); // fill 은 이동시키지 않는다(rebind 없이 그대로)
  });

  test('엔터가 막힌 검색칸도 press(Enter) 로 제출된다', async () => {
    const page = await open('search.html');
    await page.locator('#searchInput').fill('에베레스트산');
    expect(await page.evaluate(() => document.querySelectorAll('#suggest li').length)).toBe(3); // 추천 목록이 떴다
    await page.keyboard.press('Enter');
    expect(decodeURIComponent(page.url())).toMatch(/result\.html\?q=에베레스트산(&|$)/);
    expect(await page.title()).toBe('결과: 에베레스트산');
    expect(await page.locator('#q').textContent()).toBe('에베레스트산');
  });

  test('click 뒤 이동하면 로딩을 기다리고 같은 키를 유지한다', async () => {
    const page = await open('form.html');
    const before = (await d.listTabs()).filter(isMine).length;
    await page.locator('#go').click();
    expect(await page.title()).toBe('결과: 링크로 왔다'); // 이동한 새 문서가 다 뜬 뒤다
    expect(await page.locator('#q').textContent()).toBe('링크로 왔다');
    const listed = (await d.listTabs()).filter(isMine);
    expect(listed).toHaveLength(before);
    expect(listed.find((t) => t.key === page.key)?.url).toContain('result.html'); // 같은 키가 이동한 탭을 가리킨다
  });

  test('핸들러가 기본 동작을 막고 타이머로 이동해도 같은 키가 이어지고 탭이 닫힌다', async () => {
    const page = await open('form.html');
    await page.locator('#later').click(); // 막힌 click → 150ms 뒤 location.href = … (동작 직후엔 이동이 안 보인다)
    expect(await page.title()).toBe('결과: 타이머로 왔다');
    expect((await d.listTabs()).find((t) => t.key === page.key)?.url).toContain('result.html');
    expect(await d.closeOwned()).toBe(1); // 키를 잃지 않았으니 우리 탭으로 닫힌다
    expect((await d.listTabs()).filter(isMine)).toHaveLength(0);
  });

  test('evaluate 안의 타이머 이동(식 안 location 대입)도 키가 이어진다', async () => {
    const page = await open('basic.html');
    const target = mine('result.html') + '&q=' + encodeURIComponent('식 안 타이머');
    await page.evaluate((u: string) => { setTimeout(() => { location.href = u; }, 100); }, target);
    expect(await page.title()).toBe('결과: 식 안 타이머');
  });

  test('엄격한 CSP 페이지에서도 evaluate 가 돈다', async () => {
    const page = await open('csp.html');
    expect(await page.evaluate((n: number) => n * 2, 21)).toBe(42);
    expect(await page.evaluate('document.title')).toBe('CSP 시험 페이지');
    expect(await page.evaluate(async () => 'ok')).toBe('ok');
    await page.locator('#b').click(); // 다른 동작도 문자열 eval 을 쓰지 않는다
  });

  test('click 이 이동을 안 시키면 느려지지 않는다(rebind 안 함)', async () => {
    const page = await open('form.html');
    const t0 = performance.now();
    await page.locator('#count').click();
    await page.locator('#count').click();
    const ms = performance.now() - t0;
    expect(await page.locator('#clicks').textContent()).toBe('2');
    console.log(`click 2번(이동 없음): ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(1500); // 이동 없는 동작마다 rebind(1.5초 이상)를 하면 이 시간을 넘는다
  });

  test('evaluate 가 함수와 인자를 받는다', async () => {
    const page = await open('basic.html');
    expect(await page.evaluate((n: number) => n * 2, 21)).toBe(42);
    expect(await page.evaluate('document.title')).toBe('기본 시험 페이지');
    expect(await page.evaluate(() => ({ a: [1, 2], b: '가' }))).toEqual({ a: [1, 2], b: '가' });
    expect(await page.evaluate(() => undefined)).toBeUndefined();
    expect(await page.evaluate(async (s: string) => { await new Promise((r) => setTimeout(r, 100)); return s + '!'; }, '끝')).toBe('끝!');
    await expect(page.evaluate(() => { throw new Error('터짐'); })).rejects.toThrow('터짐');
  });

  test('evaluate 로 주소를 바꿔도 키를 유지한다, goto 는 로딩까지 기다린다', async () => {
    const page = await open('basic.html');
    const target = mine('result.html') + '&q=' + encodeURIComponent('이동');
    await page.evaluate((u: string) => { location.href = u; }, target);
    expect(await page.title()).toBe('결과: 이동');
    await page.goto(mine('form.html'));
    expect(await page.title()).toBe('폼 시험 페이지');
    expect(page.url()).toContain('form.html');
    const cur = page.url();
    await page.goto(cur + '#아래'); // 해시만 바뀌는 이동은 새 문서가 아니다
    expect(decodeURIComponent(page.url())).toContain('#아래');
    expect(await page.title()).toBe('폼 시험 페이지');
  });

  test('keyboard.type 은 포커스된 칸에 글자를 넣는다', async () => {
    const page = await open('form.html');
    await page.locator('#name').click();
    await page.keyboard.type('abc');
    expect(await page.locator('#preview').textContent()).toBe('미리보기: abc');
    await page.keyboard.press('Backspace');
    expect(await page.locator('#preview').textContent()).toBe('미리보기: ab');
    await page.locator('#memo').fill('첫 줄');
    await page.keyboard.type('\n둘째');
    expect(await page.evaluate(() => (document.getElementById('memo') as HTMLTextAreaElement).value)).toBe('첫 줄\n둘째');
  });

  test('없는 ref 는 snapshot 을 다시 찍으라고 알린다', async () => {
    const page = await open('basic.html');
    await expect(page.locator('e9999').click()).rejects.toThrow(/e9999.*snapshot/);
    await expect(page.locator('#없는칸').fill('x')).rejects.toThrow(/#없는칸/);
  });

  test('사파리를 앞으로 가져오지 않는다', async () => {
    const page = await open('search.html');
    await page.locator('#searchInput').fill('앞');
    await page.keyboard.press('Enter');
    await page.waitForLoadState();
    if (front0 !== 'Safari') expect(frontApp()).not.toBe('Safari');
  });
});
