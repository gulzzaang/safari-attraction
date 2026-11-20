import { describe, expect, test } from 'vitest';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';
import { createReplSession } from '../../src/repl/context.js';
import { ACTION_OPS, buildActionSource } from '../../src/repl/inpage-actions.js';
import { describeChain, globToRegExp, parseSelector, type Step } from '../../src/repl/locator.js';
import { REPL_DESCRIPTION } from '../../src/server.js';
import { createFakeDriver } from '../helpers/fake-driver.js';

const tab: TabInfo = { key: 't1', windowId: 1, index: 1, title: '', url: 'http://x/', isActive: false, owned: true };

/** runJs 로 간 글을 모두 적는 가짜 드라이버. answer 가 글마다 답한다. */
function fake(answer: (source: string, n: number) => string, navigated = false) {
  const log = { runJs: [] as string[], settle: 0 };
  const d = {
    async runJs(_key: string, source: string) {
      log.runJs.push(source);
      return answer(source, log.runJs.length);
    },
    async settleTab() {
      log.settle++;
      return { navigated, leaving: false, tab };
    },
    lastUrl: () => tab.url,
  } as unknown as SafariDriver;
  return { page: new Page(d, 't1'), log };
}
const ok = (r: object = {}) => JSON.stringify({ ok: true, r });

/** 보낸 글에서 인자(JSON)로 끼운 chain 을 꺼낸다(글은 `…})(<인자 JSON>)` 로 끝난다). */
const chainOf = (source: string): Step[] => JSON.parse(source.slice(source.lastIndexOf('})(') + 3, -1)).chain;

describe('chain 만들기(직렬화)', () => {
  test('getByRole 은 역할 · 이름(글 또는 RegExp 의 source+flags) · exact 를 chain 으로 보낸다', async () => {
    const { page, log } = fake(() => ok());
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    expect(chainOf(log.runJs[0]!)).toEqual([{ k: 'role', role: 'button', name: { s: '보내기' }, exact: true }]);
    await page.getByRole('link', { name: /홈|home/i }).click();
    expect(chainOf(log.runJs[1]!)).toEqual([{ k: 'role', role: 'link', name: { re: '홈|home', fl: 'i' }, exact: false }]);
  });

  test('locator · nth · filter · 하위 locator · getBy… 는 단계가 이어진다', async () => {
    const { page, log } = fake(() => ok());
    await page.locator('ul').locator('li').filter({ hasText: '둘' }).last().click();
    expect(chainOf(log.runJs[0]!)).toEqual([
      { k: 'css', s: 'ul' },
      { k: 'sub', s: 'li' },
      { k: 'hasText', m: { s: '둘' } },
      { k: 'nth', i: -1 },
    ]);
    await page.getByText('안녕', { exact: true }).first().getByLabel('이름').click();
    expect(chainOf(log.runJs[1]!)).toEqual([
      { k: 'text', m: { s: '안녕' }, exact: true },
      { k: 'nth', i: 0 },
      { k: 'label', m: { s: '이름' }, exact: false },
    ]);
    await page.getByPlaceholder('검색').nth(2).click();
    expect(chainOf(log.runJs[2]!)).toEqual([{ k: 'placeholder', m: { s: '검색' }, exact: false }, { k: 'nth', i: 2 }]);
    await page.getByTestId('go').click();
    expect(chainOf(log.runJs[3]!)).toEqual([{ k: 'testid', m: { s: 'go' } }]);
  });

  test('ref(e12) 와 CSS 는 구분되고, text= 앞머리는 getByText 로 풀린다', () => {
    expect(parseSelector('e12')).toEqual({ k: 'ref', s: 'e12' });
    expect(parseSelector('#a > b')).toEqual({ k: 'css', s: '#a > b' });
    expect(parseSelector('text=로그인')).toEqual({ k: 'text', m: { s: '로그인' }, exact: false });
    expect(parseSelector('text="로그인"')).toEqual({ k: 'text', m: { s: '로그인' }, exact: true });
  });

  test('describeChain 은 Playwright 꼴 글을 만든다(오류 글에 쓴다)', () => {
    expect(describeChain([{ k: 'role', role: 'button', name: { s: '보내기' }, exact: false }])).toBe("getByRole('button', {name: '보내기'})");
    expect(describeChain([{ k: 'role', role: 'link', name: { re: 'a', fl: 'i' }, exact: true }])).toBe("getByRole('link', {name: /a/i, exact: true})");
    expect(describeChain([{ k: 'css', s: '#a' }, { k: 'sub', s: 'b' }, { k: 'nth', i: 0 }, { k: 'nth', i: -1 }, { k: 'nth', i: 3 }])).toBe("locator('#a').locator('b').first().last().nth(3)");
    expect(describeChain([{ k: 'text', m: { s: "it's" }, exact: false }, { k: 'hasText', m: { s: 'x' } }])).toBe("getByText('it\\'s').filter({hasText: 'x'})");
  });
});

