import { diffSnapshot, scrollDiffSnapshot } from "./diff.js";
import type { SnapshotOptions } from "./inpage.js";

const META_PREFIX = "#sa-meta ";

/** 페이지 안 읽기 코드가 맨 앞에 붙인 안내 줄(`#sa-meta scroll=x,y doc=아이디`)을 떼어 낸다. 없으면 그대로. */
export function splitSnapshotMeta(raw: string): { tree: string; scroll?: string; doc?: string } {
  if (!raw.startsWith(META_PREFIX)) return { tree: raw };
  const nl = raw.indexOf("\n");
  const line = nl < 0 ? raw : raw.slice(0, nl);
  const tree = nl < 0 ? "" : raw.slice(nl + 1);
  const scroll = /(?:^| )scroll=(\S+)/.exec(line)?.[1];
  const doc = /(?:^| )doc=(\S+)/.exec(line)?.[1];
  return { tree, scroll, doc };
}

interface Memory {
  /** 지난번에 기억한 자르지 않은 전체 글(안내 줄 뺀 것). */
  tree: string;
  /** 지난번 읽을 때의 스크롤 위치. */
  scroll?: string;
  /** 지난번 문서의 표식(이동 · 새로고침이면 바뀐다). */
  doc?: string;
  /** 이 문서에서 Claude 에게 이미 보여 준 줄. */
  seen: Set<string>;
}

/**
 * 같은 탭의 같은 읽기(범위 · 요소만 보기 · 문서 전체 여부)를 이어서 비교하려고, 마지막 결과를 기억한다.
 * 화면 기준 읽기(요소만 보기 · 문서 전체가 아닌 것)는 스크롤 위치도 기억해, 내린 뒤에는 새로 보이는 줄만 낸다.
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
    this.mem_.set(this.key(tabKey, o), { tree: m.tree, scroll: m.scroll, doc: m.doc, seen: prev?.seen ?? new Set() });
  }

  /**
   * 지난번과 비교한 결과를 내고, 이번 글을 기억한다. next 는 페이지 안 읽기 결과 그대로(안내 줄이 있어도 된다).
   * 스크롤 위치가 지난번과 달라졌으면(화면 기준 읽기에서만) 이 문서에서 처음 보이는 줄만 낸다.
   */
  diff(tabKey: string, o: SnapshotOptions, next: string): ReturnType<typeof diffSnapshot> | ReturnType<typeof scrollDiffSnapshot> {
    const k = this.key(tabKey, o);
    const cur = splitSnapshotMeta(next);
    const old = this.mem_.get(k);
    const viewBased = !o.full && !o.selector;
    const newDoc = !!old && old.doc !== undefined && cur.doc !== undefined && old.doc !== cur.doc;
    const seen = !old || newDoc ? new Set<string>() : old.seen;
    const scrolled = viewBased && !!old && !newDoc && old.scroll !== undefined && cur.scroll !== undefined && old.scroll !== cur.scroll;

    const r = scrolled ? scrollDiffSnapshot(old.tree, cur.tree, seen) : diffSnapshot(old?.tree, cur.tree);
    if (viewBased) for (const l of cur.tree.split("\n")) seen.add(l);
    this.mem_.set(k, { tree: cur.tree, scroll: cur.scroll, doc: cur.doc, seen });
    return r;
  }

  /** 그 탭에 대한 기억을 모두 지운다(탭이 닫혔을 때). */
  forget(tabKey: string): void {
    const prefix = JSON.stringify([tabKey]).slice(0, -1) + ",";
    for (const k of [...this.mem_.keys()]) if (k.startsWith(prefix)) this.mem_.delete(k);
  }
}
