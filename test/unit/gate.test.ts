import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createGateFromEnv, GATE_WAIT_LIMIT_MS, noPermissionPromptsFromEnv, type GateRequest } from '../../src/gate/gate.js';
import { fetchIsIrreversible, isIrreversibleText, isReadOnlyExpression } from '../../src/gate/classify.js';

describe('isIrreversibleText(되돌릴 수 없음 글)', () => {
  test('한국어 · 영어 낱말을 대소문자 가리지 않고 알아본다', () => {
    for (const s of ['결제하기', '주문하기', '삭제', '회원 탈퇴', '송금', 'Place Order', 'BUY NOW', 'Checkout', 'Submit', 'Delete account', 'send', 'Confirm', 'Book a room']) {
      expect(isIrreversibleText(s), s).toBe(true);
    }
  });
  test('그 밖의 글 · 빈 글 · 글이 아닌 값은 아니다', () => {
    for (const s of ['다음', '검색', 'Search', 'Next', '', '   ']) expect(isIrreversibleText(s), s).toBe(false);
    expect(isIrreversibleText(undefined)).toBe(false);
    expect(isIrreversibleText(null)).toBe(false);
  });
});

describe('fetchIsIrreversible(메서드)', () => {
  test('GET · HEAD(대소문자 무관, 없으면 GET)가 아니면 true', () => {
    for (const m of ['POST', 'put', 'Patch', 'DELETE', 'OPTIONS']) expect(fetchIsIrreversible(m), m).toBe(true);
    for (const m of ['GET', 'get', 'HEAD', undefined, '']) expect(fetchIsIrreversible(m as string | undefined), String(m)).toBe(false);
  });
});

