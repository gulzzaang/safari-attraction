import { createHash } from "node:crypto";
import { capSnapshot, diffDetailed, scrollDiffSnapshot, SNAPSHOT_LIMIT_BYTES, type DiffMode } from "./diff.js";
import type { SnapshotOptions } from "./inpage.js";

const META_PREFIX = "#sa-meta ";

/** 페이지 안 읽기 코드가 맨 앞에 붙인 안내 줄(`#sa-meta scroll=표시 doc=아이디`)을 떼어 낸다. 없으면 그대로. */
export function splitSnapshotMeta(raw: string): { tree: string; scroll?: string; doc?: string; below?: number } {
  if (!raw.startsWith(META_PREFIX)) return { tree: raw };
  const nl = raw.indexOf("\n");
  const line = nl < 0 ? raw : raw.slice(0, nl);
  const tree = nl < 0 ? "" : raw.slice(nl + 1);
  const scroll = /(?:^| )scroll=(\S+)/.exec(line)?.[1];
  const doc = /(?:^| )doc=(\S+)/.exec(line)?.[1];
  const b = /(?:^| )below=(\d+)/.exec(line)?.[1];
  return { tree, scroll, doc, below: b ? Number(b) : undefined };
}

/** 화면 아래에 읽을 것이 더 있을 때 읽기 결과 맨 끝에 붙이는 안내 줄. 비교 · 기억에는 들어가지 않는다. */
export const moreBelowHint = (n: number): string => `… 아래에 더 있음(약 ${n}줄) — 내려서 다시 읽거나 snapshot(page, {full: true})`;

/** 한 읽기 범위에서 기억하는 「본 줄」의 최대 개수. 넘으면 오래된 것부터 잊는다. */
export const MAX_SEEN = 50_000;

/** ref 없는 줄을 글만으로 찾는 기억의 접두어(화면 맨 위 첫 줄 전용). */
const PLAIN = "p:";
const REF_RE = /\[ref=(e\d+)\](?!.*\[ref=e)/;
/** 값이 글자 하나로 바뀔 수 있는 조작 요소(체크 · 입력칸 등). 이런 ref 줄이 기준 줄일 때는 글이 바뀌어도 같은 기준으로 본다. */
const FORM_ROLE_RE = /^\s*- (?:checkbox|radio|textbox|combobox|slider|file) /;

/** 기억이 커지지 않게 긴 글 대신 짧은 해시를 쓴다(96비트라 겹칠 일이 없다). */
const short = (s: string): string => createHash("sha1").update(s).digest("base64url").slice(0, 16);
const plainKey = (line: string): string => PLAIN + short(line);

/**
 * 줄마다 정체(key)와 값(val)을 낸다. ref 가 있는 줄은 ref 로(같은 요소가 같은 글이면 같은 줄), ref 가 없는 줄은
 * 「바로 위의 기준 줄」과 그 줄에서 떨어진 정도로 가린다 — 표의 「Active」 · 「0원」 칸처럼 같은 글이 다른 행에 또 나와도
 * 다른 줄이 되도록. 기준 줄은 위쪽에서 가장 가까운, 이번 글 안에서 한 번만 나오는 줄(ref 줄 · 머리 줄 · 제목 칸 등)이고,
 * ref 줄은 글이 바뀌어도(체크 상태 등) 기준으로서는 같게 본다.
 */
function identities(lines: string[]): Array<{ key: string; val: string }> {
  const count = new Map<string, number>();
  for (const l of lines) count.set(l, (count.get(l) ?? 0) + 1);
  const out: Array<{ key: string; val: string }> = [];
  let anchor = "";
  let anchorAt = -1;
  lines.forEach((l, i) => {
    const m = REF_RE.exec(l);
    if (m) {
      out.push({ key: "r:" + m[1], val: short(l) });
      // 화면 조각을 재활용하는 목록(같은 ref 에 다른 글)에서 뒤 줄이 가려지지 않게, 조작 요소가 아니면 기준에 글의 해시도 넣는다.
      anchor = "r:" + m[1] + (FORM_ROLE_RE.test(l) ? "" : "#" + short(l));
      anchorAt = i;
      return;
    }
    out.push({ key: "t:" + short(anchor + "\n" + (i - anchorAt) + "\n" + l), val: "" });
    if (count.get(l) === 1) {
      anchor = "u:" + l;
      anchorAt = i;
    }
  });
  return out;
}

type Seen = Map<string, string>;

function remember(seen: Seen, key: string, val: string): void {
  seen.delete(key); // 다시 넣어 가장 최근 것으로
  seen.set(key, val);
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value as string);
}

interface Memory {
  /** 지난번에 기억한 자르지 않은 전체 글(안내 줄 뺀 것). */
  tree: string;
  /** 지난번 읽을 때의 스크롤 표시. */
  scroll?: string;
  /** 지난번 문서의 표식(이동 · 새로고침이면 바뀐다). */
  doc?: string;
  /** 이 문서에서 Claude 에게 이미 보여 준 줄(정체 → 글). */
  seen: Seen;
}

