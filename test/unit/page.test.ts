import { describe, expect, test } from 'vitest';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { SafariError } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';

/** 사파리 없이 Page 의 이동 판단만 시험하는 가짜 드라이버. script 는 보낸 글을 보고 답을 정한다. */
function fake(answer: (source: string, n: number) => string) {
  const log = { runJs: [] as string[], rebind: 0 };
  const tab: TabInfo = { key: 't1', windowId: 1, index: 1, title: '', url: 'http://x/', isActive: false, owned: true };
  const d = {
    async runJs(_key: string, source: string) {
      log.runJs.push(source);
      return answer(source, log.runJs.length);
    },
    async rebindTab() {
      log.rebind++;
      return tab;
    },
  } as unknown as SafariDriver;
  return { page: new Page(d, 't1'), log };
}
const ok = (r: object) => JSON.stringify({ ok: true, r });
const isCheck = (s: string) => s.includes('window.__saTok===');
const state = (tok: boolean, leaving = false) => JSON.stringify({ tok, leaving });

describe('Page 의 이동 판단', () => {
  test('이동이 없으면 rebindTab 을 부르지 않는다', async () => {
    const { page, log } = fake((s) => (isCheck(s) ? state(true) : ok({})));
    await page.locator('e1').click();
    expect(log.rebind).toBe(0);
    expect(log.runJs).toHaveLength(2); // 동작 + 표시 확인
  });

  test('동작이 이동을 일으켰다고 하면 rebindTab 한다', async () => {
    const { page, log } = fake((s) => (isCheck(s) ? state(false) : ok({ expectNav: true })));
    await page.locator('e1').click();
    expect(log.rebind).toBe(1);
  });

  test('표시를 확인했더니 떠나는 중이면 rebindTab 한다', async () => {
    let checks = 0;
    const { page, log } = fake((s) => {
      if (!isCheck(s)) return ok({});
      return checks++ === 0 ? state(true, true) : state(false);
    });
    await page.keyboard.press('Enter');
    expect(log.rebind).toBe(1);
  });

  test('이동이 느리면(아직 옛 문서) 다시 기다린다', async () => {
    let checks = 0;
    const { page, log } = fake((s) => {
      if (!isCheck(s)) return ok({ expectNav: true });
      return checks++ < 2 ? state(true, true) : state(false);
    });
    await page.locator('e1').click();
    expect(log.rebind).toBe(3);
  });

  test('이동이 일어나지 않은 expectNav 는 한 번만 기다린다', async () => {
    const { page, log } = fake((s) => (isCheck(s) ? state(true, false) : ok({ expectNav: true })));
    await page.locator('e1').click();
    expect(log.rebind).toBe(1);
  });

  test('goto 는 항상 rebind 하고, 해시만 바뀌면 안 한다', async () => {
    const a = fake((s) => (s.includes('readyState') ? 'complete' : isCheck(s) ? state(false) : ok({ expectNav: true })));
    await a.page.goto('http://x/y');
    expect(a.log.rebind).toBe(1);
    const b = fake((s) => (s.includes('readyState') ? 'complete' : isCheck(s) ? state(true) : ok({ expectNav: false })));
    await b.page.goto('http://x/#h');
    expect(b.log.rebind).toBe(0);
  });

  test('evaluate: 읽기만 하면 rebind 없음, 주소를 바꾸는 식이면 rebind', async () => {
    const a = fake((s) => (isCheck(s) ? state(true) : ok({ s: '"http://x/"' })));
    expect(await a.page.evaluate('location.href')).toBe('http://x/');
    expect(a.log.rebind).toBe(0);
    const b = fake((s) => (isCheck(s) ? state(false) : ok({})));
    await b.page.evaluate(() => { location.href = 'http://x/z'; });
    expect(b.log.rebind).toBe(1);
  });

  test('evaluate 는 함수 소스와 인자를 JSON 으로 보낸다', async () => {
    const { page, log } = fake((s) => (isCheck(s) ? state(true) : ok({ s: '42' })));
    expect(await page.evaluate((n: number) => n * 2, 21)).toBe(42);
    const sent = log.runJs[0]!;
    expect(sent).toContain('"arg":21');
    expect(sent).toContain('n * 2');
  });

  test('페이지 안 오류는 한국어 문장 그대로 던진다', async () => {
    const { page } = fake(() => JSON.stringify({ ok: false, err: 'e9 요소를 찾을 수 없음 — snapshot 을 다시 찍으세요' }));
    await expect(page.locator('e9').click()).rejects.toThrow(/e9.*snapshot/);
  });

  test('확인 중 탭 표시를 잃으면 이유를 설명하는 TAB_CLOSED', async () => {
    const { page } = fake((s) => {
      if (isCheck(s)) throw new SafariError('TAB_CLOSED', 'x');
      return ok({});
    });
    await expect(page.locator('e1').click()).rejects.toMatchObject({ code: 'TAB_CLOSED', message: expect.stringContaining('표시를 잃음') });
  });
});
