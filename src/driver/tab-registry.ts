import { SafariError } from "./types.js";

/** 사파리가 알려 주는 탭 한 칸(키는 아직 없다). */
export interface RawTab {
  windowId: number;
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

/** 자리의 탭을 들여다본 결과. marker 는 페이지 안에 적어 둔 탭 키(없으면 빈 문자열). */
export interface Probe {
  exists: boolean;
  url: string;
  marker: string;
}

/** 요청이 가리킨 자리. 호스트는 이 자리의 탭이 정말 key 의 탭일 때만 일한다. */
export interface Spot {
  windowId: number;
  index: number;
  key: string;
  url: string;
  /** 아직 페이지에 표시를 안 했다(주소로만 알아본다). */
  unstamped: boolean;
}

/** 호스트가 보낸 답 — 자리의 탭이 키와 맞지 않으면 stale. */
export type Guarded<T> = { stale: true } | { value: T };

/** 레지스트리가 사파리에 바라는 것(호스트 op 와 1:1). */
export interface TabBackend {
  list(): Promise<RawTab[]>;
  probe(windowId: number, index: number, timeoutMs?: number): Promise<Probe>;
  stamp(windowId: number, index: number, key: string): Promise<boolean>;
  /** 자리의 탭이 spot.key 의 탭일 때만 닫는다. urlOnly 는 표시를 못 읽는 탭(경고창)용 — 주소만 본다. */
  close(spot: Spot, urlOnly: boolean, timeoutMs?: number): Promise<Guarded<null>>;
}

interface Entry {
  key: string;
  windowId: number;
  index: number;
  /** 마지막으로 본 주소. */
  url: string;
  owned: boolean;
  /** 페이지에 표시(`dataset.saTab`)를 적었다. */
  stamped: boolean;
  /** JS 에 답하지 않는 탭(경고창이 떠 있음). 표시를 읽으러 다시 들여다보지 않고 주소로만 알아본다. 다음에 일이 잘 끝나면 풀린다. */
  blocked?: boolean;
}

/** 다른 탭을 들여다보다 멈출 때(경고창이 떠 있는 탭 등)를 기다리는 시간. */
const PROBE_TIMEOUT_MS = 3000;

function sameSpot(a: { windowId: number; index: number }, b: { windowId: number; index: number }): boolean {
  return a.windowId === b.windowId && a.index === b.index;
}

function tabClosed(key: string): SafariError {
  return new SafariError("TAB_CLOSED", `탭 ${key} 을(를) 찾을 수 없음(닫혔거나 다른 주소로 옮겨 감)`);
}

/**
 * 서버가 만든 탭 키(`t1, t2 …`)와 사파리 안의 자리(창 번호 · 탭 순서)를 이어 준다.
 * 사용자가 탭을 옮기거나 다른 탭을 닫아 순서가 밀려도 같은 키가 같은 탭을 가리키게 한다.
 *
 * - 우리가 연 탭 · 붙잡은 탭 · 처음 쓰는 탭에는 페이지 안에 표시를 적는다(`dataset.saTab = 키`).
 *   표시는 같은 문서 안에서는 남고, 새 문서를 불러오면(전체 이동 · 새로고침) 사라진다.
 * - 목록(`sync`)만 본 탭은 표시 없이 자리 + 주소로만 기억한다(JS 를 돌리지 않는다). 처음 쓸 때 표시를 적는다.
 * - 표시를 적은 탭은 표시가 키와 맞아야만 그 키의 탭이다. 주소만 같은 다른 탭을 잘못 잡아 닫지 않기 위해서다.
 *   그래서 전체 새로고침 · 이동으로 표시가 사라진 탭은 못 찾고 TAB_CLOSED 가 된다(알려진 한계).
 */
export class TabRegistry {
  private entries = new Map<string, Entry>();
  private seq = 0;

  constructor(private backend: TabBackend) {}

  /** 새 키를 미리 정한다(탭을 열 때 호스트가 표시를 적도록). */
  nextKey(): string {
    return `t${++this.seq}`;
  }

  /** 열어 둔 탭을 기록한다. stamped 는 호스트가 표시를 적는 데 성공했는지. */
  register(key: string, windowId: number, index: number, url: string, o: { owned: boolean; stamped: boolean }): string {
    this.entries.set(key, { key, windowId, index, url, owned: o.owned, stamped: o.stamped });
    return key;
  }

