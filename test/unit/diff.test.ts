import { describe, expect, test } from 'vitest';
import { capSnapshot, diffSnapshot, SNAPSHOT_LIMIT_BYTES } from '../../src/snapshot/diff.js';
import { SnapshotStore } from '../../src/snapshot/store.js';

const a = ['- title: "시험" [url=http://x/]', '- heading "제목"', '- button "저장" [ref=e1]', '- link "목록" [ref=e2]'].join('\n');

describe('diffSnapshot', () => {
  test('같으면 none 과 「변화 없음」', () => expect(diffSnapshot(a, a)).toEqual({ mode: 'none', text: '변화 없음' }));

  test('이전이 없으면 full 그대로', () => expect(diffSnapshot(undefined, a)).toEqual({ mode: 'full', text: a }));

  test('조금 바뀌면 diff', () => {
    const r = diffSnapshot(a, a + '\n- button "새 단추" [ref=e99]');
    expect(r.mode).toBe('diff');
    expect(r.text).toContain('+ - button "새 단추"');
    expect(r.text).not.toContain('저장'); // 그대로인 줄은 싣지 않는다
  });

  test('사라진 줄은 - 로 보인다', () => {
    const big = Array.from({ length: 20 }, (_, i) => `- paragraph "줄 번호 ${i} 는 길게 길게 적는다"`).join('\n');
    const r = diffSnapshot(big, big.split('\n').filter((_, i) => i !== 7).join('\n'));
    expect(r.mode).toBe('diff');
    expect(r.text).toContain('- - paragraph "줄 번호 7 는');
  });

  test('많이 바뀌면 full(바뀐 곳이 전체보다 길 때)', () => {
    const b = ['- title: "다른 쪽" [url=http://y/]', '- heading "전혀 다른 글"', '- button "삭제" [ref=e7]'].join('\n');
    expect(diffSnapshot(a, b)).toEqual({ mode: 'full', text: b });
  });

  test('줄이 아주 많아도 느려지지 않는다', () => {
    const lines = (p: string) => Array.from({ length: 3000 }, (_, i) => `- paragraph "${p}${i}"`).join('\n');
    const t0 = Date.now();
    const r = diffSnapshot(lines('가'), lines('나'));
    expect(r.mode).toBe('full');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('capSnapshot', () => {
  const NOTE = '… [16KB 에서 자름: interactive 또는 selector 로 좁히세요]';

  test('16KB 에서 자르고 안내를 붙인다', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `- paragraph "가나다라마바사 ${i}"`).join('\n');
    expect(Buffer.byteLength(text)).toBeGreaterThan(20000);
    const out = capSnapshot(text);
    expect(SNAPSHOT_LIMIT_BYTES).toBe(16384);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(16384);
    expect(out.endsWith(NOTE)).toBe(true);
    expect(out).not.toContain('�');
  });

  test('줄 중간이 아니라 줄 끝에서 자른다', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `- paragraph "가나다라마바사 ${i}"`).join('\n');
    const body = capSnapshot(text).slice(0, -NOTE.length - 1);
    for (const l of body.split('\n')) expect(l).toMatch(/^- paragraph "가나다라마바사 \d+"$/);
  });

  test('한 줄이 16KB 를 넘어도 글자를 깨뜨리지 않고 자른다', () => {
    const out = capSnapshot('가'.repeat(10000));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(16384);
    expect(out.endsWith(NOTE)).toBe(true);
    expect(out).not.toContain('�');
  });

  test('한도 안이면 그대로', () => {
    expect(capSnapshot(a)).toBe(a);
    const exact = 'a'.repeat(16384);
    expect(capSnapshot(exact)).toBe(exact);
  });
});

describe('SnapshotStore', () => {
  test('탭 · selector · interactive 마다 따로 기억한다', () => {
    const s = new SnapshotStore();
    s.remember('t1', {}, 'A');
    s.remember('t1', { interactive: true }, 'B');
    s.remember('t1', { selector: '#x' }, 'C');
    s.remember('t2', {}, 'D');
    expect(s.last('t1', {})).toBe('A');
    expect(s.last('t1', { interactive: true })).toBe('B');
    expect(s.last('t1', { selector: '#x' })).toBe('C');
    expect(s.last('t2', {})).toBe('D');
    expect(s.last('t3', {})).toBeUndefined();
  });

  test('diff 를 구하며 기억한다', () => {
    const s = new SnapshotStore();
    expect(s.diff('t1', {}, a).mode).toBe('full');
    expect(s.diff('t1', {}, a)).toEqual({ mode: 'none', text: '변화 없음' });
    expect(s.diff('t1', {}, a + '\n- button "새" [ref=e9]').mode).toBe('diff');
    expect(s.last('t1', {})).toContain('e9'); // 기억하는 것은 자르지 않은 전체
  });

  test('forget 은 그 탭만 지운다', () => {
    const s = new SnapshotStore();
    s.remember('t1', {}, 'A');
    s.remember('t2', {}, 'B');
    s.forget('t1');
    expect(s.last('t1', {})).toBeUndefined();
    expect(s.last('t2', {})).toBe('B');
  });
});