/**
 * 읽은 결과와, 그 결과를 「Claude 가 읽었다」고 기억에 올리는 일(commit). 읽기만 해서는 기억이 바뀌지 않고,
 * 실제로 찍힌 것만 올린다. 찍은 글이 16KB 로 잘렸으면 settle 이 잘려 나간 줄을 도로 뺀다.
 */
export class PendingRead {
  private committed = false;
  private undoAll: Array<() => void> = [];
  constructor(
    readonly text: string,
    readonly mode: DiffMode | "scroll",
    private readonly apply: (undoAdd: (pos: number, f: () => void) => void, undoRest: (f: () => void) => void) => void,
  ) {}

  /** 기억에 올린다(한 번만). */
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    const added: Array<{ pos: number; f: () => void }> = [];
    this.apply((pos, f) => added.push({ pos, f }), (f) => this.undoAll.push(f));
    this.added_ = added;
  }
  private added_: Array<{ pos: number; f: () => void }> = [];

  /** 글의 앞 keep 줄만 실제로 보였다고 보고 나머지를 도로 뺀다. keep 이 0 이면 올린 것 전부를 되돌린다. */
  private rollback(keep: number): void {
    if (!this.committed) return;
    for (const a of [...this.added_].reverse()) if (a.pos >= keep) a.f();
    if (keep <= 0) for (const f of [...this.undoAll].reverse()) f();
    this.added_ = this.added_.filter((a) => a.pos < keep);
    if (keep <= 0) this.committed = false;
  }

  /**
   * 이 읽기 글이 실제로 찍힌 최종 출력(output)에 얼마나 들어 있나로 기억을 맞춘다:
   * 통째로 있으면 올리고(아직 안 올렸으면), 앞부분만 있으면 그만큼만, 하나도 없으면 올리지 않는다(올렸으면 되돌린다).
   */
  settle(output: string): void {
    const lines = this.text.split("\n");
    let keep = lines.length;
    if (!output.includes(this.text)) {
      let lo = 0;
      let hi = lines.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (output.includes(lines.slice(0, mid).join("\n"))) lo = mid;
        else hi = mid - 1;
      }
      keep = lo;
    }
    if (keep <= 0) return this.rollback(0);
    this.commit();
    if (keep < lines.length) this.rollback(keep);
  }
}

/**
 * 같은 탭의 같은 읽기(범위 · 요소만 보기 · 문서 전체 여부)를 이어서 비교하려고, 마지막으로 보여 준 결과를 기억한다.
 * 화면 기준 읽기(요소만 보기 · 문서 전체가 아닌 것)는 스크롤 표시와 본 줄도 기억해, 내린 뒤에는 새로 보이는 줄만 낸다.
 */
export class SnapshotStore {
  private readonly mem_ = new Map<string, Memory>();

  private key(tabKey: string, o: SnapshotOptions): string {
    return JSON.stringify([tabKey, o.selector ?? "", !!o.interactive, !!o.full]);
  }

  /** 지난번에 기억한 자르지 않은 전체 글. 없으면 undefined. */
  last(tabKey: string, o: SnapshotOptions): string | undefined {
    return this.mem_.get(this.key(tabKey, o))?.tree;
  }

  remember(tabKey: string, o: SnapshotOptions, text: string): void {
    const m = splitSnapshotMeta(text);
    const prev = this.mem_.get(this.key(tabKey, o));
    this.mem_.set(this.key(tabKey, o), { tree: m.tree, scroll: m.scroll, doc: m.doc, seen: prev?.seen ?? new Map() });
  }

