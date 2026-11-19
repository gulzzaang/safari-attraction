import { diffSnapshot } from "./diff.js";
import type { SnapshotOptions } from "./inpage.js";

/** 같은 탭의 같은 읽기(범위 · 요소만 보기 · 문서 전체 여부)를 이어서 비교하려고, 마지막 결과를 기억한다. */
export class SnapshotStore {
  private readonly last_ = new Map<string, string>();

  private key(tabKey: string, o: SnapshotOptions): string {
    return JSON.stringify([tabKey, o.selector ?? "", !!o.interactive, !!o.full]);
  }

  /** 지난번에 기억한 자르지 않은 전체 글. 없으면 undefined. */
  last(tabKey: string, o: SnapshotOptions): string | undefined {
    return this.last_.get(this.key(tabKey, o));
  }

  remember(tabKey: string, o: SnapshotOptions, text: string): void {
    this.last_.set(this.key(tabKey, o), text);
  }

  /** 지난번과 비교한 결과를 내고, 이번 글을 기억한다. */
  diff(tabKey: string, o: SnapshotOptions, next: string): ReturnType<typeof diffSnapshot> {
    const r = diffSnapshot(this.last(tabKey, o), next);
    this.remember(tabKey, o, next);
    return r;
  }

  /** 그 탭에 대한 기억을 모두 지운다(탭이 닫혔을 때). */
  forget(tabKey: string): void {
    const prefix = JSON.stringify([tabKey]).slice(0, -1) + ",";
    for (const k of [...this.last_.keys()]) if (k.startsWith(prefix)) this.last_.delete(k);
  }
}