describe('isReadOnlyExpression(evaluate 식이 읽기만 하나)', () => {
  const ro = (s: string) => isReadOnlyExpression(s);
  test('읽기만 하는 식은 true', () => {
    expect(ro('document.title')).toBe(true);
    expect(ro("[...document.querySelectorAll('a')].map(a => a.href)")).toBe(true);
    expect(ro('() => document.body.innerText.length')).toBe(true);
    expect(ro('(function(){var d=document.doctype;return (d?d.name:"")+document.documentElement.outerHTML})()')).toBe(true);
    expect(ro('(() => { const out = []; let n = 0; n = n + 1; let acc = out; for (const x of document.links) acc = acc.concat([x.href]); return acc; })()')).toBe(true); // 식 안의 지역 변수 대입
    expect(ro('document.querySelector("details").open')).toBe(true);
    for (const t of ['window.innerWidth', "window['innerHeight']", 'window.getComputedStyle(document.body).color', 'new URL(location.href).pathname', 'window.top.location.href', 'top.location.hostname', 'document.location.search', 'frames.length', 'this.x', 'location.search', 'window.location.hostname', "document.location['pathname']", 'self.location.origin', 'location?.href', 'window?.location.hash', 'new URL(location.href).searchParams.get("q")']) expect(ro(t), t).toBe(true);
    for (const t of [
      '[...document.links].map(a => a.href).sort()',
      "Array.from(document.links).reverse().map(String)",
      "(() => { const xs = [3, 1]; return xs.sort((a, b) => a - b); })()",
      "[3, 1].sort()",
      "document.title.replace(/a/g, (m) => m.toUpperCase())",
      "document.title.replace(/a/, `b`)",
      "(() => { const up = (s) => s.toUpperCase(); return [...document.links].map(up).filter(Boolean); })()",
      "[...document.links].map(String)",
      "JSON.stringify({ a: 1 }, null, 2)",
      "JSON.parse('[1]', function (k, v) { return v; })",
      "Array.from(document.links, (a) => a.href)",
      "document.querySelector(window.sel)", // 값을 넘기는 자리는 그대로
    ]) expect(ro(t), t).toBe(true);
    expect(ro('(() => { const out = []; out.push(1); return out; })()')).toBe(false); // push 는 허락 목록 밖(알 수 없음)
    expect(ro('location.href')).toBe(true);
    expect(ro("document.title.replace(/a/g,'b')")).toBe(true);
    expect(ro('(()=>{let n=0; for(let i=0;i<3;i++) n+=i; return n})()')).toBe(true); // 지역 변수의 ++
    expect(ro('getComputedStyle(document.body).color')).toBe(true);
    expect(ro("JSON.stringify(Object.fromEntries(new URLSearchParams(location.search)))")).toBe(true);
    expect(ro("(() => { const up = (s) => s.toUpperCase(); return Array.from(document.links, (a) => up(a.text)).join(',') + Math.max(1, 2) + new Date().getTime; })()")).toBe(true); // 지역 함수 · 정적 함수
    expect(ro("[...document.querySelectorAll('li')].map((li) => li.textContent).filter(Boolean).sort().slice(0, 3)")).toBe(true);
  });
  test('바꾸는 식은 false(대입 · ++ · delete · 바꾸는 메서드 · 네트워크 · eval)', () => {
    for (const s of [
      "document.querySelector('b').click()",
      "document.title = 'x'",
      'location.href = "http://x/"',
      'location = "http://x/"',
      'window.x = 1',
      'counter++',
      '--counter',
      'delete window.foo',
      "document.body.appendChild(document.createElement('p'))",
      "document.forms[0].submit()",
      "document.forms[0].requestSubmit()",
      "el.dispatchEvent(new Event('click'))",
      "el.setAttribute('a','b')",
      "el.removeAttribute('a')",
      'el.remove()',
      'localStorage.setItem("a","b")',
      'localStorage.removeItem("a")',
      'localStorage.clear()',
      "history.pushState({}, '', '/x')",
      "history.replaceState({}, '', '/x')",
      "location.assign('/x')",
      "window.open('/x')",
      "document.write('x')",
      'el.focus()',
      'el.blur()',
      'window.scrollTo(0, 0)',
      'window.scrollBy(0, 5)',
      'el.scrollIntoView()',
      'video.play()',
      'video.pause()',
      'el.append(x)',
      'el.prepend(x)',
      'el.insertBefore(a, b)',
      'el.replaceWith(a)',
      'el.replaceChildren()',
      "fetch('/x')",
      "window.fetch('/x')",
      "new XMLHttpRequest()",
      "new WebSocket('ws://x')",
      "navigator.sendBeacon('/x')",
      "eval('1')",
      "new Function('return 1')()",
      "window['fetch']('/x')",
      "el['click']()",
      "el?.click()",
      "document.querySelector('b')[name]()",
      // 허락 목록 밖의 호출은 모두 알 수 없음 — 페이지가 정의한 함수 · call/apply/bind · 타이머 · location · history · assign
      'window.placeOrder()',
      'Cart.checkout()',
      'placeOrder()',
      'location.reload()',
      "location.replace('/x')",
      "window.location.replace('/x')",
      "document.location.assign('/x')",
      'history.back()',
      'history.go(-1)',
      'el.click.call(el)',
      'el.click.apply(el, [])',
      'el.click.bind(el)()',
      "setTimeout('x()', 0)",
      'setInterval(() => 1, 10)',
      'Object.assign(window, { a: 1 })',
      'window.close()',
      'new Image()',
      'new Notification("x")',
      '(() => { const f = () => 1; f = window.placeOrder; return f(); })()', // 지역 함수 이름에 다시 대입하면 더는 안 믿는다
      '((cb) => cb())(window.placeOrder)', // 매개변수로 받은 함수 호출
      'document.body.insertAdjacentHTML("beforeend", "x")',
      // location 을 속성 읽기 말고 다른 데 쓰면 알 수 없음(별칭 · 배열 · 괄호 · 옵셔널 체인 · 구조분해 · 인자)
      "(() => { const l = location; l.replace('/x'); return 1; })()",
      "[location][0].replace('/x')",
      "(window?.location).replace('/x')",
      "(() => { const { replace } = window.location; return replace; })()",
      "[1].map(() => 1).concat([self.location])",
      "String(globalThis.location)",
      // 전역 객체를 먼저 별칭으로 받아 location 막기를 돌아가기 · 어떤 x.location 이든 주소 객체
      "(() => { const w = window; const l = w.location; l.replace('/x'); return 1; })()",
      "(() => { const { location: l } = window; l.replace('/x'); return 1; })()",
      "(() => { const l = window.top.location; l.replace('/x'); return 1; })()",
      "(() => { const l = this.location; l.replace('/x'); return 1; })()",
      "(() => { const l = window['top']['location']; l.replace('/x'); return 1; })()",
      "(() => { const l = parent.location; return l; })()",
      "(() => { const w = self; return w.history; })()",
      '[window].length',
      'Object.keys(globalThis).concat(frames)',
      // 페이지 함수를 호출 없이 콜백 자리에 넘기기
      "document.querySelectorAll('button').forEach(window.placeOrder)",
      '[1].map(Cart.checkout)',
      '[1].filter(placeOrder)',
      '[1].reduce(window.go, 0)',
      '[1].sort(window.cmp)',
      "'a'.replace(/a/, window.go)",
      'Array.from(document.links, window.go)',
      'JSON.stringify({}, window.replacer)',
      // 페이지 배열을 제자리에서 바꾸기
      'window.items.sort()',
      'window.items.reverse()',
      'document.createElement("a")', // 모르는 메서드는 알 수 없음(안전 쪽)
    ]) {
      expect(ro(s), s).toBe(false);
    }
  });
  test('함수 식 · 약속 안의 바꾸는 호출도 잡는다', () => {
    expect(ro('async () => { await fetch("/x"); }')).toBe(false);
    expect(ro('() => { document.querySelector("b").click(); return 1; }')).toBe(false);
    expect(ro('() => Promise.resolve(1).then(() => document.title)')).toBe(false); // Promise · then 은 허락 목록 밖 — 알 수 없음
  });
  test('문법이 이상하거나 식을 빠져나가려는 글은 false', () => {
    expect(ro('document.title +')).toBe(false);
    expect(ro('1); fetch("/x"); (2')).toBe(false);
    expect(ro('1); })(); document.body.click(); (function(){ return (2')).toBe(false);
    expect(ro('')).toBe(false);
  });
});

