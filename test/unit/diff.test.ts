import { describe, expect, test } from 'vitest';
import { capSnapshot, diffSnapshot, SNAPSHOT_LIMIT_BYTES } from '../../src/snapshot/diff.js';
import { OutputBuffer } from '../../src/repl/output.js';
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
  // ---- 리뷰 반영: 줄 정체 · 사라진 뒤 다시 나타남 · 찍힌 것만 ----
  const raw = (sig: string, lines: string[], doc = 'd1', ttl = title) => [`#sa-meta scroll=${sig} doc=${doc}`, ttl, ...lines].join('\n');
  const cellsOf = (rows: number[]) => rows.flatMap((n) => [`- cell "사용자 ${n} 번"`, '- cell "Active"', '- cell "0원"']);

  test('I1: 같은 글의 칸(Active · 0원)이 다른 행에 또 나와도 새 행의 칸은 나온다', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, raw('0,0', cellsOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
    const r = s.diff('t', {}, raw('0,500', cellsOf([8, 9, 10, 11, 12, 13])));
    expect(r.mode).toBe('scroll');
    expect(r.text.split('\n').slice(1)).toEqual(cellsOf([11, 12, 13]));
  });

  test('I2-A: 체크박스 상태가 바뀐 채 돌아오면 바뀐 줄을 다시 보여 준다(ref 줄은 글까지 같아야 본 줄)', () => {
    const s = new SnapshotStore();
    const box = (checked: boolean) => `- checkbox "동의" [ref=e5]${checked ? ' [checked]' : ''}`;
    s.diff('t', {}, raw('0,0', [box(true), para(1), para(2)]));
    s.diff('t', {}, raw('0,500', [para(3), para(4)]));
    const back = s.diff('t', {}, raw('0,0', [box(false), para(1), para(2)]));
    expect(back.text.split('\n').slice(1)).toEqual([box(false)]);
  });

  test('I2-A2/C: 바뀐 곳으로 「사라짐」을 알린 줄은 다시 나타나면 새 줄로 보여 준다(토스트 · 탭 내용)', () => {
    const s = new SnapshotStore();
    const toast = '- button "닫기" [ref=e9]';
    const base = [1, 2, 3, 4, 5, 6, 7, 8].map(para);
    s.diff('t', {}, raw('0,0', [toast, ...base]));
    const gone = s.diff('t', {}, raw('0,0', base));
    expect(gone.mode).toBe('diff');
    expect(gone.text).toContain('- ' + toast);
    const back = s.diff('t', {}, raw('0,300', [toast, ...base]));
    expect(back.mode).toBe('scroll');
    expect(back.text.split('\n').slice(1)).toEqual([toast]);
    // 글 줄(ref 없음)도 마찬가지
    const s2 = new SnapshotStore();
    s2.diff('t', {}, raw('0,0', [...base, para(9)]));
    s2.diff('t', {}, raw('0,0', base)); // 문단 9 사라짐
    expect(s2.diff('t', {}, raw('0,300', [...base, para(9)])).text.split('\n').slice(1)).toEqual([para(9)]);
  });

  test('I2-B: 주소 · 제목이 바뀌었으면(같은 문서의 pushState) 내린 뒤 첫 줄을 늘 보여 주고, 같으면 안 보여 준다', () => {
    const s = new SnapshotStore();
    const tA = '- title: "A" [url=http://x/a]';
    const tB = '- title: "A" [url=http://x/b]';
    s.diff('t', {}, raw('0,0', [para(1), para(2)], 'd1', tA));
    const toB = s.diff('t', {}, raw('0,500', [para(1), para(2)], 'd1', tB));
    expect(toB.text.split('\n')).toEqual(['# 내린 뒤 새로 보이는 곳만 (이미 본 줄 2개 · 화면 밖으로 지나간 줄 0개 생략)', tB]);
    const backA = s.diff('t', {}, raw('0,0', [para(1), para(2)], 'd1', tA));
    expect(backA.text.split('\n')[1]).toBe(tA);
    expect(s.diff('t', {}, raw('0,500', [para(1), para(2)], 'd1', tA)).text).toBe(NOTHING); // 같은 주소면 안 보여 준다
  });

  test('I3: read 만으로는 기억이 바뀌지 않고, commit 해야 올라간다', () => {
    const s = new SnapshotStore();
    const p1 = s.read('t', {}, raw('0,0', [para(1), para(2)]));
    expect(s.last('t', {})).toBeUndefined();
    p1.commit();
    expect(s.last('t', {})).toBe(tree([1, 2]));
    const p2 = s.read('t', {}, raw('0,500', [para(2), para(3)]));
    expect(s.last('t', {})).toBe(tree([1, 2])); // 아직 그대로
    p2.settle('아무 상관 없는 출력'); // 하나도 안 보였다 → 올리지 않는다
    expect(s.last('t', {})).toBe(tree([1, 2]));
    p2.settle(p2.text); // 통째로 보였다
    expect(s.last('t', {})).toBe(tree([2, 3]));
  });

  test('I3: 앞부분만 보였으면 그 줄들만 읽은 것으로 치고, 잘려 못 본 줄은 다음에 나온다', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, raw('0,0', [para(1)]));
    const p = s.read('t', {}, raw('0,500', [para(10), para(11), para(12), para(13)]));
    p.settle(p.text.split('\n').slice(0, 3).join('\n')); // 머리 줄 + 문단 10 · 11 만 보임
    const next = s.diff('t', {}, raw('0,900', [para(10), para(11), para(12), para(13)]));
    expect(next.text.split('\n').slice(1)).toEqual([para(12), para(13)]);
  });

  test('I4: 스크롤 표시가 그대로면(자동으로 넘어가는 것이 화면 밖이라 표시에 안 든 경우) 내용이 바뀐 것은 +/- 로 알린다', () => {
    const s = new SnapshotStore();
    const lines = [1, 2, 3, 4, 5, 6, 7, 8].map(para);
    s.diff('t', {}, raw('0,0', lines));
    const r = s.diff('t', {}, raw('0,0', [...lines.slice(0, 7), para(99)]));
    expect(r.mode).toBe('diff');
    expect(r.text).toContain('- ' + para(8));
    expect(r.text).toContain('+ ' + para(99));
  });

  test('M2: 본 줄은 최대 50,000개까지만 기억하고 오래된 것부터 잊는다', () => {
    const s = new SnapshotStore();
    const link = (n: number) => `- link "항목 ${n}" [ref=e${n}]`;
    const all = Array.from({ length: 60000 }, (_, i) => link(i + 1));
    s.read('t', {}, raw('0,0', all)).commit(); // 자르기를 거치지 않고 통째로 읽은 것으로
    const r = s.diff('t', {}, raw('0,500', [link(1), link(60000)]));
    expect(r.text.split('\n').slice(1)).toEqual([link(1)]); // 맨 처음 것은 잊었고, 최근 것은 안다
  });

  test('M3: 새 문서에서 그대로인 줄을 이월하는 것은 맨 앞 줄(제목 · 주소)이 같을 때만', () => {
    const lines = [1, 2, 3, 4, 5, 6, 7, 8].map(para);
    const run = (ttl2: string) => {
      const s = new SnapshotStore();
      s.diff('t', {}, raw('0,0', lines));
      const reload = s.diff('t', {}, raw('0,0', [...lines.slice(0, 7), para(9)], 'd2', ttl2));
      expect(reload.mode).toBe('diff');
      return s.diff('t', {}, raw('0,500', [...lines.slice(2, 7), para(9)], 'd2', ttl2)).text;
    };
    expect(run(title)).toBe(NOTHING); // 같은 주소의 새로고침: 이월
    expect(run('- title: "다른" [url=http://y/]').split('\n').slice(1)).toContain(para(3)); // 다른 문서: 이월 안 함
  });
  test('N1: 화면 조각을 재활용해 같은 ref 에 다른 글이 오면 바로 뒤 줄도 새 줄이다(체크 토글의 이웃은 아니다)', () => {
    const s = new SnapshotStore();
    s.diff('t', {}, raw('0,0', ['- link "결과 11" [ref=e1]', '- paragraph "$10"']));
    const r = s.diff('t', {}, raw('0,500', ['- link "결과 21" [ref=e1]', '- paragraph "$10"']));
    expect(r.text.split('\n').slice(1)).toEqual(['- link "결과 21" [ref=e1]', '- paragraph "$10"']);
    // 체크박스(조작 요소)가 기준이면 글이 바뀌어도 이웃은 그대로 본 줄
    const s2 = new SnapshotStore();
    const box = (c: boolean) => `- checkbox "동의" [ref=e5]${c ? ' [checked]' : ''}`;
    s2.diff('t', {}, raw('0,0', [box(true), para(1)]));
    expect(s2.diff('t', {}, raw('0,500', [box(false), para(1)])).text.split('\n').slice(1)).toEqual([box(false)]);
  });

  test('N3: 같은 범위에서 두 번 읽어 둘 다 잘리면 나중 것부터 되돌려 기준이 처음으로 돌아온다', () => {
    const s = new SnapshotStore();
    const buf = new OutputBuffer();
    const a = s.read('t', {}, raw('0,0', [para(1), para(2)]));
    buf.watch(a);
    a.commit();
    const b = s.read('t', {}, raw('0,0', [para(1), para(3)]));
    buf.watch(b);
    b.commit();
    buf.log('가'.repeat(20000)); // 둘 다 16KB 밖으로 밀려 안 보인다
    buf.text();
    expect(s.last('t', {})).toBeUndefined();
  });
  // ---- 아래에 더 있음 안내 ----
  const HINT = (n: number) => `… 아래에 더 있음(약 ${n}줄) — 내려서 다시 읽거나 snapshot(page, {full: true})`;
  const withBelow = (sig: string, lines: string[], below: number, doc = 'd1') =>
    [`#sa-meta scroll=${sig} doc=${doc}${below ? ` below=${below}` : ''}`, title, ...lines].join('\n');

  test('아래: 처음 읽기(전체) · 변화 없음 · +/- · 내린 뒤 · 이미 읽은 곳 모두 끝에 안내 줄이 붙는다', () => {
    const s = new SnapshotStore();
    const base = [1, 2, 3, 4, 5, 6, 7, 8].map(para);
    const first = s.diff('t', {}, withBelow('0,0', base, 12));
    expect(first.mode).toBe('full');
    expect(first.text).toBe(tree([1, 2, 3, 4, 5, 6, 7, 8]) + '\n' + HINT(12));
    // 줄 수만 달라져도 비교에는 영향이 없다(변화 없음 + 안내)
    expect(s.diff('t', {}, withBelow('0,0', base, 30))).toEqual({ mode: 'none', text: '변화 없음\n' + HINT(30) });
    const diff = s.diff('t', {}, withBelow('0,0', [...base.slice(0, 7), para(9)], 30));
    expect(diff.mode).toBe('diff');
    expect(diff.text.endsWith('\n' + HINT(30))).toBe(true);
    const down = s.diff('t', {}, withBelow('0,600', [para(1), para(2)], 5));
    expect(down.mode).toBe('scroll');
    expect(down.text.endsWith('\n' + HINT(5))).toBe(true);
    expect(s.diff('t', {}, withBelow('0,0', [para(1), para(2)], 5)).text).toBe(NOTHING + '\n' + HINT(5));
  });

  test('아래: 0 이면 줄이 없고, 안내는 기억(마지막 글)에 들어가지 않는다', () => {
    const s = new SnapshotStore();
    const r = s.diff('t', {}, withBelow('0,0', [para(1)], 0));
    expect(r.text).toBe(tree([1]));
    s.diff('t', {}, withBelow('0,0', [para(1)], 9));
    expect(s.last('t', {})).toBe(tree([1]));
  });

  test('아래: full · selector 읽기에는 붙지 않는다, interactive 는 붙는다', () => {
    const s = new SnapshotStore();
    expect(s.diff('t', { full: true }, withBelow('0,0', [para(1)], 7)).text).toBe(tree([1]));
    expect(s.diff('t', { selector: '#x' }, withBelow('0,0', [para(1)], 7)).text).toBe(tree([1]));
    expect(s.diff('t', { interactive: true }, withBelow('0,0', [para(1)], 7)).text.endsWith(HINT(7))).toBe(true);
  });

  test('아래: 결과가 16KB 를 넘어 잘릴 때는(자른 안내로 충분) 붙이지 않는다', () => {
    const s = new SnapshotStore();
    const many = Array.from({ length: 700 }, (_, i) => para(i + 1));
    const r = s.diff('t', {}, withBelow('0,0', many, 40));
    expect(Buffer.byteLength(r.text)).toBeGreaterThan(SNAPSHOT_LIMIT_BYTES);
    expect(r.text).not.toContain('아래에 더 있음');
  });
});
