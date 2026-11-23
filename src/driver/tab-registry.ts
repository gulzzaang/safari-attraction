import { randomBytes } from "node:crypto";
import { SafariError } from "./types.js";
import { registrableDomain, sameUrl } from "./url.js";

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

/** 요청이 가리킨 자리. 호스트는 이 자리의 탭이 정말 key 의 탭일 때만 일한다. key 는 페이지 안에 적는 표시(markerOf)다. */
export interface Spot {
  windowId: number;
  index: number;
  key: string;
  url: string;
  /** 아직 페이지에 표시를 안 했다(주소로만 알아본다). */
  unstamped: boolean;
  /** 표시 안 한 탭을 알아볼 때 url 말고 받아들일 주소 — 이동이 시간 초과로 끝난 탭이 늦게 새 문서로 바뀌었을 때의 목적지. */
  altUrl?: string;
}

/** 호스트가 보낸 답 — 자리의 탭이 키와 맞지 않으면 stale. */
export type Guarded<T> = { stale: true } | { value: T; /** 일을 마친 뒤의 탭 주소(알면). */ url?: string; /** 일을 마친 뒤 문서를 떠나는 중인가(beforeunload 깃발, 빠른 길만 안다). */ leaving?: boolean };

/** withTabDetail 의 결과: 호스트가 돌려준 것과, 일을 시키기 전에 기록해 둔 주소. */
export type Detailed<T> = { value: T; url?: string; leaving?: boolean; urlBefore: string; /** 우리가 연 탭인가(붙인 사용자 탭이 아니다). */ owned: boolean };

/** 호스트의 rebind 답. gone = 그 자리에 탭 없음, other = 그 자리에 다른 키의 표시가 있는 탭. */
export type RebindResult = { status: "ok"; tab: RawTab; /** 표시가 실제로 적혔는가(안 주면 적힌 것으로 본다). */ stamped?: boolean } | { status: "gone" } | { status: "other" };

/**
 * 호스트의 settle 답(읽기 전용 확인). same = 자리의 탭에 이 키의 표시가 그대로(leaving: 문서를 떠나는 중),
 * navigated = 새 문서가 떠 표시를 다시 적었다. gone · other 는 rebind 와 같다.
 */
export type SettleResult =
  | { status: "same"; leaving: boolean; tab: RawTab }
  | { status: "navigated"; tab: RawTab; /** 표시가 실제로 적혔는가(안 주면 적힌 것으로 본다). */ stamped?: boolean }
  | { status: "gone" }
  | { status: "other" };

/** 자리의 탭 표시를 읽은 결과(읽지 못한 탭은 결과에 없다). */
export interface MarkerRead {
  windowId: number;
  index: number;
  url: string;
  marker: string;
}

/** 레지스트리가 사파리에 바라는 것(호스트 op 와 1:1). */
export interface TabBackend {
  list(): Promise<RawTab[]>;
  probe(windowId: number, index: number, timeoutMs?: number): Promise<Probe>;
  stamp(windowId: number, index: number, key: string): Promise<boolean>;
  /** 제자리에서 이동한 탭에 표시를 다시 적는다(불러오기가 끝나길 기다린다). */
  rebind(args: { windowId: number; index: number; key: string; url: string }): Promise<RebindResult>;
  /** 이동이 일어났는지 보고, 새 문서면 표시를 다시 적는다. 표시가 없다는 이유로 아무것도 지우지 않는다. */
  settle(args: { windowId: number; index: number; key: string; url: string; waitUntil?: "commit"; loadBudgetMs?: number }): Promise<SettleResult>;
  /** 자리의 탭이 spot.key 의 탭일 때만 닫는다. urlOnly 는 표시를 못 읽는 탭(경고창)용 — 주소만 본다. */
  close(spot: Spot, urlOnly: boolean, timeoutMs?: number): Promise<Guarded<null>>;
  /**
   * 여러 자리의 탭 표시를 읽기만 한다(페이지 상태를 바꾸지 않는다. 사파리를 앞으로 가져오지도 않는다).
   * 탭 하나에 timeoutMs 안에 못 읽었거나 없는 탭은 결과에서 뺀다.
   */
  readMarkers(spots: Array<{ windowId: number; index: number }>, timeoutMs: number): Promise<MarkerRead[]>;
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
  /** 이동이 시간 초과로 끝났을 때 사파리가 알려 준 가는 중인 목적지. 늦게 새 문서가 뜨면 그 주소로도 이 탭을 알아본다(표시 안 한 탭일 때만 쓴다). */
  pendingUrl?: string;
  /** JS 에 답하지 않는 탭(경고창이 떠 있음). 표시를 읽으러 다시 들여다보지 않고 주소로만 알아본다. 다음에 일이 잘 끝나면 풀린다. */
  blocked?: boolean;
  /** 우리가 연 탭인데 지금 어디 있는지 못 찾았다. 잊지 않고 두었다가 closeOwned 가 표시로 다시 찾아 닫는다. 보이는 목록에서는 뺀다. */
  lost?: boolean;
  /** 이 항목에 마지막으로 우리가 한 일(열기 · 일 시키기 · settle · rebind)의 시각. 스스로 옮겨 간 탭을 되찾는 데 쓴다. */
  actedAt: number;
  /** 마지막으로 못 찾았을 때의 탭 목록 모양(sync 가 같은 목록을 되풀이해 훑지 않게 한다). */
  scanSig?: string;
  /** 방금 한 표시 훑기가 모든 탭을 읽고도 못 찾았는가(true 면 탭이 진짜로 없다 — 잃어버림으로 남기지 않는다). */
  scanComplete?: boolean;
}

