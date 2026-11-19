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
