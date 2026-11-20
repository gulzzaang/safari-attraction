import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver } from '../../src/driver/types.js';
import { createReplSession, type ReplSession } from '../../src/repl/context.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// load 이벤트가 3초 늦는 페이지: 열기 · 이동은 DOM 이 쓸 수 있게 되면 돌아오고, load · networkidle 은 따로 기다린다.
// 이 파일은 REPL 세션이 연 탭(끝나면 세션이 닫는다)만 만진다.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

const RUN = `it=ready-${process.pid}-${Date.now()}`;
let seq = 0;
const slow = () => `${fixture('slow-load.html')}?${RUN}&n=${seq++}`;
const basic = () => `${fixture('basic.html')}?${RUN}&n=${seq++}`;

describeIt('열기 · 이동은 쓸 수 있을 때 돌아온다(domcontentloaded)', () => {
  let d: SafariDriver;
  let s: ReplSession;

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
    s = createReplSession(d);
  });
  afterAll(async () => {
    try {
      await s.dispose();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  const run = async (code: string) => {
    const r = await s.run(code);
    if (r.error) throw new Error(r.error + '\n' + r.output);
    return r.output;
  };

  test('openTab 은 load 이벤트(3초 뒤)를 기다리지 않고 DOM 본문을 snapshot 으로 읽는다', async () => {
    const out = await run(`const t0 = Date.now(); const a1 = await openTab(${JSON.stringify(slow())}); console.log(Date.now() - t0); const sn = await snapshot(a1); console.log(sn.tree); console.log(await a1.evaluate('window.__loaded'))`);
    const lines = out.split('\n');
    expect(Number(lines[0])).toBeLessThan(2500); // 열기는 load 이벤트(3초 뒤)보다 먼저 돌아온다
    expect(out).toContain('빠른 본문 제목');
    expect(lines[lines.length - 1]).toBe('false'); // 아직 load 전
  });

  test("waitForLoadState('load') 는 load 가 될 때까지 기다린다", async () => {
    const out = await run(`const a2 = await openTab(${JSON.stringify(slow())}); const t0 = Date.now(); await a2.waitForLoadState('load'); console.log(Date.now() - t0 > 300, await a2.evaluate('window.__loaded'))`);
    expect(out).toBe('true true');
  });

  test("waitForLoadState() 인자 없이도 load, 옛 숫자 꼴도 된다", async () => {
    const out = await run(`const a3 = await openTab(${JSON.stringify(slow())}); await a3.waitForLoadState(10000); console.log(await a3.evaluate('window.__loaded'))`);
    expect(out).toBe('true');
  });

  test("waitForLoadState('networkidle') 은 load 뒤 잠잠해질 때까지", async () => {
    const out = await run(`const a4 = await openTab(${JSON.stringify(slow())}); await a4.waitForLoadState('networkidle'); console.log(await a4.evaluate('window.__loaded + "," + performance.getEntriesByType("resource").length'))`);
    expect(out).toMatch(/^true,[1-9]/);
  });

  test("openTab(url, {waitUntil:'load'}) 는 load 까지 기다린다", async () => {
    const out = await run(`const a5 = await openTab(${JSON.stringify(slow())}, { waitUntil: 'load' }); console.log(await a5.evaluate('window.__loaded'))`);
    expect(out).toBe('true');
  });

  test('goto 는 기본으로 빨리 돌아오고, {waitUntil:"load"} 는 load 까지 기다린다', async () => {
    const out = await run(`
      const b1 = await openTab(${JSON.stringify(basic())});
      let t0 = Date.now();
      await b1.goto(${JSON.stringify(slow())});
      const fast = Date.now() - t0;
      console.log(fast < 2500, await b1.evaluate('window.__loaded'), await b1.title());
      const b2 = await openTab(${JSON.stringify(basic())});
      await b2.goto(${JSON.stringify(slow())}, { waitUntil: 'load' });
      console.log(await b2.evaluate('window.__loaded'));
      console.log(await b1.evaluate('document.body.innerText.length > 5'));
    `);
    expect(out.split('\n')).toEqual(['true false 늦게 끝나는 페이지', 'true', 'true']);
  });

  test('goto 뒤에도 탭 표시가 지켜져 같은 Page 로 계속 쓸 수 있다(load 전에 표시를 적어도 지워지지 않는다)', async () => {
    const out = await run(`
      const c1 = await openTab(${JSON.stringify(basic())});
      await c1.goto(${JSON.stringify(slow())});
      await sleep(3500); // load 가 지나간 뒤에도
      console.log(await c1.evaluate('window.__loaded'), (await listBrowserTabs()).filter((t) => t.url.includes(${JSON.stringify(RUN)})).length >= 1);
    `);
    expect(out).toBe('true true');
  });

  test('reload 는 기본 domcontentloaded 로 빨리 돌아온다', async () => {
    const out = await run(`
      const e1 = await openTab(${JSON.stringify(slow())}, { waitUntil: 'load' });
      const t0 = Date.now();
      await e1.reload();
      console.log(Date.now() - t0 < 2500, await e1.evaluate('window.__loaded'));
      await e1.waitForLoadState();
      console.log(await e1.evaluate('window.__loaded'));
    `);
    expect(out.split('\n')).toEqual(['true false', 'true']);
  });

  test('링크 클릭이 부른 이동도 쓸 수 있을 때 돌아온다', async () => {
    const out = await run(`
      const f1 = await openTab(${JSON.stringify(basic())});
      const t0 = Date.now();
      await f1.evaluate('location.href = ${JSON.stringify(slow())}');
      console.log(Date.now() - t0 < 2500, await f1.title());
    `);
    expect(out).toBe('true 늦게 끝나는 페이지');
  });

  test("goto {waitUntil:'commit'} 도 돌아오고 이어서 쓸 수 있다", async () => {
    const out = await run(`
      const g1 = await openTab(${JSON.stringify(basic())});
      await g1.goto(${JSON.stringify(slow())}, { waitUntil: 'commit' });
      console.log(g1.url().includes('slow-load.html'));
      await g1.waitForLoadState('domcontentloaded');
      console.log(await g1.title());
    `);
    expect(out.split('\n')).toEqual(['true', '늦게 끝나는 페이지']);
  });

  test('load 전(아직 로딩 중인 문서)에서 시작한 goto · 링크 이동도 느린 응답을 끝까지 기다려 같은 탭에서 새 문서를 읽는다', async () => {
    const out = await run(`
      const h1 = await openTab(${JSON.stringify(slow())});
      const t0 = Date.now();
      await h1.goto(${JSON.stringify(basic() + '&delay=2500')});
      console.log(Date.now() - t0 > 2000, await h1.title(), h1.url().includes('basic.html'));
      const h2 = await openTab(${JSON.stringify(slow())});
      await h2.evaluate('location.href = ${JSON.stringify(basic() + '&delay=2500')}');
      console.log(await h2.title());
    `);
    expect(out.split('\n')).toEqual(['true 기본 시험 페이지 true', '기본 시험 페이지']);
  });
});
