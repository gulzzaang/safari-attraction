import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';
import { createReplSession } from '../../src/repl/context.js';
import { ACTION_OPS, buildActionSource } from '../../src/repl/inpage-actions.js';
import { describeChain, globToRegExp, normTimeout, parseSelector, type Step } from '../../src/repl/locator.js';
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
    expect(parseSelector('e12')).toEqual([{ k: 'ref', s: 'e12' }]);
    expect(parseSelector('#a > b')).toEqual([{ k: 'css', s: '#a > b' }]);
    expect(parseSelector('#a', false)).toEqual([{ k: 'sub', s: '#a' }]);
    expect(parseSelector('text=로그인')).toEqual([{ k: 'text', m: { s: '로그인' }, exact: false }]);
    expect(parseSelector('text="로그인"')).toEqual([{ k: 'text', m: { s: '로그인' }, exact: true }]);
  });

  test('Playwright 식 선택자: css= · text=/re/ · :has-text · role= · nth= · >> 이음', () => {
    expect(parseSelector('css=button.primary')).toEqual([{ k: 'css', s: 'button.primary' }]);
    expect(parseSelector('text=/로그.n/i')).toEqual([{ k: 'text', m: { re: '로그.n', fl: 'i' }, exact: false }]);
    expect(parseSelector('button:has-text("저장")')).toEqual([{ k: 'css', s: 'button' }, { k: 'hasText', m: { s: '저장' }, exact: false }]);
    expect(parseSelector("li:text-is('둘째')")).toEqual([{ k: 'css', s: 'li' }, { k: 'hasText', m: { s: '둘째' }, exact: true, deep: true }]);
    expect(parseSelector('a:text("홈"):has-text(/x/i)')).toEqual([{ k: 'css', s: 'a' }, { k: 'hasText', m: { s: '홈' }, exact: false, deep: true }, { k: 'hasText', m: { re: 'x', fl: 'i' }, exact: false }]);
    // 앞 선택자가 없는 :has-text · :text 는 가장 깊은(작은) 요소 — html · body 를 고르지 않는다. 앞 선택자가 있는 :has-text 는 품은 모든 요소
    expect(parseSelector(':has-text("x")')).toEqual([{ k: 'css', s: '*' }, { k: 'hasText', m: { s: 'x' }, exact: false, deep: true }]);
    expect(parseSelector('div:has-text("x")')[1]).not.toHaveProperty('deep');
    expect(parseSelector('div:text("x")')[1]).toMatchObject({ deep: true });
    // 속성 값 안의 :text( 는 CSS 그대로
    expect(parseSelector('[data-x="a:text(b)"]')).toEqual([{ k: 'css', s: '[data-x="a:text(b)"]' }]);
    expect(parseSelector("a[title='x:has-text(y)']:has-text('z')")).toEqual([{ k: 'css', s: "a[title='x:has-text(y)']" }, { k: 'hasText', m: { s: 'z' }, exact: false }]);
    // 값의 따옴표 벗기기 · text="…"i
    expect(parseSelector('id="main"')).toEqual([{ k: 'css', s: '[id="main"]' }]);
    expect(parseSelector("data-testid='go'")).toEqual([{ k: 'testid', m: { s: 'go' } }]);
    expect(parseSelector('text="foo"i')).toEqual([{ k: 'text', m: { re: '^\\s*foo\\s*$', fl: 'i' }, exact: false }]);
    expect(parseSelector('text="a.b"s')).toEqual([{ k: 'text', m: { s: 'a.b' }, exact: true }]);
    expect(parseSelector('role=button[name="저장"]')).toEqual([{ k: 'role', role: 'button', name: { s: '저장' }, exact: false }]);
    expect(parseSelector('role=button[name="저장"s]')).toEqual([{ k: 'role', role: 'button', name: { s: '저장' }, exact: true }]);
    expect(parseSelector('role=link[name=/홈|home/i]')).toEqual([{ k: 'role', role: 'link', name: { re: '홈|home', fl: 'i' }, exact: false }]);
    expect(parseSelector('role=heading[level=2]')).toEqual([{ k: 'role', role: 'heading', exact: false, level: 2, name: undefined }]);
    expect(parseSelector('role=checkbox[checked][name="약관"]')[0]).toMatchObject({ role: 'checkbox', checked: true, name: { s: '약관' } });
    expect(parseSelector('role=button[pressed=false]')[0]).toMatchObject({ pressed: false });
    expect(parseSelector('li >> nth=1')).toEqual([{ k: 'css', s: 'li' }, { k: 'nth', i: 1 }]);
    expect(parseSelector('nav >> a:has-text("소개") >> nth=-1')).toEqual([{ k: 'css', s: 'nav' }, { k: 'sub', s: 'a' }, { k: 'hasText', m: { s: '소개' }, exact: false }, { k: 'nth', i: -1 }]);
    expect(parseSelector('css=ul >> role=button[name="x"]').map((x) => x.k)).toEqual(['css', 'role']);
    expect(parseSelector('a[href="x>>y"] >> b').map((x) => (x as { s?: string }).s)).toEqual(['a[href="x>>y"]', 'b']); // 따옴표 안의 >> 는 나누지 않는다
    expect(parseSelector('id=nm')).toEqual([{ k: 'css', s: '[id="nm"]' }]);
    expect(parseSelector('data-testid=go')).toEqual([{ k: 'testid', m: { s: 'go' } }]);
  });

  test('지원하지 않는 선택자는 한국어 오류로 알린다', () => {
    expect(() => parseSelector('xpath=//a')).toThrow(/xpath.*getByRole/);
    expect(() => parseSelector('//div/a')).toThrow(/xpath/);
    expect(() => parseSelector('role=button[disabled]')).toThrow(/모르는 속성이에요: disabled/);
    expect(() => parseSelector('div:has-text("x") > b')).toThrow(/끝에서만/);
    expect(() => parseSelector('a >> ')).toThrow(/빈 조각/);
    expect(() => parseSelector('role=checkbox[checked=foo]')).toThrow(/checked 값이 잘못됐어요: foo/);
    expect(() => parseSelector('role=button[expanded=mixed]')).toThrow(/expanded 값이 잘못됐어요/);
    expect(() => parseSelector('role=heading[level=x]')).toThrow(/level 은 정수/);
  });

  test('getByRole 의 상태 옵션을 chain 에 싣고, 모르는 옵션 · filter 의 has 는 한국어 오류', () => {
    const f = fake(() => ok());
    const r = f.page.getByRole('heading', { name: '제목', level: 2, expanded: true, includeHidden: true, checked: 'mixed', pressed: false, selected: true });
    expect(describeChain((r as unknown as { chain: Step[] }).chain)).toBe("getByRole('heading', {name: '제목', level: 2, checked: \"mixed\", pressed: false, expanded: true, selected: true, includeHidden: true})");
    expect(() => f.page.getByRole('button', { disabled: true } as never)).toThrow('getByRole 이 모르는 옵션이에요: disabled');
    expect(() => f.page.getByText('x', { nope: 1 } as never)).toThrow(/getByText 이 모르는 옵션이에요: nope/);
    const l = f.page.locator('li');
    expect(() => l.filter({ has: l } as never)).toThrow(/filter 의 has 는 아직 지원하지 않아요.*locator\(하위 선택자\)/);
    expect(() => l.filter({ hasNot: l } as never)).toThrow(/filter 의 hasNot/);
    expect(() => l.filter({ foo: 1 } as never)).toThrow('filter 가 모르는 옵션이에요: foo');
    expect(() => l.filter({})).toThrow(/hasText/);
    expect(describeChain((l.filter({ hasNotText: '둘' }) as unknown as { chain: Step[] }).chain)).toBe("locator('li').filter({hasNotText: '둘'})");
  });

  test('describeChain 은 Playwright 꼴 글을 만든다(오류 글에 쓴다)', () => {
    expect(describeChain([{ k: 'role', role: 'button', name: { s: '보내기' }, exact: false }])).toBe("getByRole('button', {name: '보내기'})");
    expect(describeChain([{ k: 'role', role: 'link', name: { re: 'a', fl: 'i' }, exact: true }])).toBe("getByRole('link', {name: /a/i, exact: true})");
    expect(describeChain([{ k: 'css', s: '#a' }, { k: 'sub', s: 'b' }, { k: 'nth', i: 0 }, { k: 'nth', i: -1 }, { k: 'nth', i: 3 }])).toBe("locator('#a').locator('b').first().last().nth(3)");
    expect(describeChain([{ k: 'text', m: { s: "it's" }, exact: false }, { k: 'hasText', m: { s: 'x' } }])).toBe("getByText('it\\'s').filter({hasText: 'x'})");
  });
});

