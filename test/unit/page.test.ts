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
  function shot(visibility: string[], loads: string[] = ['complete|1']) {
    const order: string[] = [];
    let n = 0;
    let l = 0;
    const d = {
      async showTab() {
        order.push('showTab');
      },
      async runJs(_key: string, source: string) {
        order.push(`runJs:${source}`);
        if (source.includes('readyState')) return loads[Math.min(l++, loads.length - 1)]!;
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
    expect(order.filter((o) => o !== 'showTab' && !o.includes('readyState'))).toEqual(['runJs:document.visibilityState', 'capture:7']);
    expect(order[0]).toBe('showTab');
  });

  test('찍기 전에 load 를 잠깐 기다린다(interactive 면 complete 가 될 때까지), 읽지 못해도 막지 않는다', async () => {
    const { page, order } = shot(['visible'], ['interactive|1', 'complete|1']);
    await page.screenshot();
    expect(order.filter((o) => o.includes('readyState'))).toHaveLength(2);
    expect(order.at(-1)).toBe('capture:7');
  });

  test('아직 hidden 이면 visible 이 될 때까지 확인을 거듭한 뒤 찍는다', async () => {
    const { page, order } = shot(['hidden', 'hidden', 'visible']);
    await page.screenshot();
    expect(order.filter((o) => o === 'runJs:document.visibilityState')).toHaveLength(3);
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

describe('Page.url() 은 await 없이 마지막으로 알려진 주소를 돌려준다', () => {
  /** 드라이버가 알려 주는 주소(lastUrl)를 시험이 바꾼다. 동작 글에 next.html 이 들어 있으면 이동한 것으로 친다(레지스트리가 settleTab 에서 주소를 새로 하듯). */
  function nav() {
    const st = { url: 'http://x/form.html' };
    const d = {
      lastUrl: () => st.url,
      async runJs(_key: string, source: string) {
        if (source.includes('readyState')) return 'complete';
        if (source.includes('next.html')) return ok({ expectNav: true });
        return ok({});
      },
      async settleTab() {
        const moved = !st.url.endsWith('next.html');
        if (moved) st.url = 'http://x/next.html';
        return { navigated: moved, leaving: false, tab: { key: 't1', windowId: 1, index: 1, title: '', url: st.url, isActive: false, owned: true } as TabInfo };
      },
    } as unknown as SafariDriver;
    return { page: new Page(d, 't1'), st };
  }

  test('await 없이 부르면 글(string)이 바로 나온다 — Promise 가 아니다', () => {
    const { page } = nav();
    const u = page.url();
    expect(typeof u).toBe('string');
    expect(u).toBe('http://x/form.html');
    expect(String(u)).not.toContain('[object Promise]');
  });

  test('goto 로 이동하면 새 주소로 바뀐다', async () => {
    const { page } = nav();
    expect(page.url()).toBe('http://x/form.html');
    await page.goto('http://x/next.html');
    expect(page.url()).toBe('http://x/next.html');
  });

  test('클릭이 이동을 일으켜 settleTab 이 새 문서를 알리면 새 주소로 바뀐다', async () => {
    const { page, st } = nav();
    st.url = 'http://x/start.html';
    // 클릭이 next.html 로 가는 동작: 동작 글에 next.html 이 들어 있도록 ref 대신 선택자에 담는다
    await page.locator('a[href="next.html"]').click();
    expect(page.url()).toBe('http://x/next.html');
  });

  test('await 해도 같은 값이다(예전 코드 호환)', async () => {
    const { page } = nav();
    expect(await page.url()).toBe('http://x/form.html');
  });

  test('탭이 닫혀 드라이버가 모르게 되면 마지막으로 알던 주소가 남는다', () => {
    const st: { url: string | undefined } = { url: 'http://x/a' };
    const page = new Page({ lastUrl: () => st.url } as unknown as SafariDriver, 't1');
    expect(page.url()).toBe('http://x/a');
    st.url = undefined;
    expect(page.url()).toBe('http://x/a');
  });
});

describe('Page: 이동 신호가 없을 때 settleTab 을 건너뛰는 동작(fill · hover · focus · scroll 만)', () => {
  type Detail = { value: string; url?: string; urlBefore: string; leaving?: boolean; owned: boolean };
  /** runJsDetailed 가 있는 가짜 드라이버. detail 은 동작 결과(글)에 붙여 돌려줄 주소 · 깃발. */
  function fakeDetailed(r: object, detail: Partial<Detail> = {}) {
    const log = { settle: 0, detailed: 0, plain: 0 };
    const tab: TabInfo = { key: 't1', windowId: 1, index: 1, title: '', url: 'http://x/', isActive: false, owned: true };
    const d = {
      async runJs() {
        log.plain++;
        return ok(r);
      },
      async runJsDetailed() {
        log.detailed++;
        return { value: ok(r), url: 'http://x/', urlBefore: 'http://x/', leaving: false, owned: true, ...detail };
      },
      async settleTab() {
        log.settle++;
        return { navigated: false, leaving: false, tab };
      },
    } as unknown as SafariDriver;
    return { page: new Page(d, 't1'), log };
  }

  test('fill: 신호가 없으면 settleTab 을 부르지 않는다', async () => {
    const { page, log } = fakeDetailed({});
    await page.locator('e1').fill('값');
    expect(log).toEqual({ settle: 0, detailed: 1, plain: 0 });
  });
  test.each([
    ['hover', (p: Page) => p.locator('e1').hover()],
    ['focus', (p: Page) => p.locator('e1').focus()],
    ['scroll', (p: Page) => p.locator('e1').scrollIntoViewIfNeeded()],
  ])('%s 도 신호가 없으면 건너뛴다', async (_n, run) => {
    const { page, log } = fakeDetailed({});
    await run(page);
    expect(log.settle).toBe(0);
  });
  test('해시만 바뀐 주소는 같은 문서 안 이동이라 건너뛴다', async () => {
    const { page, log } = fakeDetailed({}, { url: 'http://x/#a' });
    await page.locator('e1').fill('값');
    expect(log.settle).toBe(0);
  });
  test('주소가 해시 밖에서 바뀌었으면(pushState 등) 확인한다', async () => {
    const { page, log } = fakeDetailed({}, { url: 'http://x/other' });
    await page.locator('e1').fill('값');
    expect(log.settle).toBe(1);
  });
  test('깃발이 서 있거나(양의 신호) 주소를 모르면 확인한다. 깃발 모름(느린 길)은 신호가 아니다 — 깃발이 없다는 말은 아무 뜻이 없으니 건너뛴다', async () => {
    for (const detail of [{ leaving: true }, { url: undefined }]) {
      const { page, log } = fakeDetailed({}, detail);
      await page.locator('e1').fill('값');
      expect(log.settle).toBe(1);
    }
    const { page, log } = fakeDetailed({}, { leaving: undefined });
    await page.locator('e1').fill('값');
    expect(log.settle).toBe(0);
  });
  test('[I2] 붙인 사용자 탭(owned 아님)은 신호가 없어도 fill · hover · focus · scroll 뒤에 늘 확인한다', async () => {
    for (const run of [
      (p: Page) => p.locator('e1').fill('값'),
      (p: Page) => p.locator('e1').hover(),
      (p: Page) => p.locator('e1').focus(),
      (p: Page) => p.locator('e1').scrollIntoViewIfNeeded(),
    ]) {
      const { page, log } = fakeDetailed({}, { owned: false });
      await run(page);
      expect(log.settle).toBe(1);
    }
  });
  test('[I2] 우리가 연 탭의 fill 은 신호가 없으면 건너뛴다', async () => {
    const { page, log } = fakeDetailed({}, { owned: true });
    await page.locator('e1').fill('값');
    expect(log.settle).toBe(0);
  });
  test('동작이 expectNav 를 알리거나 짧은 타이머를 잡았으면 확인한다', async () => {
    const a = fakeDetailed({ expectNav: true });
    await a.page.locator('e1').fill('값');
    expect(a.log.settle).toBeGreaterThan(0);
    const b = fakeDetailed({ timerMs: 0 });
    await b.page.locator('e1').fill('값');
    expect(b.log.settle).toBe(1);
    const c = fakeDetailed({ timerMs: 5000 }); // 긴 타이머는 예전에도 기다리지 않고 한 번만 확인했다 — 건너뛴다
    await c.page.locator('e1').fill('값');
    expect(c.log.settle).toBe(0);
  });
  test('click · press · type · select · check · evaluate 는 신호가 없어도 늘 확인한다(runJsDetailed 도 안 쓴다)', async () => {
    const runs: Array<(p: Page) => Promise<unknown>> = [
      (p) => p.locator('e1').click(),
      (p) => p.keyboard.press('Enter'),
      (p) => p.keyboard.type('a'),
      (p) => p.locator('e1').selectOption('x'),
      (p) => p.locator('e1').check(),
    ];
    for (const run of runs) {
      const { page, log } = fakeDetailed({});
      await run(page);
      expect(log.settle).toBe(1);
      expect(log.detailed).toBe(0);
    }
    // evaluate: 결과를 받고(오류를 삼키지 않는다) 늘 settleTab 을 한 번 한다 — runJsDetailed 는 쓰지 않는다
    const e = fakeDetailed({ s: '2', timerMs: -1 });
    expect(await e.page.evaluate(() => 1 + 1)).toBe(2);
    expect(e.log).toEqual({ settle: 1, detailed: 0, plain: 1 });
  });
  test('runJsDetailed 가 없는 드라이버는 늘 확인한다', async () => {
    const { page, log } = fake(() => ok({}), [same]);
    await page.locator('e1').fill('값');
    expect(log.settle).toBe(1);
  });
});
