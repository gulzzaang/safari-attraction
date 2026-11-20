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

describe('SnapshotStore — 내리며 읽기', () => {
  const NOTHING = '새로 보이는 곳 없음(이미 읽은 곳)';
  const para = (n: number) => `- paragraph "문단 ${n} 은 화면에 따라 보이는 긴 글 입니다 입니다 입니다"`;
  const title = '- title: "시험" [url=http://x/]';
  /** 페이지 안 읽기 코드가 내는 글 모양: 맨 앞 안내 줄 + 머리 줄 + 줄들. */
  const page = (scrollY: number, nums: number[], doc = 'd1') => [`#sa-meta scroll=0,${scrollY} doc=${doc}`, title, ...nums.map(para)].join('\n');
  const tree = (nums: number[]) => [title, ...nums.map(para)].join('\n');

  test('처음엔 전체(안내 줄은 뺀다)', () => {
    const s = new SnapshotStore();
    expect(s.diff('t', {}, page(0, [1, 2, 3]))).toEqual({ mode: 'full', text: tree([1, 2, 3]) });
  });

  test('스크롤 그대로 · 내용 그대로면 변화 없음', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3]));
    expect(s.diff('t', {}, page(0, [1, 2, 3]))).toEqual({ mode: 'none', text: '변화 없음' });
  });

  test('스크롤 그대로 · 내용만 바뀌면 예전처럼 +/- 비교', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4, 5, 6, 7, 8]));
    const r = s.diff('t', {}, page(0, [1, 2, 3, 4, 5, 6, 7, 9]));
    expect(r.mode).toBe('diff');
    expect(r.text).toContain('# 바뀐 곳만(+ 생김 · - 사라짐)');
    expect(r.text).toContain('- ' + para(8));
    expect(r.text).toContain('+ ' + para(9));
  });

  test('내리면 처음 보이는 줄만, 머리 줄 · 개수 정확히 · 사라짐(-) 없음', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4]));
    const r = s.diff('t', {}, page(1000, [3, 4, 5, 6]));
    expect(r.mode).toBe('scroll');
    const lines = r.text.split('\n');
    // 이미 본 줄 2개(3 · 4), 화면 밖으로 지나간 줄 2개(1 · 2) — 머리 줄(title)은 세지 않는다
    expect(lines[0]).toBe('# 내린 뒤 새로 보이는 곳만 (이미 본 줄 2개 · 화면 밖으로 지나간 줄 2개 생략)');
    expect(lines.slice(1)).toEqual([para(5), para(6)]);
    expect(r.text).not.toMatch(/^- (?!paragraph)/m);
    expect(r.text).not.toContain(para(1));
    expect(r.text).not.toContain(para(2));
  });

  test('이미 읽은 곳으로 되돌아가면 「새로 보이는 곳 없음」', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4]));
    s.diff('t', {}, page(1000, [3, 4, 5, 6]));
    expect(s.diff('t', {}, page(0, [1, 2, 3, 4]))).toEqual({ mode: 'scroll', text: NOTHING });
    // 절반만 내려도(이미 본 줄뿐) 마찬가지
    expect(s.diff('t', {}, page(300, [2, 3, 4, 5]))).toEqual({ mode: 'scroll', text: NOTHING });
  });

  test('내린 뒤 같은 자리에서 다시 읽으면 변화 없음', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2]));
    s.diff('t', {}, page(1000, [3, 4]));
    expect(s.diff('t', {}, page(1000, [3, 4]))).toEqual({ mode: 'none', text: '변화 없음' });
  });

  test('이동 · 새로고침(문서 표식이 바뀜)이면 본 줄을 지운다', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4]));
    s.diff('t', {}, page(1000, [5, 6, 7, 8]));
    // 새 문서: 스크롤 위치가 달라도 「내린 뒤」로 보지 않고 예전 비교를 따른다
    const reload = s.diff('t', {}, page(0, [1, 2, 3, 4], 'd2'));
    expect(reload.mode).toBe('full');
    // 지운 뒤라 1~4 는 다시 새 줄이 아니라 방금 본 줄이다: 내려서 5~6 이 나오면 새 줄
    const r = s.diff('t', {}, page(1000, [3, 4, 5, 6], 'd2'));
    expect(r.text.split('\n').slice(1)).toEqual([para(5), para(6)]);
    // 새 문서에서 본 적 없는 줄이 이전 문서에서 본 줄이어도 새 줄로 나온다
    const s2 = new SnapshotStore();
    s2.diff('t', {}, page(0, [1, 2]));
    s2.diff('t', {}, page(1000, [5, 6]));
    s2.diff('t', {}, page(0, [7, 8], 'd9')); // 새 문서
    const back = s2.diff('t', {}, page(1000, [1, 2], 'd9'));
    expect(back.text.split('\n').slice(1)).toEqual([para(1), para(2)]);
  });

  test('탭 · 범위마다 따로: 다른 탭의 스크롤은 섞이지 않는다', () => {
    const s = new SnapshotStore();
    s.diff('a', {}, page(0, [1, 2]));
    s.diff('b', {}, page(500, [3, 4]));
    expect(s.diff('b', {}, page(500, [3, 4])).mode).toBe('none');
    expect(s.diff('a', {}, page(0, [1, 2])).mode).toBe('none');
    // interactive 는 같은 규칙을 따르되 기억은 따로
    s.diff('a', { interactive: true }, page(0, [1, 2]));
    expect(s.diff('a', { interactive: true }, page(900, [5, 6])).mode).toBe('scroll');
  });

  test('full 과 selector 는 스크롤에 상관없이 예전 그대로', () => {
    const s = new SnapshotStore();
    for (const o of [{ full: true }, { selector: '#x' }]) {
      s.diff('t', o, page(0, [1, 2, 3, 4, 5, 6, 7, 8]));
      const r = s.diff('t', o, page(1000, [1, 2, 3, 4, 5, 6, 7, 9]));
      expect(r.mode).toBe('diff');
      expect(r.text).toContain('- ' + para(8));
      expect(s.diff('t', o, page(2000, [1, 2, 3, 4, 5, 6, 7, 9]))).toEqual({ mode: 'none', text: '변화 없음' });
    }
  });

  test('안내 줄이 없는 글(옛 모양)은 예전 그대로', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, tree([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(s.diff('t', {}, tree([1, 2, 3, 4, 5, 6, 7, 9])).mode).toBe('diff');
  });

  test('last 는 안내 줄 없는 전체 글', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2]));
    expect(s.last('t', {})).toBe(tree([1, 2]));
  });

  test('섞인 경우(내리면서 내용도 바뀜)는 새 줄만, 사라진 줄은 알리지 않는다', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4]));
    const r = s.diff('t', {}, page(1000, [4, 5, 6, 7]));
    expect(r.text.split('\n').slice(1)).toEqual([para(5), para(6), para(7)]);
  });

  test('새 줄이 아주 많아도 16KB 를 넘지 않게 자를 수 있다', () => {
    const s = new SnapshotStore();
    const many = Array.from({ length: 1500 }, (_, i) => i + 100);
    s.diff('t', {}, page(0, [1, 2]));
    const r = s.diff('t', {}, page(1000, many));
    expect(Buffer.byteLength(r.text)).toBeGreaterThan(SNAPSHOT_LIMIT_BYTES);
    expect(Buffer.byteLength(capSnapshot(r.text))).toBeLessThanOrEqual(SNAPSHOT_LIMIT_BYTES);
  });
  test('안쪽 스크롤 영역만 움직여 서명이 달라져도 내린 것으로 본다', () => {
    const s = new SnapshotStore();
    const inner = (sig: string, nums: number[]) => [`#sa-meta scroll=${sig} doc=d1`, title, ...nums.map(para)].join('\n');
    s.diff('t', {}, inner('0,0', [1, 2, 3, 4]));
    const r = s.diff('t', {}, inner('0,0,300', [3, 4, 5, 6]));
    expect(r.mode).toBe('scroll');
    expect(r.text.split('\n').slice(1)).toEqual([para(5), para(6)]);
    // 같은 서명이면 그대로, 되돌리면 이미 읽은 곳
    expect(s.diff('t', {}, inner('0,0,300', [3, 4, 5, 6])).mode).toBe('none');
    expect(s.diff('t', {}, inner('0,0', [1, 2, 3, 4]))).toEqual({ mode: 'scroll', text: NOTHING });
  });

  test('16KB 에서 잘려 못 본 줄은 본 줄로 치지 않아 다음 읽기에서 나온다', () => {
    const s = new SnapshotStore();
    const all = Array.from({ length: 700 }, (_, i) => i + 1);
    const first = s.diff('t', {}, page(0, all));
    expect(first.mode).toBe('full');
    const shown = capSnapshot(first.text).split('\n').filter((l) => l.startsWith('- paragraph')).length; // 실제로 찍힌 문단 수
    expect(shown).toBeGreaterThan(100);
    expect(shown).toBeLessThan(all.length);
    // 내린 뒤: 같은 줄들이 그대로 보여도(스크롤 위치만 다름) 잘려 못 본 줄은 새 줄로 나온다
    const r = s.diff('t', {}, page(1000, all));
    expect(r.mode).toBe('scroll');
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(`# 내린 뒤 새로 보이는 곳만 (이미 본 줄 ${shown}개 · 화면 밖으로 지나간 줄 0개 생략)`);
    expect(lines[1]).toBe(para(shown + 1));
    expect(lines.length - 1).toBe(all.length - shown);
  });

  test('새로고침 뒤 「변화 없음」이면 그대로인 줄은 읽은 줄로 둔다', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, page(0, [1, 2, 3, 4]));
    expect(s.diff('t', {}, page(0, [1, 2, 3, 4], 'd2')).mode).toBe('none');
    expect(s.diff('t', {}, page(1000, [3, 4, 5, 6], 'd2')).text.split('\n').slice(1)).toEqual([para(5), para(6)]);
  });
});