  /** 사용자 탭을 붙잡는다 — 그 자리의 탭에 표시를 적고 키를 돌려준다. 이미 붙잡은 탭이면 그 키. */
  async adopt(windowId: number, index: number): Promise<string> {
    const p = await this.backend.probe(windowId, index);
    if (!p.exists) throw new SafariError("TAB_CLOSED", `그 자리에 탭이 없음: 창 ${windowId} · ${index}번째`);
    const known = [...this.entries.values()].find((e) => (p.marker !== "" ? e.key === p.marker : sameSpot(e, { windowId, index }) && e.url === p.url));
    if (known) {
      known.windowId = windowId;
      known.index = index;
      known.url = p.url;
      if (!known.stamped) known.stamped = await this.backend.stamp(windowId, index, known.key);
      return known.key;
    }
    const key = this.nextKey();
    const stamped = await this.backend.stamp(windowId, index, key);
    this.register(key, windowId, index, p.url, { owned: false, stamped });
    return key;
  }

  /** 지금 알고 있는 자리. 모르는 키면 TAB_CLOSED. */
  spot(key: string): Spot {
    const e = this.entries.get(key);
    if (!e) throw new SafariError("TAB_CLOSED", `모르는 탭 키(닫혔거나 만든 적 없음): ${key}`);
    return { windowId: e.windowId, index: e.index, key, url: e.url, unstamped: !e.stamped };
  }

  isOwned(key: string): boolean {
    return this.entries.get(key)?.owned ?? false;
  }

  ownedKeys(): string[] {
    return [...this.entries.values()].filter((e) => e.owned).map((e) => e.key);
  }

  /** 키의 탭이 지금 어느 자리에 있는지 표시 · 주소로 찾는다. 못 찾으면 키를 지우고 TAB_CLOSED. */
  async resolve(key: string): Promise<{ windowId: number; index: number }> {
    const e = this.entries.get(key);
    if (!e) throw tabClosed(key);
    const raw = await this.backend.list();
    const found = await this.locate(e, raw, new Set());
    if (!found) {
      this.forget(key);
      throw tabClosed(key);
    }
    return { windowId: found.windowId, index: found.index };
  }

  /**
   * 기록한 자리로 일을 시킨다. 호스트가 자리의 탭이 그 키가 아니라고 하면(사용자가 탭을 옮김 · 닫힘)
   * 탭을 다시 찾아 한 번 더 시킨다. 그래도 아니면 TAB_CLOSED.
   */
  async withTab<T>(key: string, run: (spot: Spot) => Promise<Guarded<T>>): Promise<T> {
    try {
      let r = await run(this.spot(key));
      if ("stale" in r) {
        await this.resolve(key);
        r = await run(this.spot(key));
        if ("stale" in r) {
          this.forget(key);
          throw tabClosed(key);
        }
      }
      this.confirm(key);
      return r.value;
    } catch (err) {
      if (err instanceof SafariError && (err.code === "ALERT_BLOCKED" || err.code === "TIMEOUT")) this.markBlocked(key);
      throw err;
    }
  }

