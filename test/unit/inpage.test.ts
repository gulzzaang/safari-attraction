import { expect, test } from 'vitest';
import { buildSnapshotSource } from '../../src/snapshot/inpage.js';

test('페이지 안에서 돌릴 원문은 문법이 맞는 식 하나다', () => {
  for (const o of [{}, { interactive: true }, { selector: 'main > "x"\n', full: true }]) {
    const src = buildSnapshotSource(o);
    expect(() => new Function(`return ${src}`)).not.toThrow(); // 파싱만 한다(돌리지는 않는다)
    expect(src.startsWith('(function')).toBe(true);
    expect(src.endsWith(')')).toBe(true);
  }
});

test('옵션이 그대로 들어간다', () => {
  const src = buildSnapshotSource({ selector: '#a "b"', interactive: true });
  expect(src).toContain(JSON.stringify({ interactive: true, selector: '#a "b"', full: false }));
});

test('읽기 · 조작 원문 모두 같은 깊이 우선 찾기 함수를 품고, 조작 원문도 문법이 맞는다', async () => {
  const { buildActionSource } = await import('../../src/repl/inpage-actions.js');
  for (const src of [buildSnapshotSource({ selector: 'e3' }), buildActionSource('click', { ref: 'e1', tok: 't' })]) {
    expect(src).toContain('function __saDeepQuery(');
    expect(src).toContain('function __saDeepAll(');
    expect(() => new Function(`return ${src}`)).not.toThrow();
  }
});

test('desc(동작 관문이 읽는 요소 설명): 문법이 맞고, 가짜 DOM 에서 초점 요소의 글 · 비밀번호 칸 · 폼 제출 단추 글을 돌려준다', async () => {
  const vm = await import('node:vm');
  const { buildActionSource } = await import('../../src/repl/inpage-actions.js');
  const src = buildActionSource('desc', { tok: 't' });
  expect(() => new Function(`return ${src}`)).not.toThrow();
  const attrs = (o: Record<string, string>) => (n: string) => (n in o ? o[n]! : null);
  const doc: Record<string, unknown> = { getElementById: () => null };
  const body = { tagName: 'BODY', ownerDocument: doc };
  const html = { tagName: 'HTML', ownerDocument: doc };
  doc.body = body;
  doc.documentElement = html;
  const submit = { tagName: 'BUTTON', type: 'submit', innerText: ' 주문하기 ', textContent: '주문하기', getAttribute: attrs({}), ownerDocument: doc, labels: [] };
  const form = { querySelectorAll: () => [submit] };
  const pw = { tagName: 'INPUT', type: 'password', value: 'hunter2', id: '', form, getAttribute: attrs({ 'aria-label': '비밀번호', name: 'pw' }), closest: () => null, ownerDocument: doc, labels: [] };
  const run = (active: unknown) => {
    doc.activeElement = active;
    const win: Record<string, unknown> = { addEventListener() {}, removeEventListener() {}, setTimeout, document: doc, navigation: undefined };
    const ctx = vm.createContext({ window: win, document: doc, location: { href: 'http://x/' }, MutationObserver: class {}, URL, Array, String, Object, JSON, Error, Math });
    return JSON.parse(vm.runInContext(src, ctx)) as { ok: boolean; r?: { v?: Record<string, unknown> }; err?: string };
  };
  const a = run(pw);
  expect(a.ok, a.err).toBe(true);
  expect(a.r!.v).toMatchObject({ aria: '비밀번호', isPassword: true, inputType: 'password', formSubmitText: '주문하기', value: '' }); // 비밀번호 값은 읽지 않는다
  expect(JSON.stringify(a)).not.toContain('hunter2');
  const none = run(body); // 초점이 없으면 body — 글 · 폼 없음
  expect(none.r!.v).toMatchObject({ text: '', isPassword: false, formSubmitText: '' });
});
