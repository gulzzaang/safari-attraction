import { MemoryHome, localDate, nfc } from "./home.js";

// ───────────────────────── 값 ─────────────────────────

const LIMIT_DEFAULT = 5;
const LIMIT_MAX = 50;
const SNIPPET_MAX = 300; // 글자 수
const OUTPUT_MAX_BYTES = 8192; // 기억 · 프로젝트 도구 한 번 출력 상한
const RECENCY_DAYS = 30;
const RECENCY_WEIGHT = 0.5;
const PROJECT_BOOST = 1.2;
const ROOTS = ["기억", "프로젝트"] as const;
const MORE_MARK = "… 더 있음";
const READ_BATCH = 16; // 한꺼번에 열어 읽는 파일 수(열린 파일 수 한도 보호)

export type SearchHit = { file: string; date?: string; score: number; snippet: string };
export type SearchOptions = { limit?: number; scope?: "all" | "memory" | "projects"; project?: string };

// ───────────────────────── 낱말 쪼개기 ─────────────────────────

/**
 * 한글 덩어리는 두 글자씩(한 글자 덩어리는 그 글자), 영문 · 숫자는 소문자 낱말(2자 이상), 나머지는 무시.
 * 먼저 NFC 로 맞춘다.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of nfc(text).toLowerCase().matchAll(/[가-힣]+|[a-z0-9]+/g)) {
    const w = m[0];
    if (w.charCodeAt(0) >= 0xac00) {
      if (w.length === 1) out.push(w);
      else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else if (w.length >= 2) {
      out.push(w);
    }
  }
  return out;
}

// ───────────────────────── 날짜 ─────────────────────────

const DATE_IN_NAME = /(\d{4})-(\d{2})-(\d{2})/;
const DATE_LINE = /^\s*-\s+(\d{4})-(\d{2})-(\d{2})(?!\d)/;

/** 실제로 있는 날짜(2026-13-45 같은 건 아님)면 `YYYY-MM-DD`, 아니면 undefined. */
function validDate(m: RegExpExecArray | null): string | undefined {
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `YYYY-MM-DD` 두 날짜 사이 일수(서머타임에 흔들리지 않게 UTC 로 센다). */
function daysBetween(from: string, to: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

// ───────────────────────── 색인 ─────────────────────────

type Para = { start: number; end: number; tokens: Set<string>; date: string };
type Entry = { mtimeMs: number; size: number; lines: string[]; paras: Para[] };

/** 색인에 넣을 파일인가: `.md` 로 끝나고, 점으로 시작하는 폴더 · 파일(임시 · iCloud 자리표시)이 길에 없다. */
function indexable(rel: string): boolean {
  return rel.endsWith(".md") && !rel.split("/").some((seg) => seg.startsWith("."));
}

/** 줄을 빈 줄로 나눠 문단으로 묶고 문단마다 낱말 집합 · 날짜를 단다(날짜: 파일 이름 → 첫 `- YYYY-MM-DD` 줄 → 수정 시각). */
function buildParas(rel: string, lines: string[], mtimeMs: number): Para[] {
  const fileDate = validDate(DATE_IN_NAME.exec(rel.slice(rel.lastIndexOf("/") + 1)));
  const mtimeDate = localDate(new Date(mtimeMs));
  const paras: Para[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    let date = fileDate;
    for (let i = start; !date && i < end; i++) date = validDate(DATE_LINE.exec(lines[i]));
    paras.push({ start, end, tokens: new Set(tokenize(lines.slice(start, end).join("\n"))), date: date ?? mtimeDate });
    start = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") close(i);
    else if (start < 0) start = i;
  }
  close(lines.length);
  return paras;
}

/** 중간을 줄이지 않고 뒤를 잘라 `max` 글자 안으로(잘리면 끝에 「…」). */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

/**
 * 기억 폴더(`기억/` · `프로젝트/` 아래 모든 .md, `일지/보관/` · `프로젝트/보관/` 포함)의 글 색인.
 * 파일 수정 시각이 바뀐 것만 다시 읽는다. 찾기는 문단 단위로 점수를 매긴다.
 */
export class MemoryIndex {
  private readonly files = new Map<string, Entry>();
  /** 낱말 → 그 낱말이 든 문단 수. */
  private readonly df = new Map<string, number>();
  private totalParas = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  /** `opts.now`: 「오늘」을 정하는 함수(시험용, 기본은 현재 시각). */
  constructor(
    private readonly home: MemoryHome,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /** 바뀐 파일만 다시 색인하고 지워진 파일은 뺀다. 동시에 불러도 차례로 돈다. */
  refresh(): Promise<void> {
    const run = this.queue.then(() => this.doRefresh());
    this.queue = run.catch(() => {});
    return run;
  }

  private async doRefresh(): Promise<void> {
    const walked = (await Promise.all(ROOTS.map((r) => this.home.walk(r)))).flat().filter((f) => indexable(f.rel));
    const present = new Set(walked.map((f) => f.rel));
    for (const rel of [...this.files.keys()]) {
      if (!present.has(rel)) this.drop(rel);
    }
    const changed = walked.filter((f) => {
      const old = this.files.get(f.rel);
      return !old || old.mtimeMs !== f.mtimeMs || old.size !== f.size;
    });
    for (let i = 0; i < changed.length; i += READ_BATCH) {
      const batch = changed.slice(i, i + READ_BATCH);
      const texts = await Promise.all(batch.map((f) => this.home.read(f.rel).catch(() => null)));
      batch.forEach((f, j) => {
        this.drop(f.rel);
        const text = texts[j];
        if (text === null) return; // 읽는 사이 지워졌거나 읽을 수 없는 파일(다음 refresh 에서 다시 시도).
        const lines = nfc(text).split(/\r?\n/);
        this.add(f.rel, { mtimeMs: f.mtimeMs, size: f.size, lines, paras: buildParas(f.rel, lines, f.mtimeMs) });
      });
    }
  }

  private add(rel: string, entry: Entry): void {
    this.files.set(rel, entry);
    for (const p of entry.paras) {
      this.totalParas++;
      for (const t of p.tokens) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  private drop(rel: string): void {
    const entry = this.files.get(rel);
    if (!entry) return;
    this.files.delete(rel);
    for (const p of entry.paras) {
      this.totalParas--;
      for (const t of p.tokens) {
        const n = (this.df.get(t) ?? 1) - 1;
        if (n <= 0) this.df.delete(t);
        else this.df.set(t, n);
      }
    }
  }

  /**
   * 질문과 겹치는 문단을 점수순으로(같으면 최근 날짜 → 파일 이름 순). 먼저 refresh 를 돌려 바뀐 파일을 반영한다.
   * 점수 = Σ(겹친 낱말마다 log(1 + 전체 문단 수 / 그 낱말이 든 문단 수)) × (1 + 0.5 × 최근도), 최근도 = max(0, 1 − 경과 일수/30).
   * `project` 를 주면 `프로젝트/<이름>/` 아래 문단의 점수에 ×1.2.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    await this.refresh();
    const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? LIMIT_DEFAULT) || LIMIT_DEFAULT));
    const weights = new Map<string, number>();
    for (const t of new Set(tokenize(query))) {
      const n = this.df.get(t);
      if (n) weights.set(t, Math.log(1 + this.totalParas / n));
    }
    if (weights.size === 0) return [];

    const scope = opts.scope ?? "all";
    const prefix = scope === "memory" ? "기억/" : scope === "projects" ? "프로젝트/" : "";
    const boostPrefix = opts.project ? `프로젝트/${nfc(opts.project)}/` : undefined;
    const today = localDate(this.now());

    type Cand = { rel: string; entry: Entry; para: Para; score: number };
    const cands: Cand[] = [];
    for (const [rel, entry] of this.files) {
      if (!rel.startsWith(prefix)) continue;
      const boost = boostPrefix && rel.startsWith(boostPrefix) ? PROJECT_BOOST : 1;
      for (const para of entry.paras) {
        let sum = 0;
        for (const [t, w] of weights) if (para.tokens.has(t)) sum += w;
        if (sum === 0) continue;
        const age = Math.max(0, daysBetween(para.date, today));
        const recency = Math.max(0, 1 - age / RECENCY_DAYS);
        cands.push({ rel, entry, para, score: sum * (1 + RECENCY_WEIGHT * recency) * boost });
      }
    }
    cands.sort(
      (a, b) =>
        b.score - a.score ||
        (a.para.date < b.para.date ? 1 : a.para.date > b.para.date ? -1 : 0) ||
        (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) ||
        a.para.start - b.para.start,
    );
    return cands.slice(0, limit).map((c) => ({
      file: c.rel,
      date: c.para.date,
      score: c.score,
      snippet: this.snippet(c.entry, c.para, weights),
    }));
  }

  /** 문단 안에서 가장 잘 맞은 줄(같으면 앞쪽)과 그 앞뒤 한 줄. 300자를 넘으면 맞은 줄만, 그래도 넘으면 자른다. */
  private snippet(entry: Entry, para: Para, weights: Map<string, number>): string {
    let best = para.start;
    let bestScore = -1;
    for (let i = para.start; i < para.end; i++) {
      const toks = new Set(tokenize(entry.lines[i]));
      let s = 0;
      for (const [t, w] of weights) if (toks.has(t)) s += w;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const line = (i: number) => entry.lines[i].trim();
    const around = [best - 1, best, best + 1].filter((i) => i >= para.start && i < para.end).map(line).join("\n");
    return Array.from(around).length <= SNIPPET_MAX ? around : clip(line(best), SNIPPET_MAX);
  }
}

// ───────────────────────── 보여 주기 ─────────────────────────

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** 글자 경계를 지키며 UTF-8 `max` 바이트 안으로 앞에서부터 자른다. */
function cutBytes(s: string, max: number): string {
  let used = 0;
  let out = "";
  for (const ch of s) {
    const n = bytes(ch);
    if (used + n > max) break;
    used += n;
    out += ch;
  }
  return out;
}

/** 찾은 것을 번호 · 파일 · 날짜 · 스니펫으로. 8KB(8,192 바이트)를 넘으면 뒤를 자르고 「… 더 있음」. */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "찾은 기억이 없어요.";
  const blocks = hits.map(
    (h, i) =>
      `${i + 1}. ${h.file}${h.date ? ` (${h.date})` : ""}\n` +
      h.snippet
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n"),
  );
  const all = blocks.join("\n");
  if (bytes(all) <= OUTPUT_MAX_BYTES) return all;

  const room = OUTPUT_MAX_BYTES - bytes("\n" + MORE_MARK);
  let out = "";
  for (const b of blocks) {
    const next = out ? `${out}\n${b}` : b;
    if (bytes(next) > room) break;
    out = next;
  }
  if (!out) return cutBytes(blocks[0], room) + "\n" + MORE_MARK; // 한 건만으로도 넘는 경우
  return `${out}\n${MORE_MARK}`;
}