describe('noPermissionPromptsFromEnv', () => {
  test('1 일 때만 켜진다', () => {
    expect(noPermissionPromptsFromEnv({ SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS: '1' })).toBe(true);
    expect(noPermissionPromptsFromEnv({ SAFARI_ATTRACTION_NO_PERMISSION_PROMPTS: '0' })).toBe(false);
    expect(noPermissionPromptsFromEnv({})).toBe(false);
  });
});

describe('createGateFromEnv(관문 손님)', () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** 시험용 유닉스 소켓 서버. onLine 이 받은 줄(JSON)에 답할 글을 돌려주고(null 이면 답 없음), 끊으라고 하면 끊는다. */
  async function serve(onLine: (req: Record<string, unknown>, sock: net.Socket) => string | null | 'hangup') {
    const dir = mkdtempSync(join(tmpdir(), 'sa-gate-'));
    dirs.push(dir);
    const path = join(dir, 'g.sock');
    const seen: Array<Record<string, unknown>> = [];
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        seen.push(req);
        const ans = onLine(req, sock);
        if (ans === 'hangup') sock.destroy();
        else if (ans !== null) sock.write(ans + '\n');
      });
      sock.on('error', () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, r));
    return { path, seen };
  }
  const req: GateRequest = { host: 'www.coupang.com', url: 'https://www.coupang.com/cart', action: 'click', target: '결제하기', value: '', irreversible: true };

  test('환경값 SAFARI_ATTRACTION_GATE 가 없으면 null(아무것도 묻지 않는다)', () => {
    expect(createGateFromEnv({})).toBeNull();
    expect(createGateFromEnv({ SAFARI_ATTRACTION_GATE_TOKEN: 'a'.repeat(64) })).toBeNull();
  });

  test('소켓에 v · token · id 를 붙인 한 줄 JSON 을 보내고 허락 답을 받는다', async () => {
    const token = 'ab'.repeat(32);
    const s = await serve((r) => JSON.stringify({ id: r.id, allow: true }));
    const gate = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s.path, SAFARI_ATTRACTION_GATE_TOKEN: token })!;
    expect(await gate.check(req)).toEqual({ allow: true });
    expect(s.seen).toHaveLength(1);
    const sent = s.seen[0]!;
    expect(sent).toMatchObject({ v: 1, token, host: 'www.coupang.com', url: 'https://www.coupang.com/cart', action: 'click', target: '결제하기', value: '', irreversible: true });
    expect(typeof sent.id).toBe('string');
    expect((sent.id as string).length).toBeGreaterThanOrEqual(8);
    await gate.check(req);
    expect(s.seen[1]!.id).not.toBe(sent.id); // 요청마다 새 id
  });

  test('거절 답은 reason 과 함께 allow:false', async () => {
    const s = await serve((r) => JSON.stringify({ id: r.id, allow: false, reason: '읽기만 허락한 사이트예요' }));
    const gate = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s.path, SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    expect(await gate.check(req)).toEqual({ allow: false, reason: '읽기만 허락한 사이트예요' });
  });

  test('다른 id 의 답은 무시하고 allow 가 true 가 아닌 답 · 깨진 답은 거절', async () => {
    const s = await serve((r) => JSON.stringify({ id: 'other', allow: true }) + '\n' + JSON.stringify({ id: r.id, allow: 'yes' }));
    const gate = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s.path, SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    expect((await gate.check(req)).allow).toBe(false);
    const s2 = await serve(() => 'not json');
    const gate2 = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s2.path, SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    expect((await gate2.check(req)).allow).toBe(false);
  });

  test('연결 실패(소켓 없음) · 답 전에 끊김은 거절(던지지 않는다)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-gate-'));
    dirs.push(dir);
    const none = createGateFromEnv({ SAFARI_ATTRACTION_GATE: join(dir, 'nope.sock'), SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    const r1 = await none.check(req);
    expect(r1.allow).toBe(false);
    expect(r1.reason).toMatch(/[가-힣]/);
    const s = await serve(() => 'hangup');
    const cut = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s.path, SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    const r2 = await cut.check(req);
    expect(r2.allow).toBe(false);
    expect(r2.reason).toMatch(/[가-힣]/);
  });

  test('기다림 상한은 310초(앱의 300초 답이 먼저 오도록) — 답이 없으면 그때 거절', async () => {
    expect(GATE_WAIT_LIMIT_MS).toBe(310_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await serve(() => null);
    const gate = createGateFromEnv({ SAFARI_ATTRACTION_GATE: s.path, SAFARI_ATTRACTION_GATE_TOKEN: 't' })!;
    let done: { allow: boolean; reason?: string } | undefined;
    const p = gate.check(req).then((r) => (done = r));
    for (let i = 0; i < 200 && s.seen.length === 0; i++) await new Promise<void>((r) => setImmediate(r)); // 서버가 줄을 받을 때까지
    expect(s.seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(309_000);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    expect(done!.allow).toBe(false);
    expect(done!.reason).toMatch(/[가-힣]/);
  });
});