describe('Page 줄임 동작은 선택자가 잘못돼도 던지지 않고 거부된 약속을 돌려준다', () => {
  test('page.click · fill · textContent … 에 xpath 를 주면 동기 throw 가 아니라 reject', async () => {
    const { page } = fake(() => ok());
    for (const run of [() => page.click('xpath=//a'), () => page.fill('//a', 'v'), () => page.textContent('role=button[disabled]'), () => page.isVisible('xpath=//a'), () => page.getAttribute('xpath=//a', 'x')]) {
      let p: Promise<unknown> | undefined;
      expect(() => (p = run())).not.toThrow();
      await expect(p).rejects.toThrow(/xpath|모르는 속성/);
    }
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
    expect(re('http://x/**/b.html').test('http://x/b.html')).toBe(true); // /**/ 는 디렉터리 0개 이상
    expect(re('http://x/**/b.html').test('http://x/a/c/b.html')).toBe(true);
    expect(re('**/b.html').test('http://x/b.html')).toBe(true);
    expect(re('http://x/**/b.html').test('http://y/b.html')).toBe(false);
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

describe('동작은 대상이 준비될 때까지 기다린다(시도 하나 = runJs 하나)', () => {
  const notReady = (why: string) => ok({ notReady: why });
  const argsOf = (source: string) => JSON.parse(source.slice(source.lastIndexOf('})(') + 3, -1));

  test('「아직 아님」을 두 번 받은 뒤 준비되면 한 번만 동작하고 runJs 는 모두 3번, settleTab 은 동작한 뒤 한 번', async () => {
    const { page, log } = fake((_s, n) => (n <= 2 ? notReady(n === 1 ? 'missing' : 'hidden') : ok()));
    await page.getByRole('button', { name: '보내기' }).click();
    expect(log.runJs).toHaveLength(3);
    expect(log.settle).toBe(1);
  });

  test('이미 있으면 runJs 한 번으로 끝난다(기다림 지연 없음)', async () => {
    const { page, log } = fake(() => ok());
    const t0 = Date.now();
    await page.locator('#a').click();
    await page.locator('#a').fill('v');
    expect(log.runJs).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test('끝내 준비되지 않으면 준 시간 뒤 한국어 오류(이름 · 조건 · 마지막 상태)', async () => {
    const { page, log } = fake(() => notReady('missing'));
    const t0 = Date.now();
    await expect(page.getByRole('button', { name: '보내기' }).click({ timeout: 400 })).rejects.toThrow(
      "0.4초 기다렸지만 누를 수 있는 요소가 없어요: getByRole('button', {name: '보내기'}) (마지막 확인: 아직 없음)",
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(log.runJs.length).toBeGreaterThanOrEqual(3); // 150ms 간격으로 다시 확인했다
    expect(log.settle).toBe(0); // 동작하지 않았으니 이동 확인도 없다
    const ref = fake(() => notReady('missing'));
    await expect(ref.page.locator('e9').click({ timeout: 100 })).rejects.toThrow(/e9.*snapshot 을 다시 찍어 새 ref/);
    const hid = fake(() => notReady('disabled'));
    await expect(hid.page.fill('#a', 'v', { timeout: 200 })).rejects.toThrow(/0\.2초 기다렸지만 글을 채울 수 있는 요소가 없어요: locator\('#a'\) \(마지막 확인: 있지만 비활성\)/);
  });

  test('기다리는 동작은 wait 조건을 함께 보낸다: 누르기 · 쓰기는 보임 + 활성, 글쇠 · 올리기는 보임, 읽기는 붙어 있기만', async () => {
    const { page, log } = fake(() => ok({ v: 'x', text: 'x' }));
    await page.locator('#a').click();
    await page.locator('#a').press('Enter');
    await page.locator('#a').textContent();
    await page.locator('#a').getAttribute('href');
    const w = log.runJs.map((s) => argsOf(s).wait);
    expect(w).toEqual([{ visible: true, enabled: true }, { visible: true, enabled: false }, { visible: false, enabled: false }, { visible: false, enabled: false }]);
  });

  test('count · isVisible · isChecked · isEnabled 는 기다리지 않는다(wait 조건이 없다)', async () => {
    const { page, log } = fake(() => ok({ v: true }));
    await page.locator('#a').count();
    await page.locator('#a').isVisible();
    await page.locator('#a').isChecked();
    await page.locator('#a').isEnabled();
    expect(log.runJs.map((s) => argsOf(s).wait)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('timeout 은 모든 기다리는 동작에 준다', async () => {
    for (const run of [
      (p: Page) => p.locator('#a').check({ timeout: 100 }),
      (p: Page) => p.locator('#a').selectOption('b', { timeout: 100 }),
      (p: Page) => p.locator('#a').type('x', { timeout: 100 }),
      (p: Page) => p.locator('#a').hover({ timeout: 100 }),
      (p: Page) => p.locator('#a').focus({ timeout: 100 }),
      (p: Page) => p.locator('#a').innerText({ timeout: 100 }),
      (p: Page) => p.textContent('#a', { timeout: 100 }),
      (p: Page) => p.getAttribute('#a', 'x', { timeout: 100 }),
    ]) {
      const { page } = fake(() => notReady('missing'));
      await expect(run(page)).rejects.toThrow(/0\.1초 기다렸지만 .* 요소가 없어요: locator\('#a'\)/);
    }
  });
});

describe('기다림의 한도와 호출 끝(좀비 방지)', () => {
  afterEach(() => vi.useRealTimers());

  test('normTimeout: 안 주면 기본값, 양수는 110초까지, 0 · NaN · 음수 · 글자는 110초', () => {
    expect(normTimeout(undefined, 10000)).toBe(10000);
    expect(normTimeout(300, 10000)).toBe(300);
    expect(normTimeout(1e9, 10000)).toBe(110000);
    expect(normTimeout(0, 10000)).toBe(110000);
    expect(normTimeout(Number.NaN, 10000)).toBe(110000);
    expect(normTimeout(-5, 10000)).toBe(110000);
    expect(normTimeout('abc', 10000)).toBe(110000);
    expect(normTimeout(Infinity, 10000)).toBe(110000);
  });

  test.each([0, Number.NaN, -1, 1e9, Infinity])('timeout %s 은 끝없이 기다리지 않고 110초 뒤에 한국어 오류(동작 · waitFor · waitForURL)', async (t) => {
    vi.useFakeTimers();
    const never = fake(() => ok({ notReady: 'missing', v: { n: 0, vis: false } }));
    const urls = new Page(
      { settleTab: async () => ({ navigated: false, leaving: false, tab: { ...tab, url: 'http://x/' } }), runJs: async () => 'complete', lastUrl: () => 'http://x/' } as unknown as SafariDriver,
      't1',
    );
    const results = [
      never.page.locator('#a').click({ timeout: t }),
      never.page.locator('#a').waitFor({ timeout: t }),
      urls.waitForURL('http://x/never', { timeout: t }),
    ].map((p) => p.then(() => 'ok', (e: Error) => e.message));
    await vi.advanceTimersByTimeAsync(109_000);
    expect(await Promise.race([Promise.all(results), Promise.resolve('아직')])).toBe('아직'); // 109초까지는 안 끝난다
    await vi.advanceTimersByTimeAsync(2_000);
    const [a, b, c] = await Promise.all(results);
    expect(a).toMatch(/^110초 기다렸지만 누를 수 있는 요소가 없어요/);
    expect(b).toMatch(/^110초 안에 locator\('#a'\) 가 보이게 되지 않았어요/);
    expect(c).toMatch(/^110초 안에 주소가 http:\/\/x\/never/);
  });

  test('호출이 시간 초과로 끝나면 돌던 기다림은 더 이상 runJs 를 하지 않는다', async () => {
    const d = createFakeDriver();
    d.answer = () => ok({ notReady: 'missing', v: { n: 0, vis: false } });
    const session = createReplSession(d);
    const r = await session.run(`const p = await openTab('http://x/'); await p.locator('#a').click({ timeout: 60000 })`, { timeoutMs: 400 });
    expect(r.error).toMatch(/시간 초과/);
    await new Promise((res) => setTimeout(res, 200)); // 이미 나간 시도 하나는 끝나게 둔다
    const n1 = d.calls.runJs.length;
    expect(n1).toBeGreaterThan(1);
    await new Promise((res) => setTimeout(res, 700));
    expect(d.calls.runJs.length).toBe(n1); // 그 뒤로는 하나도 늘지 않는다
    const r2 = await session.run(`await page.locator('#b').waitFor({ timeout: 60000 })`, { timeoutMs: 400 });
    expect(r2.error).toMatch(/시간 초과/);
    await new Promise((res) => setTimeout(res, 200));
    const n2 = d.calls.runJs.length;
    const s2 = d.calls.settleTab.length;
    await new Promise((res) => setTimeout(res, 700));
    expect(d.calls.runJs.length).toBe(n2);
    expect(d.calls.settleTab.length).toBe(s2);
    await session.dispose();
  });

  test('await 없이 던져 둔 동작은 호출이 끝나면 첫 시도 뒤 멈춘다', async () => {
    const d = createFakeDriver();
    d.answer = () => ok({ notReady: 'missing' });
    const session = createReplSession(d);
    const r = await session.run(`const p = await openTab('http://x/'); p.locator('#a').click({ timeout: 60000 }).catch(() => {}); await sleep(30)`);
    expect(r.error).toBeUndefined();
    await new Promise((res) => setTimeout(res, 100));
    const n = d.calls.runJs.length;
    expect(n).toBe(1); // 첫 시도만
    await new Promise((res) => setTimeout(res, 600));
    expect(d.calls.runJs.length).toBe(n);
    await session.dispose();
  });

  test('호출이 끝난 뒤에는 재시도가 준비돼도 동작하지 않는다(늦은 클릭 방지)', async () => {
    const d = createFakeDriver();
    let ready = false;
    let acted = 0;
    d.answer = (_k, s) => {
      if (!ready) return ok({ notReady: 'missing' });
      if (s.includes('"op":"click"')) acted++;
      return ok();
    };
    const session = createReplSession(d);
    await session.run(`const p = await openTab('http://x/'); await p.getByRole('button').click({ timeout: 60000 })`, { timeoutMs: 300 });
    ready = true; // 호출은 이미 끝났다
    await new Promise((res) => setTimeout(res, 700));
    expect(acted).toBe(0);
    await session.dispose();
  });
});

describe('selectOption 의 선택지 기다림 · 이동 전 주소', () => {
  test('선택지가 아직 없으면(notReady option) 다시 시도하고, 끝내 없으면 마지막 상태를 알린다', async () => {
    const a = fake((_s, n) => (n <= 2 ? ok({ notReady: 'option' }) : ok({ v: ['x'] })));
    expect(await a.page.locator('select').selectOption('x')).toEqual(['x']);
    expect(a.log.runJs).toHaveLength(3);
    const b = fake(() => ok({ notReady: 'option' }));
    await expect(b.page.locator('select').selectOption('x', { timeout: 200 })).rejects.toThrow(/0\.2초 기다렸지만 고를 수 있는 요소가 없어요: locator\('select'\) \(마지막 확인: 고를 선택지가 아직 없음\)/);
  });

  test('goBack 은 이동 전 주소를 nav runJs 의 값(v)에서 받는다 — 캐시가 늦어도 주소 변화를 알아본다', async () => {
    const t2 = { ...tab, url: 'http://x/b' };
    const d = {
      async runJs(_k: string, s: string) {
        return s.includes('readyState') ? 'complete' : ok({ expectNav: true, v: 'http://x/a' });
      },
      async settleTab() {
        return { navigated: false, leaving: false, tab: t2 };
      },
      lastUrl: () => 'http://x/b', // 캐시는 이미 이동 후 주소(한 박자 빠름/늦음)
    } as unknown as SafariDriver;
    const t0 = Date.now();
    await new Page(d, 't1').goBack();
    expect(Date.now() - t0).toBeLessThan(800); // 주소가 달라졌으니 바로 끝난다(갈 곳 없음으로 2초 기다리지 않는다)
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
    for (const w of ['waitForURL', 'waitForSelector', 'waitForTimeout', 'reload', 'goBack', 'goForward', 'content', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'first', 'last', 'nth', 'count', 'all', 'filter', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isChecked', 'isEnabled', 'check', 'uncheck', 'selectOption', 'pressSequentially', 'hover', 'focus', 'scrollIntoViewIfNeeded', 'waitFor', '엄격', 'Non-strict', '최대 10초', 'up to 10 s']) {
      expect(REPL_DESCRIPTION, w).toContain(w);
    }
  });
});
