/** 읽기 결과를 한 번에 돌려줄 수 있는 최대 크기(UTF-8 바이트). 한글은 한 글자에 3바이트다. */
export const SNAPSHOT_LIMIT_BYTES = 16384;

export const NO_CHANGE_TEXT = "변화 없음";
export const SCROLL_NOTHING_NEW_TEXT = "새로 보이는 곳 없음(이미 읽은 곳)";
export const TRUNCATION_NOTE = "… [16KB 에서 자름: interactive 또는 selector 로 좁히세요]";

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** 줄 수가 이보다 많아 보이면 정밀한 비교(LCS) 대신 빠른 비교로 간다. */
const LCS_CELL_LIMIT = 4_000_000;

type Op = { kind: "+" | "-"; line: string };

/** 줄 단위로 비교해 사라진 줄(-)과 생긴 줄(+)을 문서 순서대로 낸다. */
function lineOps(prev: string[], next: string[]): Op[] {
  // 앞뒤로 같은 줄은 비교에서 뺀다.
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const a = prev.slice(head, prev.length - tail);
  const b = next.slice(head, next.length - tail);

  if (a.length * b.length > LCS_CELL_LIMIT) return setOps(a, b);

  // 가장 긴 공통 부분열. dp[i][j] = a[i..], b[j..] 의 길이.
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) ops.push({ kind: "-", line: a[i++]! });
    else ops.push({ kind: "+", line: b[j++]! });
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

/** 아주 긴 글용 빠른 비교: 줄의 개수만 맞춰 본다(순서는 보지 않는다). */
function setOps(a: string[], b: string[]): Op[] {
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  const ops: Op[] = [];
  const keep = new Map(count);
  for (const l of b) {
    const n = keep.get(l) ?? 0;
    if (n > 0) keep.set(l, n - 1);
    else ops.push({ kind: "+", line: l });
  }
  const seen = new Map<string, number>();
  for (const l of b) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const l of a) {
    const n = seen.get(l) ?? 0;
    if (n > 0) seen.set(l, n - 1);
    else ops.push({ kind: "-", line: l });
  }
  return ops;
}

/**
 * 지난번 읽기(prev)와 이번 읽기(next)를 줄 단위로 비교한다.
 * 같으면 none, 바뀐 곳만 적은 글이 전체보다 짧으면 diff(`+ 줄` 생김 · `- 줄` 사라짐), 아니면 full(next 그대로).
 * 자르기(capSnapshot)는 부르는 쪽이 한다 — 비교는 자르지 않은 전체로 해야 맞다.
 */
export function diffSnapshot(prev: string | undefined, next: string): { text: string; mode: "full" | "diff" | "none" } {
  if (prev === undefined) return { text: next, mode: "full" };
  if (prev === next) return { text: NO_CHANGE_TEXT, mode: "none" };
  const ops = lineOps(prev.split("\n"), next.split("\n"));
  const diff = ["# 바뀐 곳만(+ 생김 · - 사라짐)", ...ops.map((o) => `${o.kind} ${o.line}`)].join("\n");
  if (byteLen(diff) >= byteLen(next)) return { text: next, mode: "full" };
  return { text: diff, mode: "diff" };
}

const TITLE_PREFIX = "- title: ";

/**
 * 내린(스크롤한) 뒤의 읽기: 이번 화면 줄 가운데 이 문서에서 아직 한 번도 보여 주지 않은 줄(seen 에 없는 줄)만 낸다.
 * 화면 밖으로 지나간 줄은 사라진 게 아니므로 싣지 않고 개수만 머리 줄에 적는다. seen 은 바꾸지 않는다(부르는 쪽 몫).
 * 머리의 `- title:` 줄은 개수에 넣지 않는다(바뀌었으면 새 줄로 싣는다).
 */
export function scrollDiffSnapshot(prev: string, next: string, seen: ReadonlySet<string>): { text: string; mode: "scroll" } {
  const isTitle = (l: string, i: number): boolean => i === 0 && l.startsWith(TITLE_PREFIX);
  const cur = next.split("\n");
  const curSet = new Set(cur);
  const fresh: string[] = [];
  let already = 0;
  cur.forEach((l, i) => {
    if (!seen.has(l)) fresh.push(l);
    else if (!isTitle(l, i)) already++;
  });
  const passed = prev.split("\n").filter((l, i) => !curSet.has(l) && !isTitle(l, i)).length;
  if (fresh.length === 0) return { text: SCROLL_NOTHING_NEW_TEXT, mode: "scroll" };
  const head = `# 내린 뒤 새로 보이는 곳만 (이미 본 줄 ${already}개 · 화면 밖으로 지나간 줄 ${passed}개 생략)`;
  return { text: [head, ...fresh].join("\n"), mode: "scroll" };
}

/** UTF-8 로 maxBytes 를 넘지 않게, 글자를 깨뜨리지 않고 앞에서 자른다. */
function sliceBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const n = byteLen(ch);
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * 글이 SNAPSHOT_LIMIT_BYTES 를 넘으면 줄 끝에서(한 줄이 너무 길면 글자 끝에서) 자르고 안내 문구를 붙인다.
 * 읽기 결과 말고 다른 출력(REPL 등)에도 쓰므로 읽기 결과의 모양을 가정하지 않는다.
 */
export function capSnapshot(text: string): string {
  if (byteLen(text) <= SNAPSHOT_LIMIT_BYTES) return text;
  const note = "\n" + TRUNCATION_NOTE;
  const budget = SNAPSHOT_LIMIT_BYTES - byteLen(note);
  const head = sliceBytes(text, budget);
  // 줄 끝에서 자를 수 있으면 거기서 자른다(바로 다음 글자가 줄바꿈이면 head 가 이미 온전한 줄들이다).
  const nextCh = text.slice(head.length, head.length + 1);
  const cut = nextCh === "\n" ? head.length : head.lastIndexOf("\n");
  const body = cut > 0 ? head.slice(0, cut) : head;
  return body + note;
}