/** 다른 탭을 들여다보다 멈출 때(경고창이 떠 있는 탭 등)를 기다리는 시간. */
const PROBE_TIMEOUT_MS = 3000;
/** 표시를 찾으러 한 번에 들여다보는 탭의 상한. */
export const SCAN_MAX_TABS = 60;
/** 스스로 옮겨 간 우리 탭을 되찾는 시간 한도: 우리가 그 탭에 마지막으로 한 일로부터. */
export const RECLAIM_WINDOW_MS = 120_000;
/** 표시를 읽을 때 탭 하나에 기다리는 시간. 넘으면 그 탭은 건너뛴다. */
export const SCAN_TAB_TIMEOUT_MS = 500;
/** 표시 읽기를 이 개수씩 나눠 보낸다(멈춘 탭이 있어도 그 묶음만 잃는다). */
const SCAN_CHUNK = 10;
/** 표시 훑기 한 번에 쓰는 시간의 상한. */
const SCAN_BUDGET_MS = 20_000;

function sameSpot(a: { windowId: number; index: number }, b: { windowId: number; index: number }): boolean {
  return a.windowId === b.windowId && a.index === b.index;
}

const isStuck = (err: unknown): boolean => err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED");

/** 표시 읽기가 이 오류로 끝나면 그 탭들은 「못 본 것」으로 두고 계속한다(sync · listTabs 가 표시 훑기 때문에 던지지 않게). */
const isUnscannable = (err: unknown): boolean => isStuck(err) || (err instanceof SafariError && err.code === "JS_FROM_APPLE_EVENTS_OFF");

/**
 * 표시를 훑은 결과(한 번의 sync · closeOwned 안에서 나눠 쓴다). 자리 `창:순번` 으로 찾는다.
 * failed 는 읽다가 멈췄거나 못 읽은 탭 — 같은 훑기 안에서 다시 시도하지 않고 「못 본 것」으로 센다.
 */
interface Scan {
  reads: Map<string, MarkerRead>;
  failed: Set<string>;
}
const newScan = (): Scan => ({ reads: new Map(), failed: new Set() });
const spotId = (t: { windowId: number; index: number }) => `${t.windowId}:${t.index}`;
/** 우리 페이지 탭은 항상 http(s) 다(우리 AI 창은 창 id 로 닫는다). 시작 페이지 · 즐겨찾기 · about: · 빈 주소 탭은 우리 탭일 수 없어 표시를 읽지 않는다. */
const isWebTab = (t: { url: string }) => /^https?:/i.test(t.url);

function tabClosed(key: string): SafariError {
  return new SafariError("TAB_CLOSED", `탭 ${key} 을(를) 찾을 수 없음(닫혔거나 다른 주소로 옮겨 감)`);
}

/**
 * 서버가 만든 탭 키(`t1, t2 …`)와 사파리 안의 자리(창 번호 · 탭 순서)를 이어 준다.
 * 사용자가 탭을 옮기거나 다른 탭을 닫아 순서가 밀려도 같은 키가 같은 탭을 가리키게 한다.
 *
 * - 우리가 연 탭 · 붙잡은 탭 · 처음 쓰는 탭에는 페이지 안에 표시를 적는다(`dataset.saTab = 키`).
 *   표시는 같은 문서 안에서는 남고, 새 문서를 불러오면(전체 이동 · 새로고침) 사라진다.
 * - 목록(`sync`)만 본 탭은 표시 없이 자리 + 주소로만 기억한다(처음 쓸 때 표시를 적는다). 사용자 탭에는 표시를 적지 않는다.
 * - 우리가 연 탭을 자리 · 주소로 못 찾을 때만, 나머지 탭(최대 60개)의 표시를 읽기만 해서(페이지 상태를 바꾸지 않는다) 우리 표시와 정확히 같은 탭을 찾는다.
 * - 표시를 적은 탭은 표시가 키와 맞아야만 그 키의 탭이다. 주소만 같은 다른 탭을 잘못 잡아 닫지 않기 위해서다.
 *   전체 새로고침 · 이동 · 링크 · 폼 전송으로 새 문서가 뜨면 표시가 사라지므로, 우리가 그렇게 이동시킨 쪽이
 *   바로 `rebind(key)` 를 불러 표시를 다시 적어야 한다. 안 하면 그 탭은 못 찾고 TAB_CLOSED 가 된다.
 * - 목록에서만 본(표시 없는) 사용자 탭은 기록한 자리의 탭이 같은 주소일 때만 그 탭이다. 자리가 바뀌면
 *   주소가 같은 다른 탭으로 옮겨 잡지 않고 놓는다(다른 탭을 잘못 건드리지 않기 위해).
 */
export class TabRegistry {
  private entries = new Map<string, Entry>();
  private seq = 0;
  /**
   * 창마다 마지막으로 기록한 모습: 순번대로 탭 주소들(탭 수 = 길이). 목록을 알게 될 때(sync · resolve)와 우리가 열 때(noteWindow) · 닫을 때 새로 한다.
   * 스스로 새 문서가 돼 표시를 잃은 우리 탭을 되찾을 때 「그 자리의 표시 없는 탭이 사용자 탭이 밀려 온 것이 아님」을 확인하는 데만 쓴다.
   */
  private windowShape = new Map<number, string[]>();

