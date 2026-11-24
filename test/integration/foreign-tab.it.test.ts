import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import { createReplSession, type ReplSession } from '../../src/repl/context.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// 다른 서버(같은 사파리에서 도는 다른 Claude 세션 · 앱의 「일 맡기기」가 입력마다 띄우는 서버)가 사용자 탭에 남긴 표시가 있어도,
// 새 서버가 그 탭을 붙여 쓸 수 있어야 한다. 이 파일이 연 탭(꼬리표가 든 주소)만 만지고 닫는다 — 사용자 탭은 읽지도 만지지도 않는다.
const RUN = `it=foreign-${process.pid}-${Date.now()}`;
const LEGACY = 't9.deadbeef';

function jxa(body: string): string {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', body], { encoding: 'utf8' }).trim();
}
const needTag = (url: string) => {
  if (!url.includes(RUN)) throw new Error('꼬리표 없는 주소는 만지지 않는다');
};
/** 맨 앞 창 끝에 시험 탭을 하나 더한다(사용자가 탭을 연 것처럼 — 서버는 모른다. 앞으로 가져오지 않는다). */
function addUserLikeTab(url: string): void {
  needTag(url);
  jxa(`const S = Application("Safari"); const w = S.windows[0]; w.tabs.push(S.Tab({ url: ${JSON.stringify(url)} })); delay(1); "ok"`);
}
function closeDirectly(url: string): void {
  needTag(url);
  jxa(`const S = Application("Safari");
       S.windows().forEach((w) => { let urls; try { urls = w.tabs.url(); } catch (e) { return; }
         for (let i = urls.length - 1; i >= 0; i--) if (String(urls[i]) === ${JSON.stringify(url)}) w.tabs[i].close(); }); "ok"`);
}
/** 꼬리표가 든 주소의 탭 하나에서 사파리가 직접 스크립트를 돌린다(서버를 거치지 않는다). 결과는 글. */
function runDirectly(url: string, js: string): string {
  needTag(url);
  return jxa(`const S = Application("Safari"); let out = [];
       S.windows().forEach((w) => { let urls; try { urls = w.tabs.url(); } catch (e) { return; }
         for (let i = 0; i < urls.length; i++) if (String(urls[i]) === ${JSON.stringify(url)}) out.push(String(S.doJavaScript(${JSON.stringify(js)}, { in: w.tabs[i] }))); });
       out.length === 1 ? out[0] : "TABS:" + out.length`);
}
const markerOf = (url: string) => runDirectly(url, "String(document.documentElement.dataset.saTab || '')");
const plantMarker = (url: string, m: string) => runDirectly(url, `document.documentElement.dataset.saTab = ${JSON.stringify(m)}; 'ok'`);

/** 방금 연 탭은 처음 한동안 문서가 바뀌어 심은 표시가 사라질 수 있다 — 1초 뒤에도 남아 있을 때까지 다시 심는다. */
async function plantUntilStable(url: string, m: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    expect(plantMarker(url, m)).toBe('ok');
    await new Promise((r) => setTimeout(r, 1000));
    if (markerOf(url) === m) return;
  }
  throw new Error('표시가 남지 않음');
}

let seq = 0;
let URL1 = '';
let ready = false;

/** 서버 하나(드라이버 + repl 세션). 각각 다른 instanceId 의 표시를 쓴다. */
function server() {
  const d = createJxaDriver();
  const s = createReplSession(d);
  return { d, s, stop: async () => { try { await s.dispose?.(); } finally { await d.close(); } } };
}

const FIND = `l.find((x) => x.url.includes(${JSON.stringify(RUN)}))`;
const ATTACH = `const l = await listBrowserTabs();
const t = ${FIND};
console.log('key1', t.key);
const a = await attachBrowserTab(t.key);
console.log('title', await a.evaluate('document.title'));
const l2 = await listBrowserTabs();
console.log('key2', ${FIND.replace('l.find', 'l2.find')}.key);
console.log('again', await a.evaluate('document.title'));`;

async function attach(s: ReplSession): Promise<{ key1: string; key2: string; title: string; again: string }> {
  const r = await s.run(ATTACH);
  expect(r.error, r.output).toBeUndefined();
  const line = (name: string) => r.output.split('\n').find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
  return { key1: line('key1'), key2: line('key2'), title: line('title'), again: line('again') };
}