describe('waitForURL 글 패턴', () => {
  const re = (g: string) => globToRegExp(g);
  test('* 는 / 를 뺀 아무 글, ** 는 / 까지 아무 글, ? 는 한 글자', () => {
    expect(re('http://x/a/*').test('http://x/a/b')).toBe(true);
    expect(re('http://x/a/*').test('http://x/a/b/c')).toBe(false);
    expect(re('http://x/a/**').test('http://x/a/b/c?d=1')).toBe(true);
    expect(re('**/result.html?q=*').test('http://127.0.0.1:1/result.html?q=가')).toBe(true);
    expect(re('http://x/?').test('http://x/a')).toBe(true);
    expect(re('http://x/a.html').test('http://x/aXhtml')).toBe(false); // . 은 글자 그대로
    expect(re('http://x/{a,b}/c').test('http://x/b/c')).toBe(true);
  });
  test('처음부터 끝까지 맞아야 한다', () => {
    expect(re('http://x/a').test('http://x/a/b')).toBe(false);
    expect(re('http://x/a').test('zhttp://x/a')).toBe(false);
  });
});

describe('Page · Locator 메서드는 있고, 동작 하나는 runJs 한 번', () => {
  const sel = (p: Page) => p.locator('#a');
  // [이름, 부르기, 돌려줄 r]
  const actions: Array<[string, (p: Page) => Promise<unknown>, object]> = [
    ['locator.click', (p) => sel(p).click(), {}],
    ['locator.fill', (p) => sel(p).fill('v'), {}],
    ['locator.textContent', (p) => sel(p).textContent(), { text: 'x' }],
    ['locator.innerText', (p) => sel(p).innerText(), { v: 'x' }],
    ['locator.inputValue', (p) => sel(p).inputValue(), { v: 'x' }],
    ['locator.getAttribute', (p) => sel(p).getAttribute('href'), { v: 'x' }],
    ['locator.isVisible', (p) => sel(p).isVisible(), { v: true }],
    ['locator.isChecked', (p) => sel(p).isChecked(), { v: true }],
    ['locator.isEnabled', (p) => sel(p).isEnabled(), { v: true }],
    ['locator.count', (p) => sel(p).count(), { v: 2 }],
    ['locator.check', (p) => sel(p).check(), {}],
    ['locator.uncheck', (p) => sel(p).uncheck(), {}],
    ['locator.selectOption', (p) => sel(p).selectOption('b'), { v: ['b'] }],
    ['locator.press', (p) => sel(p).press('Enter'), {}],
    ['locator.type', (p) => sel(p).type('ab'), {}],
    ['locator.pressSequentially', (p) => sel(p).pressSequentially('ab'), {}],
    ['locator.hover', (p) => sel(p).hover(), {}],
    ['locator.focus', (p) => sel(p).focus(), {}],
    ['locator.scrollIntoViewIfNeeded', (p) => sel(p).scrollIntoViewIfNeeded(), {}],
    ['page.click', (p) => p.click('#a'), {}],
    ['page.fill', (p) => p.fill('#a', 'v'), {}],
    ['page.press', (p) => p.press('#a', 'Enter'), {}],
    ['page.type', (p) => p.type('#a', 'ab'), {}],
    ['page.check', (p) => p.check('#a'), {}],
    ['page.uncheck', (p) => p.uncheck('#a'), {}],
    ['page.selectOption', (p) => p.selectOption('#a', 'b'), { v: ['b'] }],
    ['page.textContent', (p) => p.textContent('#a'), { text: 'x' }],
    ['page.innerText', (p) => p.innerText('#a'), { v: 'x' }],
    ['page.inputValue', (p) => p.inputValue('#a'), { v: 'x' }],
    ['page.getAttribute', (p) => p.getAttribute('#a', 'href'), { v: 'x' }],
    ['page.isVisible', (p) => p.isVisible('#a'), { v: true }],
    ['page.content', (p) => p.content(), { s: '"<html></html>"' }],
  ];
  test.each(actions)('%s', async (_name, run, r) => {
    const { page, log } = fake(() => ok(r));
    await run(page);
    expect(log.runJs).toHaveLength(1);
  });

  test('값을 돌려주는 것들은 페이지가 준 값을 그대로 돌려준다', async () => {
    const { page } = fake((s) => ok(/"op":"count"/.test(s) ? { v: 3 } : /"op":"prop"/.test(s) ? { v: 'ab' } : /"op":"select"/.test(s) ? { v: ['b', 'c'] } : { v: null }));
    expect(await page.locator('li').count()).toBe(3);
    expect(await page.locator('li').innerText()).toBe('ab');
    expect(await page.locator('select').selectOption(['b', 'c'])).toEqual(['b', 'c']);
  });

  test('all() 은 개수만 한 번 세고 nth 로 나눈다', async () => {
    const { page, log } = fake(() => ok({ v: 3 }));
    const all = await page.locator('li').all();
    expect(all).toHaveLength(3);
    expect(log.runJs).toHaveLength(1);
    await all[2]!.click();
    expect(chainOf(log.runJs[1]!)).toEqual([{ k: 'css', s: 'li' }, { k: 'nth', i: 2 }]);
  });

  test('이동할 수 있는 동작은 settleTab 을 거치고, 읽기만 하는 것은 거치지 않는다', async () => {
    const a = fake(() => ok());
    await a.page.getByRole('button').click();
    await a.page.locator('#a').check();
    await a.page.locator('#a').selectOption('b');
    await a.page.locator('#a').press('Enter');
    expect(a.log.settle).toBe(4);
    const b = fake(() => ok({ v: 1 }));
    await b.page.locator('#a').count();
    await b.page.locator('#a').innerText();
    await b.page.locator('#a').isVisible();
    expect(b.log.settle).toBe(0);
  });

  test('찾는 요소가 없다는 페이지 쪽 오류는 한국어 문장 그대로 올라온다', async () => {
    const { page } = fake(() => JSON.stringify({ ok: false, err: "찾는 요소가 없어요: getByRole('button', {name: '보내기'})" }));
    await expect(page.getByRole('button', { name: '보내기' }).click()).rejects.toThrow("찾는 요소가 없어요: getByRole('button', {name: '보내기'})");
  });

  test('waitFor · waitForSelector 는 조건이 되면 끝나고, 시간이 지나면 한국어 오류', async () => {
    let n = 0;
    const { page } = fake(() => ok({ v: { n: n++ < 2 ? 0 : 1, vis: n > 2 } }));
    await page.locator('#late').waitFor();
    n = 0;
    const loc = await page.waitForSelector('#late', { state: 'attached' });
    expect(typeof loc.click).toBe('function');
    const never = fake(() => ok({ v: { n: 0, vis: false } }));
    await expect(never.page.locator('#nope').waitFor({ timeout: 300 })).rejects.toThrow(/0\.3초 안에 locator\('#nope'\).* 되지 않았어요/);
    await expect(never.page.waitForSelector('#nope', { timeout: 300 })).rejects.toThrow(/초 안에/);
    const gone = fake(() => ok({ v: { n: 0, vis: false } }));
    await gone.page.locator('#x').waitFor({ state: 'hidden' }); // 없으면 hidden 도 detached 도 된 것
    await gone.page.locator('#x').waitFor({ state: 'detached' });
  });

  test('goBack 은 갈 곳이 없어도 오래 붙잡지 않는다', async () => {
    const { page, log } = fake((s) => (s.includes('readyState') ? 'complete' : ok({ expectNav: true })));
    const t0 = Date.now();
    await page.goBack();
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(log.settle).toBeGreaterThan(1);
  });

  test('waitForTimeout 은 그만큼 기다린다', async () => {
    const { page } = fake(() => ok());
    const t0 = Date.now();
    await page.waitForTimeout(120);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  test('waitForURL: 글 · 글 패턴 · RegExp · 함수, 맞을 때까지 settleTab 으로 주소를 본다', async () => {
    let url = 'http://x/start';
    const d = {
      async settleTab() {
        return { navigated: false, leaving: false, tab: { ...tab, url } };
      },
      async runJs() {
        return 'complete';
      },
      lastUrl: () => url, // 실제 드라이버는 settleTab 이 기록한 주소를 돌려준다
    } as unknown as SafariDriver;
    const page = new Page(d, 't1');
    await page.waitForURL('http://x/start'); // 이미 맞으면 바로
    setTimeout(() => (url = 'http://x/result.html?q=a'), 150);
    await page.waitForURL('**/result.html?q=*');
    url = 'http://x/other';
    await page.waitForURL(/other$/);
    await page.waitForURL((u) => u.pathname === '/other');
    expect(page.url()).toBe('http://x/other');
    await expect(page.waitForURL('**/never', { timeout: 250 })).rejects.toThrow(/0\.25초 안에 .*\/never.* 맞지 않았어요/);
  });

  test('reload · goBack · goForward 는 제자리에서 이동하고 다 뜰 때까지 기다린다(이동이 안 보이면 잠깐만 기다리고 끝낸다)', async () => {
    for (const m of ['reload', 'goBack', 'goForward'] as const) {
      const { page, log } = fake((s) => (s.includes('readyState') ? 'complete' : ok({ expectNav: true })), true);
      await page[m]();
      expect(log.runJs).toHaveLength(2); // 동작 하나 + 로딩 확인
      expect(log.settle).toBe(1); // 새 문서가 떴다고 하면 바로 끝
    }
  });
});

describe('REPL 안에서(vm 칸의 RegExp · 배열)', () => {
  test('sandbox 의 RegExp 리터럴이 name · hasText · waitForURL 에 RegExp 로 알아봐진다', async () => {
    const d = createFakeDriver();
    const sent: string[] = [];
    d.answer = (_k, s) => {
      sent.push(s);
      return ok({ v: 1 });
    };
    const session = createReplSession(d);
    const r = await session.run(
      `const p = await openTab('http://x/'); await p.getByRole('link', { name: /홈/i }).click(); await p.locator('li').filter({ hasText: /둘/ }).count(); await p.getByText(/a.b/s).count(); console.log('끝')`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output).toBe('끝');
    expect(chainOf(sent.at(-3)!)).toEqual([{ k: 'role', role: 'link', name: { re: '홈', fl: 'i' }, exact: false }]);
    expect(chainOf(sent.at(-2)!)[1]).toEqual({ k: 'hasText', m: { re: '둘', fl: '' } });
    expect(chainOf(sent.at(-1)!)[0]).toEqual({ k: 'text', m: { re: 'a.b', fl: 's' }, exact: false });
    await session.dispose();
  });
});

describe('페이지 안 글이 문법에 맞다', () => {
  test.each(ACTION_OPS)('buildActionSource(%s) 는 파싱된다', (op) => {
    const src = buildActionSource(op, { tok: 'tk', chain: [{ k: 'css', s: '#a' }], desc: "locator('#a')", key: 'Enter', text: 'a', value: 'v', name: 'href', want: true, sel: [{ any: 'b' }], what: 'innerText', dir: 'reload', url: 'http://x/' });
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });
});

describe('repl 설명', () => {
  test('새로 되는 Playwright 식 이름과 엄격하지 않다는 규칙을 한 단락으로 알린다', () => {
    for (const w of ['waitForURL', 'waitForSelector', 'waitForTimeout', 'reload', 'goBack', 'goForward', 'content', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'first', 'last', 'nth', 'count', 'all', 'filter', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isChecked', 'isEnabled', 'check', 'uncheck', 'selectOption', 'pressSequentially', 'hover', 'focus', 'scrollIntoViewIfNeeded', 'waitFor', '엄격', 'Non-strict']) {
      expect(REPL_DESCRIPTION, w).toContain(w);
    }
  });
});