  /**
   * instanceId 는 이 서버 프로세스를 가리키는 값(기본은 무작위). 페이지 안 표시를 `키.instanceId` 로 적어,
   * 같은 사파리에서 도는 다른 서버(다른 Claude 세션)나 끝난 세션이 남긴 표시와 겹치지 않게 한다.
   */
  constructor(private backend: TabBackend, private instanceId: string = randomBytes(4).toString("hex"), private now: () => number = Date.now) {}

  /** 키(t1)에 대응하는 페이지 안 표시 — 호스트와 사파리 쪽에는 이 값을 키로 넘긴다. 서버 프로세스마다 다르다. */
  markerOf(key: string): string {
    return `${key}.${this.instanceId}`;
  }

  /** 창의 지금 모습(순번대로 탭 주소들)을 기록한다. 우리가 탭을 연 직후 호스트가 알려 준 값을 넣는다. */
  noteWindow(windowId: number, urls: string[]): void {
    this.windowShape.set(windowId, [...urls]);
  }

  /** 탭 목록(raw)을 알게 됐다 — 목록에 든 창마다 모습을 새로 기록한다. */
  private recordWindows(raw: RawTab[]): void {
    const byWindow = new Map<number, RawTab[]>();
    for (const t of raw) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
    for (const [windowId, tabs] of byWindow) this.windowShape.set(windowId, tabs.sort((a, b) => a.index - b.index).map((t) => t.url));
  }

  /**
   * 우리 탭이 스스로 새 문서가 돼(늦은 리디렉트) 표시를 잃었을 때 기록한 자리의 표시 없는 탭을 우리 탭으로 봐도 되는가.
   * 마지막으로 기록한 창 모습과 견줘 (1) 탭 수가 같고 (2) 바로 앞 · 뒤 이웃의 주소가 같고 (3) 그 탭의 주소가 창의 다른 탭들의 기록된 주소가 아닐 때만, 그리고 http(s) · 같은 등록 도메인 · 마지막 일로부터 120초 안일 때만.
   * 아니면 사용자 탭이 우리 자리로 밀려 온 것일 수 있어 건드리지 않는다. 알려진 한계: 우리 탭이 닫히고 탭 수 · 이웃이 똑같게 새 주소의 사용자 탭이 그 자리에 오면 구별하지 못한다.
   */
  private stayedPut(e: Entry, raw: RawTab[], here: RawTab): boolean {
    const shape = this.windowShape.get(e.windowId);
    if (!shape) return false;
    // R5: http(s) 탭이고, 등록 도메인이 우리가 마지막으로 기록한 주소(또는 가는 중이던 주소)와 같고, 우리가 마지막으로 한 일로부터 120초 안일 때만.
    if (!isWebTab(here)) return false;
    const domain = registrableDomain(here.url);
    if (domain === null || (domain !== registrableDomain(e.url) && domain !== registrableDomain(e.pendingUrl))) return false;
    if (this.now() - e.actedAt > RECLAIM_WINDOW_MS) return false;
    const now = raw.filter((t) => t.windowId === e.windowId).sort((a, b) => a.index - b.index).map((t) => t.url);
    const i = e.index - 1;
    if (now.length !== shape.length || i < 0 || i >= now.length) return false;
    if (i > 0 && !sameUrl(shape[i - 1], now[i - 1])) return false;
    if (i + 1 < now.length && !sameUrl(shape[i + 1], now[i + 1])) return false;
    return !shape.some((u, j) => j !== i && sameUrl(u, here.url));
  }

  /** 새 키를 미리 정한다(탭을 열 때 호스트가 표시를 적도록). */
  nextKey(): string {
    return `t${++this.seq}`;
  }

  /** 열어 둔 탭을 기록한다. stamped 는 호스트가 표시를 적는 데 성공했는지. */
  register(key: string, windowId: number, index: number, url: string, o: { owned: boolean; stamped: boolean }): string {
    this.entries.set(key, { key, windowId, index, url, owned: o.owned, stamped: o.stamped, actedAt: this.now() });
    return key;
  }

  /** 사용자 탭을 붙잡는다 — 그 자리의 탭에 표시를 적고 키를 돌려준다. 이미 붙잡은 탭이면 그 키. */
  async adopt(windowId: number, index: number): Promise<string> {
    const p = await this.backend.probe(windowId, index);
    if (!p.exists) throw new SafariError("TAB_CLOSED", `그 자리에 탭이 없음: 창 ${windowId} · ${index}번째`);
    const known = [...this.entries.values()].find((e) => (p.marker !== "" ? this.markerOf(e.key) === p.marker : sameSpot(e, { windowId, index }) && sameUrl(e.url, p.url)));
    if (known) {
      known.windowId = windowId;
      known.index = index;
      known.url = p.url;
      if (!known.stamped) known.stamped = await this.backend.stamp(windowId, index, this.markerOf(known.key));
      return known.key;
    }
    const key = this.nextKey();
    const stamped = await this.backend.stamp(windowId, index, this.markerOf(key));
    this.register(key, windowId, index, p.url, { owned: false, stamped });
    return key;
  }

  /** 지금 알고 있는 자리. 모르는 키면 TAB_CLOSED. */
  spot(key: string): Spot {
    const e = this.entries.get(key);
    if (!e) throw new SafariError("TAB_CLOSED", `모르는 탭 키(닫혔거나 만든 적 없음): ${key}`);
    return { windowId: e.windowId, index: e.index, key: this.markerOf(key), url: e.url, unstamped: !e.stamped, altUrl: e.pendingUrl };
  }