describeIt('남의 표시가 남은 사용자 탭 붙이기', () => {
  beforeAll(async () => {
    await startFixtures();
    ready = jxa(`const S = Application("Safari"); S.running() && S.windows().length > 0 ? "yes" : "no"`) === 'yes'; // 사파리를 켜지 않는다(꺼져 있으면 건너뛴다)
  });
  afterEach(() => {
    if (URL1) closeDirectly(URL1);
    URL1 = '';
  });
  afterAll(stopFixtures);

  /** 시험 탭이 다 뜰 때까지(표시를 심은 뒤 새 문서가 떠 지워지는 일이 없게) 기다린다. */
  async function freshTab(): Promise<void> {
    URL1 = `${fixture('basic.html')}?${RUN}&n=${seq++}`;
    addUserLikeTab(URL1);
    for (let i = 0; i < 50; i++) {
      let state = '';
      try {
        state = runDirectly(URL1, 'document.readyState');
      } catch {}
      if (state === 'complete') {
        await new Promise((r) => setTimeout(r, 2000)); // 방금 연 탭은 처음 한동안 문서가 바뀌어 표시가 사라질 수 있다 — 가라앉은 뒤에 쓴다
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('시험 탭이 뜨지 않음');
  }

  test('앞 서버가 아직 살아 있다: 새 서버가 붙어 evaluate 하고, 목록을 다시 봐도 같은 키이며, 남의 표시를 덮어쓰지 않고, 앞 서버도 계속 쓴다', async (ctx) => {
    if (!ready) ctx.skip();
    await freshTab();
    const A = server();
    const B = server();
    try {
      const a = await attach(A.s);
      expect(a.title).not.toBe('');
      const aMarker = markerOf(URL1);
      expect(aMarker).toMatch(/^t\d+\./); // A 가 표시를 적었다
      const b = await attach(B.s); // 고치기 전에는 여기서 TAB_CLOSED
      expect(b.title).toBe(a.title);
      expect(b.again).toBe(a.title);
      expect(b.key2).toBe(b.key1); // 목록마다 새 키로 바뀌지 않는다
      expect(markerOf(URL1)).toBe(aMarker); // 덮어쓰지 않았다
      const again = await A.s.run("console.log(await a.evaluate('document.title'))"); // 앞 서버는 탭을 놓치지 않았다
      expect(again.error, again.output).toBeUndefined();
      expect(again.output).toBe(a.title);
    } finally {
      await B.stop();
      await A.stop();
    }
    expect(markerOf(URL1)).toBe(''); // A 가 끝날 때 자기 표시를 지웠다(B 는 적은 적이 없다)
  }, 120_000);

  test('앞 서버가 끝난 뒤 새 서버가 붙는다(앱의 「일 맡기기」): 키가 그대로이고, 끝나면 표시가 남지 않는다', async (ctx) => {
    if (!ready) ctx.skip();
    await freshTab();
    const A = server();
    try {
      await attach(A.s);
    } finally {
      await A.stop();
    }
    expect(markerOf(URL1)).toBe(''); // 끝날 때 우리 표시를 지웠다
    const B = server();
    try {
      const b = await attach(B.s);
      expect(b.title).not.toBe('');
      expect(b.key2).toBe(b.key1);
    } finally {
      await B.stop();
    }
    expect(markerOf(URL1)).toBe('');
  }, 120_000);

  test('옛 서버(0.3.x)가 지우지 않고 남긴 표시: 새 서버가 붙고, 그 표시는 덮어쓰지도 지우지도 않는다', async (ctx) => {
    if (!ready) ctx.skip();
    await freshTab();
    await plantUntilStable(URL1, LEGACY);
    const B = server();
    try {
      const b = await attach(B.s);
      expect(b.title).not.toBe('');
      expect(b.again).toBe(b.title);
      expect(b.key2).toBe(b.key1);
      expect(markerOf(URL1)).toBe(LEGACY);
    } finally {
      await B.stop();
    }
    expect(markerOf(URL1)).toBe(LEGACY); // 끝날 때도 남의 표시는 지우지 않는다
  }, 120_000);
});
