import { describe, expect, test, vi } from 'vitest';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { SafariError } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';

type Settle = { navigated: boolean; leaving: boolean };

/**
 * 사파리 없이 Page 의 이동 판단만 시험하는 가짜 드라이버.
 * answer 는 runJs 로 보낸 글에 답하고, settles 는 settleTab 이 차례로 돌려줄 답(다 쓰면 마지막 것을 되풀이)이다.
 */
function fake(answer: (source: string, n: number) => string, settles: Settle[] = [{ navigated: false, leaving: false }]) {
  const log = { runJs: [] as string[], settle: 0, rebind: 0 };
  const tab: TabInfo = { key: 't1', windowId: 1, index: 1, title: '', url: 'http://x/', isActive: false, owned: true };
  const d = {
    async runJs(_key: string, source: string) {
      log.runJs.push(source);
      return answer(source, log.runJs.length);
    },
    async settleTab() {
      const r = settles[Math.min(log.settle++, settles.length - 1)]!;
      return { ...r, tab };
    },
    async rebindTab() {
      log.rebind++;
      return tab;
    },
  } as unknown as SafariDriver;
  return { page: new Page(d, 't1'), log };
}
const ok = (r: object) => JSON.stringify({ ok: true, r });
const same: Settle = { navigated: false, leaving: false };
const moved: Settle = { navigated: true, leaving: false };
const leaving: Settle = { navigated: false, leaving: true };