  /**
   * 지난번과 비교한 결과를 낸다(아직 기억에 올리지 않는다 — PendingRead.commit 이 올린다).
   * next 는 페이지 안 읽기 결과 그대로(안내 줄이 있어도 된다).
   * 스크롤 표시가 지난번과 달라졌으면(화면 기준 읽기에서만) 아직 보여 주지 않은 줄만 낸다.
   */
  read(tabKey: string, o: SnapshotOptions, next: string): PendingRead {
    const k = this.key(tabKey, o);
    const cur = splitSnapshotMeta(next);
    const curLines = cur.tree.split("\n");
    const old = this.mem_.get(k);
    const viewBased = !o.full && !o.selector;
    const newDoc = !!old && old.doc !== undefined && cur.doc !== undefined && old.doc !== cur.doc;
    const scrolled = viewBased && !!old && !newDoc && old.scroll !== undefined && cur.scroll !== undefined && old.scroll !== cur.scroll;
    const oldLines = old ? old.tree.split("\n") : [];
    const baseSeen: Seen = !old || newDoc ? new Map() : old.seen;
    const curIds = identities(curLines);
    const oldIds = old ? identities(oldLines) : [];
    const isSeen = (l: string, i: number): boolean => {
      const id = curIds[i]!;
      if (baseSeen.get(id.key) === id.val) return true;
      // 화면 맨 위 첫 줄은 윗줄이 (화면 밖이라) 늘 머리 줄로 바뀌어 보이므로, ref 없는 줄은 글만 같아도 본 줄로 친다.
      return i === 1 && !REF_RE.test(l) && baseSeen.has(plainKey(l));
    };

    let text: string;
    let mode: DiffMode | "scroll";
    /** 글의 줄 위치 → 이번 글의 줄 번호(그 줄이 이번에 새로 보여 주는 줄일 때). */
    let items: Array<number | null> = [];
    /** 사라졌다고 알린 줄(지난번 글의 줄 번호). */
    let removed: number[] = [];
    if (scrolled) {
      const r = scrollDiffSnapshot(old.tree, cur.tree, isSeen);
      text = r.text;
      mode = "scroll";
      items = r.freshIdx.length ? [null, ...r.freshIdx] : [];
    } else {
      const r = diffDetailed(old?.tree, cur.tree);
      text = r.text;
      mode = r.mode;
      if (r.mode === "full") items = curLines.map((_, i) => i);
      else if (r.mode === "diff") items = [null, ...r.ops!.map((op) => (op.kind === "+" ? op.idx : null))];
      if (r.ops) removed = r.ops.filter((op) => op.kind === "-").map((op) => op.idx);
    }

    // 아래에 더 있다는 안내(화면 기준 읽기만). 결과가 이미 16KB 를 넘어 잘리거나 붙이면 넘으면 붙이지 않는다(자른 안내로 충분).
    if (viewBased && cur.below) {
      const withHint = text + "\n" + moreBelowHint(cur.below);
      if (Buffer.byteLength(withHint, "utf8") <= SNAPSHOT_LIMIT_BYTES) text = withHint;
    }

    const apply = (undoAdd: (pos: number, f: () => void) => void, undoRest: (f: () => void) => void): void => {
      let seen = baseSeen;
      const prevMem = old;
      if (viewBased) {
        if (newDoc) {
          seen = new Map();
          // 새 문서라도 맨 앞 줄(제목 · 주소)이 같고 「변화 없음」 · 바뀐 곳만으로 알렸다면 그대로인 줄은 이미 읽은 줄이다.
          if (old && oldLines[0] === curLines[0] && (mode === "none" || mode === "diff")) {
            curLines.forEach((_, i) => {
              const id = curIds[i]!;
              if (old.seen.get(id.key) !== id.val) return;
              remember(seen, id.key, id.val);
              if (id.key.startsWith("t:")) remember(seen, plainKey(curLines[i]!), "");
            });
          }
        }
        // 사라졌다고 알린 줄은 본 줄에서 뺀다(다시 나타나면 새로 보여 준다).
        for (const j of removed) {
          const id = oldIds[j]!;
          const keys = id.key.startsWith("t:") ? [id.key, plainKey(oldLines[j]!)] : [id.key];
          for (const key of keys) {
            if (!seen.has(key)) continue;
            const was = seen.get(key)!;
            seen.delete(key);
            undoRest(() => remember(seen, key, was));
          }
        }
        // 이번에 실제로 보여 준 줄을 더한다.
        items.forEach((idx, pos) => {
          if (idx === null) return;
          const id = curIds[idx]!;
          const entries: Array<[string, string]> = [[id.key, id.val]];
          if (id.key.startsWith("t:")) entries.push([plainKey(curLines[idx]!), ""]);
          for (const [key, val] of entries) {
            const was = seen.get(key);
            remember(seen, key, val);
            undoAdd(pos, () => (was === undefined ? seen.delete(key) : remember(seen, key, was)));
          }
        });
      }
      this.mem_.set(k, { tree: cur.tree, scroll: cur.scroll, doc: cur.doc, seen });
      undoRest(() => {
        if (prevMem) this.mem_.set(k, prevMem);
        else this.mem_.delete(k);
      });
    };
    return new PendingRead(text, mode, apply);
  }

  /** read 한 결과를 바로 기억에 올리고(찍힌 것으로 치고, 16KB 를 넘으면 잘리는 만큼은 뺀다) 글을 돌려준다. */
  diff(tabKey: string, o: SnapshotOptions, next: string): { text: string; mode: DiffMode | "scroll" } {
    const p = this.read(tabKey, o, next);
    p.commit();
    p.settle(capSnapshot(p.text));
    return { text: p.text, mode: p.mode };
  }

  /** 그 탭에 대한 기억을 모두 지운다(탭이 닫혔을 때). */
  forget(tabKey: string): void {
    const prefix = JSON.stringify([tabKey]).slice(0, -1) + ",";
    for (const k of [...this.mem_.keys()]) if (k.startsWith(prefix)) this.mem_.delete(k);
  }
}