  /** 지금 알고 있는 그 탭의 주소(열 때 · runJs · settle · rebind 때마다 새로 한다). 모르는 키면 undefined. */
  urlOf(key: string): string | undefined {
    return this.entries.get(key)?.url;
  }

  isOwned(key: string): boolean {
    return this.entries.get(key)?.owned ?? false;
  }

  /** 보이는 우리 탭(잃어버린 탭은 뺀다). */
  ownedKeys(): string[] {
    return [...this.entries.values()].filter((e) => e.owned && !e.lost).map((e) => e.key);
  }

  /** 키의 탭이 지금 어느 자리에 있는지 표시 · 주소로 찾는다. 못 찾으면 TAB_CLOSED(우리 탭은 잃어버림으로 남기고, 사용자 탭은 키를 지운다). */
  async resolve(key: string): Promise<{ windowId: number; index: number }> {
    const e = this.entries.get(key);
    if (!e) throw tabClosed(key);
    const raw = await this.backend.list();
    const found = await this.locate(e, raw, new Set(), newScan()); // 창 모습은 여기서 새로 기록하지 않는다 — 같은 창의 다른 우리 탭이 아직 정리 전이라 낡은 모습을 새것으로 바꿔 버리기 때문(sync 가 다 맞춘 뒤에 기록한다)
    if (!found) {
      this.drop(key);
      throw tabClosed(key);
    }
    return { windowId: found.windowId, index: found.index };
  }

  /**
   * 자리의 탭이 키의 탭이 아니라고 했을 때 탭을 다시 찾는다. 자리의 탭에 이 키의 표시가 그대로면 settle 로 상태만 맞추고(표시를 새로 적지 않는다),
   * 그 밖에는 표시로만 찾는다(resolve). 표시 없는 탭에 우리 표시를 적지 않는다 — 사용자 탭이 우리 옛 자리로 밀려 온 것일 수 있어서다.
   * 새 문서가 돼 표시를 잃은 우리 탭은 이동을 시킨 쪽이 바로 rebind · settle 로 되살린다(진행 중인 동작 바로 뒤).
   */
  private async relocate(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (e && e.owned && !e.blocked && !e.lost && (await this.markerAtSpot(e))) await this.settle(key);
    else await this.resolve(key);
  }

  /** 기록한 자리의 탭에 이 키의 표시가 있는가(읽기 전용). 읽지 못하면 false. */
  private async markerAtSpot(e: Entry): Promise<boolean> {
    try {
      const p = await this.backend.probe(e.windowId, e.index, PROBE_TIMEOUT_MS);
      return p.exists && p.marker === this.markerOf(e.key);
    } catch (err) {
      if (isStuck(err)) return false;
      throw err;
    }
  }

  /**
   * 기록한 자리로 일을 시킨다. 호스트가 자리의 탭이 그 키가 아니라고 하면(사용자가 탭을 옮김 · 닫힘)
   * 탭을 다시 찾아 한 번 더 시킨다. 그래도 아니면 TAB_CLOSED.
   */
  async withTab<T>(key: string, run: (spot: Spot) => Promise<Guarded<T>>): Promise<T> {
    return (await this.withTabDetail(key, run)).value;
  }

  /** withTab 과 같되, 호스트가 알려 준 주소 · 떠나는 중 깃발과 일을 시키기 전에 기록해 둔 주소(urlBefore)도 돌려준다. */
  async withTabDetail<T>(key: string, run: (spot: Spot) => Promise<Guarded<T>>): Promise<Detailed<T>> {
    try {
      let spot = this.spot(key);
      let r = await run(spot);
      if ("stale" in r) {
        await this.relocate(key);
        spot = this.spot(key);
        r = await run(spot);
        if ("stale" in r) {
          this.drop(key);
          throw tabClosed(key);
        }
      }
      this.confirm(key);
      if (r.url !== undefined) {
        const e = this.entries.get(key);
        if (e) e.url = r.url; // 같은 문서 안 이동(SPA)으로 바뀐 주소
      }
      return { value: r.value, url: r.url, leaving: r.leaving, urlBefore: spot.url, owned: this.isOwned(key) };
    } catch (err) {
      if (err instanceof SafariError && (err.code === "ALERT_BLOCKED" || err.code === "TIMEOUT")) this.markBlocked(key);
      throw err;
    }
  }