describe('Page 의 이동 판단(settleTab 로 확인, runJs 로 확인하지 않는다)', () => {
  test('이동이 없으면 settleTab 을 한 번만 부르고 끝난다', async () => {
    const { page, log } = fake(() => ok({}), [same]);
    await page.locator('e1').click();
    expect(log.settle).toBe(1);
    expect(log.runJs).toHaveLength(1); // 동작 하나뿐 — 표시를 runJs 로 다시 읽지 않는다
    expect(log.rebind).toBe(0);
  });

  test('이동이 이미 끝나 있어도(새 문서) 에러 없이 끝난다', async () => {
    const { page, log } = fake(() => ok({}), [moved]);
    await page.locator('e1').click();
    expect(log.settle).toBe(1);
  });

  test('동작이 이동을 일으켰다고 하면(expectNav) 새 문서가 뜰 때까지 settleTab 을 거듭 부른다', async () => {
    const { page, log } = fake(() => ok({ expectNav: true }), [same, same, moved]);
    await page.locator('e1').click();
    expect(log.settle).toBe(3);
  });

  test('expectNav 인데 이동이 끝내 안 일어나면 잠깐만 기다리고 끝낸다', async () => {
    const { page, log } = fake(() => ok({ expectNav: true }), [same]);
    const t0 = Date.now();
    await page.locator('e1').click();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(log.settle).toBeGreaterThan(1);
  });

  test('문서를 떠나는 중이면 새 문서가 뜰 때까지 기다린다', async () => {
    const { page, log } = fake(() => ok({}), [leaving, leaving, moved]);
    await page.keyboard.press('Enter');
    expect(log.settle).toBe(3);
  });

  test('동작 중 짧은 타이머가 잡혔으면 그만큼 기다렸다가 확인한다(타이머 리다이렉트)', async () => {
    const { page, log } = fake(() => ok({ timerMs: 150 }), [moved]);
    const t0 = Date.now();
    await page.locator('e1').click();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(log.settle).toBe(1);
    const slow = fake(() => ok({ timerMs: 30000 }), [same]); // 긴 타이머는 기다리지 않는다
    const t1 = Date.now();
    await slow.page.locator('e1').click();
    expect(Date.now() - t1).toBeLessThan(500);
  });

  test('goto 는 새 문서가 뜰 때까지 기다리고, 해시만 바뀌면 한 번 확인하고 끝낸다', async () => {
    const a = fake((s) => (s.includes('readyState') ? 'complete' : ok({ expectNav: true })), [same, moved]);
    await a.page.goto('http://x/y');
    expect(a.log.settle).toBe(2);
    const b = fake((s) => (s.includes('readyState') ? 'complete' : ok({ expectNav: false })), [same]);
    await b.page.goto('http://x/#h');
    expect(b.log.settle).toBe(1);
  });

  test('evaluate: 읽기만 하면 한 번 확인, 주소를 바꾸는 식이면 이동을 기다린다', async () => {
    const a = fake(() => ok({ s: '"http://x/"' }), [same]);
    expect(await a.page.evaluate('location.href')).toBe('http://x/');
    expect(a.log.settle).toBe(1);
    const b = fake(() => ok({}), [same, moved]);
    await b.page.evaluate(() => { location.href = 'http://x/z'; });
    expect(b.log.settle).toBe(2);
  });

  test('evaluate 는 함수 소스와 인자를 스크립트에 끼워 보내고 eval 을 쓰지 않는다', async () => {
    const { page, log } = fake(() => ok({ s: '42' }), [same]);
    expect(await page.evaluate((n: number) => n * 2, 21)).toBe(42);
    const sent = log.runJs[0]!;
    expect(sent).toContain('"arg":21');
    expect(sent).toContain('n * 2'); // 소스가 그대로 들어 있다
    expect(sent).not.toMatch(/\beval\s*\(/); // 엄격한 CSP 에서 막히는 문자열 eval 이 없다
    expect(sent).not.toMatch(/new Function/);
  });

  test('evaluate 의 문법 오류는 보내기 전에 한국어로 알린다', async () => {
    const { page, log } = fake(() => ok({}));
    await expect(page.evaluate('var = ;')).rejects.toThrow(/문법/);
    expect(log.runJs).toHaveLength(0);
  });

  test('evaluate 가 약속을 돌려주면 끝날 때까지 읽고, 그 사이 이동하면 키를 지키며 알린다', async () => {
    let reads = 0;
    const a = fake((s) => (s.includes('__saPend[') && !s.includes('timerMs') ? JSON.stringify(reads++ < 1 ? { state: 'pending' } : { state: 'ok', s: '"끝"' }) : ok({ pending: 'tk' })), [same]);
    expect(await a.page.evaluate(async () => '끝')).toBe('끝');
    const b = fake((s) => (s.includes('timerMs') ? ok({ pending: 'tk' }) : JSON.stringify({ state: 'pending' })), [same, moved]);
    await expect(b.page.evaluate(async () => 1)).rejects.toThrow(/이동/);
  });

  test('페이지 안 오류는 한국어 문장 그대로 던지고 settleTab 은 부르지 않는다', async () => {
    const { page, log } = fake(() => JSON.stringify({ ok: false, err: 'e9 요소를 찾을 수 없음 — snapshot 을 다시 찍으세요' }));
    await expect(page.locator('e9').click()).rejects.toThrow(/e9.*snapshot/);
    expect(log.settle).toBe(0);
  });

  test('settleTab 이 TAB_CLOSED 를 올리면(탭이 정말 사라짐) 그대로 올린다', async () => {
    const d = {
      runJs: async () => ok({}),
      settleTab: async () => {
        throw new SafariError('TAB_CLOSED', '닫힘');
      },
    } as unknown as SafariDriver;
    await expect(new Page(d, 't1').locator('e1').click()).rejects.toMatchObject({ code: 'TAB_CLOSED' });
  });
});

describe('Page.screenshot 은 새 현재 탭이 그려진 뒤에 찍는다', () => {
  /** 호출 순서를 적는 가짜 드라이버. visibility 는 runJs("document.visibilityState") 가 차례로 돌려줄 값이다. */
  function shot(visibility: string[]) {
    const order: string[] = [];
    let n = 0;
    const d = {
      async showTab() {
        order.push('showTab');
      },
      async runJs(_key: string, source: string) {
        order.push(`runJs:${source}`);
        return visibility[Math.min(n++, visibility.length - 1)]!;
      },
      async captureWindow(id: number) {
        order.push(`capture:${id}`);
        return Buffer.from('png');
      },
    } as unknown as SafariDriver;
    const closed: number[] = [];
    const ai = { windowFor: async () => 7, closed: (id: number) => void closed.push(id), note: () => {} };
    return { page: new Page(d, 't1', ai), order, closed };
  }

  test('showTab → 보이는지 확인 → captureWindow 순서', async () => {
    const { page, order } = shot(['visible']);
    await page.screenshot();
    expect(order).toEqual(['showTab', 'runJs:document.visibilityState', 'capture:7']);
  });

  test('아직 hidden 이면 visible 이 될 때까지 확인을 거듭한 뒤 찍는다', async () => {
    const { page, order } = shot(['hidden', 'hidden', 'visible']);
    await page.screenshot();
    expect(order.filter((o) => o.startsWith('runJs'))).toHaveLength(3);
    expect(order.at(-1)).toBe('capture:7');
  });

  test('끝내 hidden 이어도 약 1초 뒤에는 막지 않고 찍는다', async () => {
    vi.useFakeTimers();
    try {
      const { page, order } = shot(['hidden']);
      const p = page.screenshot();
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(order.at(-1)).toBe('capture:7');
      const polls = order.filter((o) => o.startsWith('runJs')).length;
      expect(polls).toBeGreaterThanOrEqual(5);
      expect(polls).toBeLessThanOrEqual(12);
    } finally {
      vi.useRealTimers();
    }
  });

  test('보이는지 읽다가 오류가 나도 막지 않고 찍는다', async () => {
    const { page, order } = shot(['visible']);
    (page as unknown as { driver: SafariDriver }).driver.runJs = async () => {
      throw new SafariError('TAB_CLOSED', '탭 없음');
    };
    await page.screenshot();
    expect(order.at(-1)).toBe('capture:7');
  });

  test('창이 닫혔다는 오류에는 그 창 번호로 closed(id) 를 부른다', async () => {
    const { page, closed } = shot(['visible']);
    (page as unknown as { driver: SafariDriver }).driver.captureWindow = async () => {
      throw new SafariError('WINDOW_CLOSED', '창 닫힘');
    };
    await expect(page.screenshot()).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
    expect(closed).toEqual([7]);
  });
});