  /** 탭 하나를 닫는다. 이미 닫혔으면 TAB_CLOSED 를 올리되 기록과 우리 탭 목록에서는 뺀다. */
  async closeTab(key: string): Promise<void> {
    const run = async (s: Spot): Promise<Guarded<null>> => {
      if (this.entries.get(key)?.blocked) return this.backend.close(s, true);
      try {
        return await this.backend.close(s, false, PROBE_TIMEOUT_MS);
      } catch (err) {
        // 경고창이 떠 JS 로 표시를 못 읽는 탭 — 주소만 보고 닫는다(호스트는 다시 떠 있다).
        if (err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED")) return this.backend.close(s, true);
        throw err;
      }
    };
    try {
      await this.withTab(key, run);
    } catch (err) {
      if (err instanceof SafariError && err.code === "TAB_CLOSED") this.forget(key);
      throw err;
    }
    const e = this.entries.get(key)!;
    this.forget(key);
    this.shiftAfterClose(e.windowId, e.index);
  }

  /** 우리가 연 탭을 모두 닫는다(사용자 탭은 건드리지 않는다). 실제로 닫은 수를 돌려준다. */
  async closeOwned(): Promise<number> {
    let closed = 0;
    let firstError: unknown;
    for (const key of this.ownedKeys()) {
      try {
        await this.closeTab(key);
        closed++;
      } catch (err) {
        if (err instanceof SafariError && err.code === "TAB_CLOSED") continue; // 이미 없다
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
    return closed;
  }

  /** 호스트가 자리의 탭이 맞다고 확인해 일을 마쳤다 — 표시도 이제 적혀 있다. */
  confirm(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      e.stamped = true;
      e.blocked = false;
    }
  }

  private markBlocked(key: string): void {
    const e = this.entries.get(key);
    if (e) e.blocked = true;
  }

  /** 탭이 닫혔다 — 기록과 우리 탭 목록에서 뺀다. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** 우리가 (windowId, index) 탭을 닫았다 — 같은 창에서 뒤에 있던 탭들은 순서가 하나 당겨진다. */
  shiftAfterClose(windowId: number, index: number): void {
    for (const e of this.entries.values()) {
      if (e.windowId === windowId && e.index > index) e.index -= 1;
    }
  }

  /**
   * 사파리의 탭 목록(raw)에 키를 붙인다. 기록한 탭은 자리를 새로 맞추고(없어진 건 기록에서 뺀다),
   * 처음 보는 탭에는 새 키를 준다. 표시를 적은 탭만 표시를 읽고, 사용자 탭에는 JS 를 돌리지 않는다.
   */
  async sync(raw: RawTab[]): Promise<Array<{ raw: RawTab; key: string; owned: boolean }>> {
    const claimed = new Set<string>();
    const spotId = (t: { windowId: number; index: number }) => `${t.windowId}:${t.index}`;
    const bySpot = new Map<string, string>();
    // 표시를 적은 탭을 먼저 맞춘다(표시가 가장 믿을 만하다).
    const order = [...this.entries.values()].sort((a, b) => Number(b.stamped) - Number(a.stamped));
    for (const e of order) {
      const found = await this.locate(e, raw, claimed);
      if (found) {
        claimed.add(spotId(found));
        bySpot.set(spotId(found), e.key);
      } else {
        this.forget(e.key);
      }
    }
    return raw.map((t) => {
      let key = bySpot.get(spotId(t));
      if (!key) {
        key = this.nextKey();
        this.register(key, t.windowId, t.index, t.url, { owned: false, stamped: false });
      }
      return { raw: t, key, owned: this.isOwned(key) };
    });
  }

  /** 한 탭이 지금 어디 있는지 찾아 기록을 새로 한다. 못 찾으면 null(기록은 건드리지 않는다). */
  private async locate(e: Entry, raw: RawTab[], claimed: Set<string>): Promise<RawTab | null> {
    const free = (t: RawTab) => !claimed.has(`${t.windowId}:${t.index}`);
    const at = (t: { windowId: number; index: number }) => raw.find((r) => sameSpot(r, t));
    const take = (t: RawTab): RawTab => {
      e.windowId = t.windowId;
      e.index = t.index;
      e.url = t.url;
      return t;
    };

    if (!e.stamped) {
      // 표시 없는 탭 — 자리와 주소가 그대로면 그 탭, 아니면 같은 주소 탭이 하나뿐일 때만 그 탭.
      const here = at(e);
      if (here && free(here) && here.url === e.url) return take(here);
      const same = raw.filter((t) => free(t) && t.url === e.url);
      return same.length === 1 ? take(same[0]!) : null;
    }

    // JS 에 답하지 않는 탭은 표시를 못 읽는다 — 자리와 주소가 그대로면 그 탭으로 본다.
    if (e.blocked) {
      const here = at(e);
      if (here && free(here) && here.url === e.url) return take(here);
    }

    // 표시를 적은 탭 — 표시가 키와 같은 탭. 기록한 자리를 먼저, 그다음 같은 주소 탭(같은 창 먼저).
    const here = at(e);
    const rest = raw
      .filter((t) => free(t) && t.url === e.url && !(here && sameSpot(t, here)))
      .sort((a, b) => Number(b.windowId === e.windowId) - Number(a.windowId === e.windowId));
    const tryOrder = [...(here && free(here) ? [here] : []), ...rest];
    for (const t of tryOrder) {
      let p: Probe;
      try {
        p = await this.backend.probe(t.windowId, t.index, PROBE_TIMEOUT_MS);
      } catch (err) {
        // 멈춘 탭(경고창 등)은 표시를 못 읽는다 — 주소가 같으면 그 탭으로 본다.
        if (err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED") && t.url === e.url) {
          e.blocked = true;
          return take(t);
        }
        continue;
      }
      if (p.exists && p.marker === e.key) return take({ ...t, url: p.url });
    }
    return null;
  }
}