  /** 탭 하나를 닫는다. 이미 닫혔으면 TAB_CLOSED 를 올리되 기록과 우리 탭 목록에서는 뺀다. */
  async closeTab(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e) throw tabClosed(key);
    const timedOut = (err: unknown) => err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED");
    const run = async (s: Spot): Promise<Guarded<null>> => {
      if (e.blocked) return this.backend.close(s, true);
      try {
        return await this.backend.close(s, false); // 창을 닫는 데는 시간이 걸릴 수 있어 보통 제한 시간을 쓴다
      } catch (err) {
        if (!timedOut(err)) throw err;
        // 답이 없었다 — 경고창이 떠 JS 로 표시를 못 읽는 탭이거나, 닫는 중이었을 수 있다(호스트는 다시 떠 있다).
        const r = await this.backend.close(s, true);
        if (!("stale" in r)) return r;
        // 자리에 그 탭이 없다 — 방금 시간 초과한 닫기가 실제로 끝났다면 성공이다.
        try {
          const moved = await this.resolve(key);
          const r2 = await this.backend.close({ ...s, ...moved }, true);
          return "stale" in r2 ? { value: null } : r2;
        } catch (err2) {
          if (err2 instanceof SafariError && err2.code === "TAB_CLOSED") return { value: null }; // 이미 사라졌다
          throw err2;
        }
      }
    };
    try {
      await this.withTab(key, run);
    } catch (err) {
      if (err instanceof SafariError && err.code === "TAB_CLOSED") this.drop(key);
      throw err;
    }
    this.forget(key);
    this.shiftAfterClose(e.windowId, e.index, e.url);
  }

  /**
   * 제자리에서 이동한 우리 탭(주소 이동 · 링크 · 폼 전송)에 표시를 다시 적고 기록한 주소를 새로 한다.
   * 이동을 시킨 쪽이 바로 부른다. 기록한 자리의 탭에 표시가 없거나(새 문서) 이 키의 표시일 때만 받아들이고,
   * 다른 키의 표시가 있으면 TAB_CLOSED.
   */
  async rebind(key: string): Promise<RawTab> {
    const e = this.entries.get(key);
    if (!e) throw tabClosed(key);
    if (e.lost) await this.resolve(key); // settle 과 같다 — 잃어버린 탭은 표시로만 돌아온다
    let r = await this.backend.rebind({ windowId: e.windowId, index: e.index, key: this.markerOf(key), url: e.url });
    if (r.status !== "ok") {
      // 기록한 자리가 아니다 — 표시가 남은 채 옮겨 갔다면 표시로 찾는다(못 찾으면 TAB_CLOSED 로 키를 지운다).
      const at = await this.resolve(key);
      r = await this.backend.rebind({ ...at, key: this.markerOf(key), url: e.url });
      if (r.status !== "ok") {
        this.drop(key);
        throw tabClosed(key);
      }
    }
    e.windowId = r.tab.windowId;
    e.index = r.tab.index;
    e.url = r.tab.url;
    e.pendingUrl = undefined;
    e.lost = false;
    e.stamped = r.stamped ?? true; // 표시를 못 적었으면 「표시 안 한 탭」으로 둬 다음에 자리 · 주소로 다시 알아본다
    e.blocked = false;
    e.actedAt = this.now();
    return r.tab;
  }

  /**
   * 동작 뒤 탭이 이동했는지 본다. rebind 와 달리 문서가 이미 바뀌었어도 키를 지우지 않는다 —
   * 자리의 탭에 이 키의 표시가 있으면 navigated:false, 표시가 없으면(새 문서) 다 뜰 때까지 기다려 표시를
   * 다시 적고 navigated:true. 다른 키의 표시가 있거나 탭이 정말 없을 때만 TAB_CLOSED(그때만 키를 지운다).
   * 「다 뜰 때」는 문서를 쓸 수 있게 될 때(domcontentloaded)다. opts.waitUntil 이 "commit" 이면 새 문서가 보이는 즉시 끝낸다(주소가 바뀐 것만 본다).
   */
  async settle(key: string, opts: { waitUntil?: "commit"; loadBudgetMs?: number } = {}): Promise<{ navigated: boolean; leaving: boolean; tab: RawTab }> {
    const e = this.entries.get(key);
    if (!e) throw tabClosed(key);
    if (e.lost) await this.resolve(key); // 잃어버린 탭은 표시가 정확히 맞는 탭으로만 돌아온다(못 찾으면 TAB_CLOSED) — 자리의 표시 없는 탭에 표시를 적지 않는다
    if (!e.stamped) {
      // 표시를 아직 안 적은 탭 — 자리와 주소가 그대로일 때만 우리 탭이다. 이 경우 표시 없음은 이동이 아니다.
      const p = await this.backend.probe(e.windowId, e.index);
      if (p.exists && p.marker === "" && (sameUrl(p.url, e.url) || sameUrl(p.url, e.pendingUrl)) && (await this.backend.stamp(e.windowId, e.index, this.markerOf(key)))) {
        e.stamped = true;
        e.pendingUrl = undefined;
      }
    }
    const { waitUntil, loadBudgetMs } = opts;
    let r = await this.backend.settle({ windowId: e.windowId, index: e.index, key: this.markerOf(key), url: e.url, waitUntil, loadBudgetMs });
    if (r.status === "gone" || r.status === "other") {
      // 기록한 자리가 아니다 — 표시로 찾는다(못 찾으면 resolve 가 키를 지우고 TAB_CLOSED).
      const at = await this.resolve(key);
      r = await this.backend.settle({ ...at, key: this.markerOf(key), url: e.url, waitUntil, loadBudgetMs });
      if (r.status === "gone" || r.status === "other") {
        this.drop(key);
        throw tabClosed(key);
      }
    }
    e.windowId = r.tab.windowId;
    e.index = r.tab.index;
    e.url = r.tab.url;
    e.pendingUrl = undefined;
    e.lost = false;
    e.stamped = r.status === "navigated" ? (r.stamped ?? true) : true; // commit 에서 표시를 못 적었으면 「표시 안 한 탭」으로 둔다
    e.blocked = false;
    e.actedAt = this.now();
    return { navigated: r.status === "navigated", leaving: r.status === "same" && r.leaving, tab: r.tab };
  }

  /**
   * 이동이 시간 초과로 끝났다(새 문서가 아직 안 떴다). 우리가 연 탭은 나중에 새 문서가 떠도 settle 이 키를 지키므로 그대로 둔다.
   * 붙인 사용자 탭(owned 아님)은 늦게 새 문서가 뜨면 표시를 잃어 TAB_CLOSED 가 될 수 있으니, 「표시 안 한 탭」으로 바꾸고 사파리가 알려 준
   * 가는 중인 목적지를 적어 둔다 — 다음 일에서 자리 · 주소(기록한 주소 또는 목적지)로 다시 알아보고 표시를 적는다.
   * 아직 옛 문서(표시가 이 키)일 때만 한다. 다음에 일이 잘 끝나면(confirm) 도로 표시 있는 탭이 된다.
   */
  async navTimedOut(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e || e.owned) return;
    let p: Probe;
    try {
      p = await this.backend.probe(e.windowId, e.index, PROBE_TIMEOUT_MS);
    } catch {
      return;
    }
    if (!p.exists || p.marker !== this.markerOf(key)) return; // 이미 바뀌었거나 없다 — 그건 settle · resolve 가 다룬다
    e.stamped = false;
    e.pendingUrl = !sameUrl(p.url, e.url) && p.url !== "" ? p.url : undefined;
  }

  /**
   * 우리가 연 탭을 모두 닫는다(사용자 탭은 건드리지 않는다). 실제로 닫은 수와, 못 찾은 수(missing)를 돌려준다.
   * 보통 닫기 뒤에도 우리 항목이 남았으면(잃어버린 탭 포함) 모든 창의 탭 표시를 읽어 우리 항목의 표시(`키.instanceId`)와 정확히 같은 탭을 닫는다.
   * missing 은 「다 훑지 못해(60개 상한 · 시간 초과로 못 본 탭이 남음) 못 찾은 우리 항목」 수다. 모든 탭을 다 보고도 표시가 없으면 그 탭은 진짜로 닫힌 것이라 세지 않는다.
   */
  async closeOwned(): Promise<{ closed: number; missing: number }> {
    let closed = 0;
    let missing = 0;
    let firstError: unknown;
    for (const key of this.ownedKeys()) {
      try {
        await this.closeTab(key);
        closed++;
      } catch (err) {
        if (err instanceof SafariError && err.code === "TAB_CLOSED") continue; // 못 찾았다 — 아래에서 표시로 다시 찾는다
        firstError ??= err;
      }
    }
    const left = [...this.entries.values()].filter((e) => e.owned);
    if (left.length > 0) {
      try {
        const r = await this.sweepOwned(left);
        closed += r.closed;
        missing = r.missing;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
    return { closed, missing };
  }

  /** 남은 우리 항목들을 모든 창의 탭 표시로 찾아 닫는다. 우리 항목의 표시와 정확히 같은 탭만 닫는다(붙잡은 사용자 탭 · 다른 표시 · 표시 없는 탭은 읽기만 한다). */
  private async sweepOwned(left: Entry[]): Promise<{ closed: number; missing: number }> {
    const raw = await this.backend.list();
    const scan = newScan();
    const complete = await this.readMarkersOf(this.priorityOrder(raw, left), scan);
    const byMarker = new Map(left.map((e) => [this.markerOf(e.key), e]));
    const hits: Entry[] = [];
    for (const read of scan.reads.values()) {
      const e = byMarker.get(read.marker);
      if (!e || hits.includes(e)) continue;
      e.windowId = read.windowId;
      e.index = read.index;
      e.url = read.url;
      e.lost = false;
      hits.push(e);
    }
    // 뒤 순번부터 닫는다 — 앞의 것을 닫으면 뒤의 순번이 당겨지므로.
    hits.sort((a, b) => b.windowId - a.windowId || b.index - a.index);
    let closed = 0;
    for (const e of hits) {
      try {
        await this.closeTab(e.key);
        closed++;
      } catch (err) {
        if (!(err instanceof SafariError && err.code === "TAB_CLOSED")) throw err;
      }
    }
    // 표시를 못 찾은 우리 항목 — 다 훑었으면 진짜로 닫힌 것(조용히 정리), 못 훑었으면 못 찾은 것으로 알린다.
    const rest = left.filter((e) => this.entries.get(e.key) === e);
    if (complete) {
      for (const e of rest) this.forget(e.key);
      return { closed, missing: 0 };
    }
    return { closed, missing: rest.length };
  }

  /** 훑을 탭 순서: 찾는 항목이 기록된 창을 먼저, 기록한 순번에 가까운 것부터. */
  private priorityOrder(raw: RawTab[], wanted: Entry[]): RawTab[] {
    const distance = (t: RawTab) => Math.min(...wanted.map((e) => (e.windowId === t.windowId ? Math.abs(e.index - t.index) : 1e6 + Math.abs(e.index - t.index))));
    return raw.map((t) => ({ t, d: distance(t) })).sort((a, b) => a.d - b.d).map((x) => x.t);
  }

  /**
   * 탭들의 표시를 읽어 scan 에 둔다(이미 읽은 것 · 이미 실패한 것은 다시 시도하지 않는다). http(s) 주소의 탭만 앞에서부터 SCAN_MAX_TABS 개까지 들여다보고,
   * 읽기만 한다. 멈췄거나 못 읽은 탭은 failed 에 적고 계속한다(예산 SCAN_BUDGET_MS 는 묶음마다 확인한다).
   * 다 읽었으면 true(상한 · 시간 · 못 읽음으로 빠진 탭이 없다).
   */
  private async readMarkersOf(tabs: RawTab[], scan: Scan): Promise<boolean> {
    const web = tabs.filter(isWebTab); // 웹 주소가 아닌 탭은 읽지 않고, 훑은 것으로 센다
    const look = web.slice(0, SCAN_MAX_TABS);
    const todo = look.filter((t) => !scan.reads.has(spotId(t)) && !scan.failed.has(spotId(t)));
    const t0 = Date.now();
    for (let i = 0; i < todo.length; i += SCAN_CHUNK) {
      if (Date.now() - t0 > SCAN_BUDGET_MS) break; // 남은 묶음은 못 본 것으로 둔다
      const chunk = todo.slice(i, i + SCAN_CHUNK);
      let reads: MarkerRead[] = [];
      try {
        reads = await this.backend.readMarkers(chunk.map((t) => ({ windowId: t.windowId, index: t.index })), SCAN_TAB_TIMEOUT_MS);
      } catch (err) {
        if (!isUnscannable(err)) throw err; // 멈춘 탭 · 허용 꺼짐은 이 묶음을 못 본 것으로 두고 계속한다
      }
      for (const r of reads) scan.reads.set(spotId(r), r);
      for (const t of chunk) if (!scan.reads.has(spotId(t))) scan.failed.add(spotId(t)); // 돌려받지 못한 탭 = 못 읽음
    }
    return web.length <= SCAN_MAX_TABS && look.every((t) => scan.reads.has(spotId(t)));
  }

  /** 호스트가 자리의 탭이 맞다고 확인해 일을 마쳤다 — 표시도 이제 적혀 있다. */
  confirm(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      e.pendingUrl = undefined;
      e.stamped = true;
      e.blocked = false;
      e.actedAt = this.now();
    }
  }

  private markBlocked(key: string): void {
    const e = this.entries.get(key);
    if (e) e.blocked = true;
  }

  /** 창이 닫혔다 — 그 창 안 탭의 기록을 모두 뺀다. */
  forgetWindow(windowId: number): void {
    for (const [key, e] of this.entries) if (e.windowId === windowId) this.entries.delete(key);
    this.windowShape.delete(windowId);
  }

  /** 탭이 닫혔다 — 기록과 우리 탭 목록에서 뺀다. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /**
   * 탭을 못 찾았다. 사용자 탭은 잊지만, 우리가 연 탭은 사용자가 순번을 밀고 주소가 바뀐 것일 수 있어 「잃어버림」으로 남긴다 —
   * 보이는 목록에서는 빠지고, closeOwned 가 표시로 다시 찾아 닫는다(정말 닫혔다면 거기서 조용히 정리한다).
   */
  private drop(key: string): void {
    const e = this.entries.get(key);
    // 표시 없는 탭(표시를 못 적었거나 읽을 수 없는 탭)은 표시로 다시 찾을 수 없다 — 기록한 자리 · 주소로만 알아보던 것이니 못 찾으면 잊는다.
    // 모든 탭을 읽고도 표시가 없었다면 탭이 진짜로 없다 — 잃어버림으로 남기고 되풀이해 훑지 않는다.
    if (e?.owned && e.stamped && !e.blocked && e.scanComplete !== true) e.lost = true;
    else this.forget(key);
  }

  /** 우리가 (windowId, index) 탭을 닫았다 — 같은 창에서 뒤에 있던 탭들은 순서가 하나 당겨진다. */
  shiftAfterClose(windowId: number, index: number, url?: string): void {
    // 기록한 창 모습에서 닫은 탭을 뺀다. 기록한 그 자리의 주소가 닫은 탭의 주소와 다르면 기록이 낡은 것이니 버린다(낡은 모습을 새것처럼 만들지 않는다).
    const shape = this.windowShape.get(windowId);
    if (shape) {
      if (url !== undefined && sameUrl(shape[index - 1], url)) shape.splice(index - 1, 1);
      else this.windowShape.delete(windowId);
    }
    for (const e of this.entries.values()) {
      if (e.windowId === windowId && e.index > index) e.index -= 1;
    }
  }

  /**
   * 사파리의 탭 목록(raw)에 키를 붙인다. 기록한 탭은 자리를 새로 맞추고(없어진 사용자 탭은 기록에서 빼고, 못 찾은 우리 탭은 잃어버림으로 두고 목록에서 뺀다),
   * 처음 보는 탭에는 새 키를 준다. 표시를 적은 탭은 표시를 읽고, 우리 탭이 없어졌을 때만 사용자 탭 최대 60개의 표시를 읽기만 한다(아무것도 적지 않는다).
   */
  async sync(raw: RawTab[]): Promise<Array<{ raw: RawTab; key: string; owned: boolean }>> {
    const claimed = new Set<string>();
    const scan = newScan();
    const bySpot = new Map<string, string>();
    // 표시를 적은 탭을 먼저 맞춘다(표시가 가장 믿을 만하다).
    const order = [...this.entries.values()].sort((a, b) => Number(b.stamped) - Number(a.stamped));
    for (const e of order) {
      const found = await this.locate(e, raw, claimed, scan, true);
      if (found) {
        claimed.add(spotId(found));
        bySpot.set(spotId(found), e.key);
      } else {
        // 못 찾았다 — 사용자 탭은 잊고, 우리 탭은 잃어버림으로 둔다(표시 없는 탭에 표시를 적어 이어 붙이지 않는다).
        this.drop(e.key);
      }
    }
    this.recordWindows(raw);
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
  private async locate(e: Entry, raw: RawTab[], claimed: Set<string>, scan: Scan, fromSync = false): Promise<RawTab | null> {
    const free = (t: RawTab) => !claimed.has(`${t.windowId}:${t.index}`);
    const at = (t: { windowId: number; index: number }) => raw.find((r) => sameSpot(r, t));
    const take = (t: RawTab): RawTab => {
      e.windowId = t.windowId;
      e.index = t.index;
      e.url = t.url;
      e.pendingUrl = undefined;
      e.lost = false;
      e.scanSig = undefined;
      e.scanComplete = undefined;
      return t;
    };

    e.scanComplete = undefined;
    if (!e.stamped) {
      if (e.lost) return null; // 잃어버린 탭은 표시가 정확히 맞을 때만 돌아온다(자리 · 주소로 되살리지 않는다)
      // 표시 없는 탭 — 자리와 주소가 그대로일 때만 그 탭. 주소가 같은 다른 탭으로 옮겨 잡지 않는다
      // (사용자가 이 탭을 닫았을 때 주소가 같은 다른 탭을 건드리게 되므로).
      const here = at(e);
      return here && free(here) && (sameUrl(here.url, e.url) || sameUrl(here.url, e.pendingUrl)) ? take(here) : null;
    }

    // JS 에 답하지 않는 탭은 표시를 못 읽는다 — 자리와 주소가 그대로면 그 탭으로 본다.
    if (e.blocked && !e.lost) {
      const here = at(e);
      if (here && free(here) && sameUrl(here.url, e.url)) return take(here);
    }

    // 표시를 적은 탭 — 표시가 키와 같은 탭. 기록한 자리를 먼저, 그다음 같은 주소 탭(같은 창 먼저).
    const here = at(e);
    const rest = raw
      .filter((t) => free(t) && sameUrl(t.url, e.url) && !(here && sameSpot(t, here)))
      .sort((a, b) => Number(b.windowId === e.windowId) - Number(a.windowId === e.windowId));
    const tryOrder = [...(here && free(here) ? [here] : []), ...rest];
    const tried = new Set<string>();
    let hereMarkerless = false; // 기록한 자리의 탭을 읽어 보니 표시가 없었다
    let unprobed = false; // 멈춰서 표시를 못 읽은 후보가 있었다(그 탭이 우리 것일 수 있어 훑기가 「다 봤다」가 될 수 없다)
    for (const t of tryOrder) {
      let p: Probe;
      try {
        p = await this.backend.probe(t.windowId, t.index, PROBE_TIMEOUT_MS);
      } catch (err) {
        // 멈춘 탭(경고창 등)은 표시를 못 읽는다 — 주소가 같으면 그 탭으로 본다.
        // 단, 잃어버린 탭은 표시가 정확히 맞을 때만 돌아온다 — 같은 주소의 표시 없는 사용자 탭이 경고창에 막혀 있어도 우리 탭으로 되살리지 않는다(주소로 닫게 되므로).
        if (!e.lost && err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED") && sameUrl(t.url, e.url)) {
          e.blocked = true;
          return take(t);
        }
        // 그 밖의 오류(JS 허용 꺼짐 · 자동화 거부 · 호스트 오류)는 「탭이 닫힘」이 아니다 — 키를 지우지 않고 올린다.
        if (err instanceof SafariError && (err.code === "TIMEOUT" || err.code === "ALERT_BLOCKED")) {
          unprobed = true;
          tried.add(spotId(t)); // 같은 훑기에서 다시 읽으러 가지 않는다
          continue;
        }
        throw err;
      }
      tried.add(spotId(t));
      if (p.exists && p.marker === this.markerOf(e.key)) return take({ ...t, url: p.url });
      if (p.exists && p.marker === "" && here && sameSpot(t, here)) hereMarkerless = true;
    }

    // 자리 · 같은 주소로 못 찾았다. 우리가 연 탭이면 사용자가 순번을 밀고 주소도 바뀐 것일 수 있다 —
    // 아직 안 쓴 탭들의 표시를 읽기만 해서(상한 60개) 우리 표시와 정확히 같은 탭을 찾는다.
    if (!e.owned) return null;
    const sig = raw.map((t) => `${t.windowId}:${t.index}:${t.url}`).join("|");
    if (fromSync && e.lost && e.scanSig === sig) return null; // 지난번 훑은 때와 탭 목록이 같다 — 되풀이해 들여다보지 않는다
    const candidates = this.priorityOrder(raw.filter((t) => free(t) && !tried.has(spotId(t)) && isWebTab(t)), [e]);
    const complete = await this.readMarkersOf(candidates, scan);
    const mark = this.markerOf(e.key);
    for (const t of candidates.slice(0, SCAN_MAX_TABS)) {
      const r = scan.reads.get(spotId(t));
      if (r && r.marker === mark) return take({ ...t, url: r.url });
    }
    e.scanSig = sig;
    e.scanComplete = complete && !unprobed; // 읽지 못한 탭이 없었다면 true
    // 우리 표시가 어디에도 없다(모든 탭을 읽었다). 기록한 자리의 탭에 표시가 없으면 우리 탭이 스스로 새 문서가 된 것일 수 있다 —
    // 창 모습(탭 수 · 이웃)이 그대로일 때만 「표시 안 한 우리 탭」으로 되찾아, 다음 일 때 호스트가 주소를 확인하고 표시를 다시 적게 한다.
    if (e.scanComplete && !e.lost && !e.blocked && hereMarkerless && here && free(here) && this.stayedPut(e, raw, here)) {
      take(here);
      e.stamped = false;
      return here;
    }
    return null;
  }
}
