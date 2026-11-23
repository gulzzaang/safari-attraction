import { describe, expect, test } from 'vitest';
import { SafariError } from '../../src/driver/types.js';
import { TabRegistry, type Guarded, type MarkerRead, type Probe, type RawTab, type RebindResult, type SettleResult, type Spot, type TabBackend } from '../../src/driver/tab-registry.js';

/** 사파리 흉내: 창 하나에 탭들이 있고, 탭마다 페이지 안 표시(marker)를 가진다. */
class FakeSafari implements TabBackend {
  tabs: { url: string; marker: string; /** 표시를 읽을 수 없는 탭(JS 를 못 도는 특수 페이지 등) — readMarkers 결과에서 빠진다. */ unreadable?: boolean; /** 경고창이 떠 JS 에 답하지 않는 탭 — probe 가 시간 초과를 낸다(readMarkers 는 표시를 못 읽어 빼지 않고 빈 표시로 돌려준다). */ probeStuck?: boolean }[] = [];
  /** 켜 두면 close 가 한 번 시간 초과를 내고(탭은 실제로 닫힘) 이후는 정상. */
  closeTimesOutOnce = false;
  probeError: SafariError | null = null;
  list = async (): Promise<RawTab[]> =>
    this.tabs.map((t, i) => ({ windowId: 1, index: i + 1, title: t.url, url: t.url, isActive: i === 0 }));
  probe = async (windowId: number, index: number): Promise<Probe> => {
    if (this.probeError) throw this.probeError;
    const t = this.tabs[index - 1];
    if (t?.probeStuck) throw new SafariError('TIMEOUT', '탭이 답하지 않음');
    return t && windowId === 1 ? { exists: true, url: t.url, marker: t.marker } : { exists: false, url: '', marker: '' };
  };
  stamp = async (_w: number, index: number, key: string) => {
    this.tabs[index - 1]!.marker = key;
    return true;
  };
  rebind = async (a: { windowId: number; index: number; key: string }): Promise<RebindResult> => {
    const t = this.tabs[a.index - 1];
    if (!t) return { status: 'gone' };
    if (t.marker !== '' && t.marker !== a.key) return { status: 'other' };
    t.marker = a.key;
    return { status: 'ok', tab: { windowId: 1, index: a.index, title: t.url, url: t.url, isActive: false } };
  };
  /** 켜 두면 settle 이 「문서를 떠나는 중」이라고 답한다. */
  leaving = false;
  /** 켜 두면 commit 이동에서 표시를 못 적었다고(stamped:false) 답한다. */
  loseStampOnCommit = false;
  /** settle 이 받은 waitUntil 기록. */
  settleWaits: Array<string | undefined> = [];
  settle = async (a: { windowId: number; index: number; key: string; waitUntil?: 'commit'; loadBudgetMs?: number }): Promise<SettleResult> => {
    this.settleWaits.push(a.waitUntil);
    const t = this.tabs[a.index - 1];
    if (!t) return { status: 'gone' };
    const tab = { windowId: 1, index: a.index, title: t.url, url: t.url, isActive: false };
    if (t.marker === a.key) return { status: 'same', leaving: this.leaving, tab };
    if (t.marker !== '') return { status: 'other' };
    if (this.loseStampOnCommit && a.waitUntil === 'commit') return { status: 'navigated', tab, stamped: false }; // 새 문서가 떴지만 표시를 못 적었다
    t.marker = a.key;
    return { status: 'navigated', tab };
  };
  /** readMarkers 를 부른 묶음마다 자리 개수. */
  readCalls: number[] = [];
  /** readMarkers 로 들여다본 자리(`창:순번`) 전부. */
  readSpotLog: string[] = [];
  /** 켜 두면 다음 readMarkers 한 번이 시간 초과를 낸다(멈춘 탭이 든 묶음). */
  readStuckOnce = false;
  /** 켜 두면 readMarkers 가 이 오류를 낸다(예: JS_FROM_APPLE_EVENTS_OFF). */
  readError: SafariError | null = null;
  readMarkers = async (spots: Array<{ windowId: number; index: number }>, _timeoutMs: number): Promise<MarkerRead[]> => {
    this.readCalls.push(spots.length);
    for (const sp of spots) this.readSpotLog.push(`${sp.windowId}:${sp.index}`);
    if (this.readError) throw this.readError;
    if (this.readStuckOnce) {
      this.readStuckOnce = false;
      throw new SafariError('TIMEOUT', '표시 읽기가 시간 안에 끝나지 않음');
    }
    const out: MarkerRead[] = [];
    for (const sp of spots) {
      const t = this.tabs[sp.index - 1];
      if (t && !t.unreadable && sp.windowId === 1) out.push({ windowId: 1, index: sp.index, url: t.url, marker: t.marker });
    }
    return out;
  };
  close = async (s: Spot, urlOnly = false): Promise<Guarded<null>> => {
    const t = this.tabs[s.index - 1];
    const ok = t && (urlOnly ? t.url === s.url : t.marker === s.key || (s.unstamped && t.marker === '' && t.url === s.url));
    if (!ok) return { stale: true };
    this.tabs.splice(s.index - 1, 1);
    if (this.closeTimesOutOnce && !urlOnly) {
      this.closeTimesOutOnce = false;
      throw new SafariError('TIMEOUT', '닫기가 시간 안에 끝나지 않음');
    }
    return { value: null };
  };
}

function openOwned(sf: FakeSafari, reg: TabRegistry, url: string): string {
  sf.tabs.push({ url, marker: '' });
  const key = reg.nextKey();
  sf.tabs[sf.tabs.length - 1]!.marker = reg.markerOf(key);
  return reg.register(key, 1, sf.tabs.length, url, { owned: true, stamped: true });
}

describe('TabRegistry', () => {
  test('탭이 밀려도 resolve 는 표시로 같은 탭을 찾는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs.unshift({ url: 'http://a/x', marker: '' }); // 같은 주소의 다른 탭이 앞에 끼어듦
    expect(await reg.resolve(k)).toEqual({ windowId: 1, index: 2 });
  });

  test('닫힌 탭은 TAB_CLOSED 이고 우리 탭 목록에서 빠진다(다른 키의 표시가 있는 탭이 자리에 와도)', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs = [{ url: 'http://a/x', marker: 't9.deadbeef' }]; // 닫힘, 자리에는 다른 표시의 같은 주소 탭
    await expect(reg.closeTab(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(reg.ownedKeys()).toEqual([]);
    expect(sf.tabs).toHaveLength(1); // 남의 탭은 안 닫음
  });

  test('닫힌 탭의 자리가 비면 TAB_CLOSED 이고 키가 빠진다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs = [];
    await expect(reg.closeTab(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(reg.ownedKeys()).toEqual([]);
  });

  test('closeOwned 는 우리 탭만 닫고 센다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    sf.tabs.push({ url: 'http://user/1', marker: '' });
    openOwned(sf, reg, 'http://a/1');
    openOwned(sf, reg, 'http://a/2');
    expect((await reg.closeOwned()).closed).toBe(2);
    expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/1']);
  });

  test('sync 는 같은 탭에 같은 키를 주고 사용자 탭에 표시를 적지 않는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    sf.tabs.push({ url: 'http://user/1', marker: '' }, { url: 'http://user/2', marker: '' });
    const first = await reg.sync(await sf.list());
    expect(first.map((e) => e.owned)).toEqual([false, false]);
    sf.tabs.push({ url: 'http://user/3', marker: '' }); // 표시 없는 탭은 자리 + 주소로만 알아본다(자리가 밀리면 새 키)
    const second = await reg.sync(await sf.list());
    expect(second.slice(0, 2).map((e) => e.key)).toEqual(first.map((e) => e.key));
    expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
  });

  test('adopt 는 표시를 적고 탭이 밀려도 resolve 가 찾는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    sf.tabs.push({ url: 'http://user/1', marker: '' });
    const k = await reg.adopt(1, 1);
    expect(sf.tabs[0]!.marker).toBe(reg.markerOf(k));
    expect(reg.isOwned(k)).toBe(false);
    sf.tabs.unshift({ url: 'http://user/0', marker: '' });
    expect(await reg.resolve(k)).toEqual({ windowId: 1, index: 2 });
  });

  test('이동으로 표시가 사라져도 rebind 가 같은 키를 다시 붙인다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs[0] = { url: 'http://a/y', marker: '' }; // 전체 이동: 새 문서라 표시가 없고 주소가 바뀜
    await expect(reg.resolve(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' }); // 다시 붙이지 않으면 잃는다
    const k2 = openOwned(sf, reg, 'http://a/x2');
    sf.tabs[1] = { url: 'http://a/y2', marker: '' };
    const tab = await reg.rebind(k2);
    expect(tab.url).toBe('http://a/y2');
    expect(sf.tabs[1]!.marker).toBe(reg.markerOf(k2));
    sf.tabs.unshift({ url: 'http://user/0', marker: '' }); // 그 뒤에 탭이 밀려도
    expect(await reg.resolve(k2)).toEqual({ windowId: 1, index: 3 });
    expect(reg.isOwned(k2)).toBe(true);
    expect((await reg.closeOwned()).closed).toBe(1);
  });

  test('rebind: 기록한 자리에 다른 키의 표시가 있으면 TAB_CLOSED', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const a = openOwned(sf, reg, 'http://a/1');
    const b = openOwned(sf, reg, 'http://a/2');
    sf.tabs.reverse(); // 두 탭 자리가 바뀜 — a 의 기록 자리에 b 의 표시가 있다
    sf.tabs[1] = { url: 'http://a/new', marker: '' }; // a 는 이동해 표시를 잃음
    await expect(reg.rebind(a)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(reg.ownedKeys()).toEqual([b]);
  });

  test('settle: 표시가 이 키면 이동 없음(떠나는 중인지도 전한다)', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    expect(await reg.settle(k)).toMatchObject({ navigated: false, leaving: false });
    sf.leaving = true;
    expect(await reg.settle(k)).toMatchObject({ navigated: false, leaving: true });
  });

  test('settle: 표시가 비었으면(새 문서) 이동으로 보고 키를 지키고 표시를 다시 적는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs[0] = { url: 'http://a/y', marker: '' }; // 전체 이동 — 이때 runJs/resolve 는 키를 잃지만 settle 은 아니다
    const r = await reg.settle(k);
    expect(r).toMatchObject({ navigated: true, leaving: false });
    expect(r.tab.url).toBe('http://a/y');
    expect(sf.tabs[0]!.marker).toBe(reg.markerOf(k));
    expect(reg.ownedKeys()).toEqual([k]); // 키가 남았다
    expect(await reg.resolve(k)).toEqual({ windowId: 1, index: 1 }); // 이후에도 찾는다
    expect((await reg.closeOwned()).closed).toBe(1);
  });

  test('settle: commit 이동에서 표시를 못 적어도 붙인(사용자) 탭의 키를 잃지 않는다 — 다음 일에서 자리 · 주소로 알아보고 표시를 다시 적는다', async () => {
    const sf = new FakeSafari();
    sf.tabs.push({ url: 'http://a/x', marker: '' });
    const reg = new TabRegistry(sf);
    const k = reg.nextKey();
    reg.register(k, 1, 1, 'http://a/x', { owned: false, stamped: true }); // 붙인 사용자 탭(표시는 적혀 있었다)
    sf.tabs[0] = { url: 'http://a/y', marker: '' }; // 전체 이동 — 새 문서에는 표시가 없다
    sf.loseStampOnCommit = true;
    const r = await reg.settle(k, { waitUntil: 'commit' });
    expect(r.navigated).toBe(true);
    expect(sf.tabs[0]!.marker).toBe(''); // 못 적었다
    // 호스트의 runJs 처럼: 표시가 키이거나, 표시 안 한 탭(unstamped)이면서 표시가 없고 주소가 같을 때만 돈다(그리고 표시를 적는다)
    const guard = async (s: Spot): Promise<Guarded<string>> => {
      const t = sf.tabs[s.index - 1];
      if (!t) return { stale: true };
      if (t.marker === s.key || (s.unstamped && t.marker === '' && t.url === s.url)) {
        t.marker = s.key;
        return { value: 'ok' };
      }
      return { stale: true };
    };
    expect(await reg.withTab(k, guard)).toBe('ok'); // TAB_CLOSED 없이
    expect(sf.tabs[0]!.marker).toBe(reg.markerOf(k));
    expect(reg.urlOf(k)).toBe('http://a/y'); // 키가 그대로 남았다
  });

  test('settle: 문서를 떠나는 중(same, leaving)이면 호스트가 알린 옛 문서의 주소를 기록한다 — 가는 중인 목적지로 바꾸지 않는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/old');
    sf.tabs[0]!.url = 'http://a/dest'; // 사파리의 tab.url() 은 가는 중인 목적지를 돌려준다
    // 호스트는 same 일 때 그 문서 자신의 location.href(옛 주소)를 tab.url 로 알린다
    sf.settle = async (a) => ({ status: 'same', leaving: true, tab: { windowId: 1, index: a.index, title: '', url: 'http://a/old', isActive: false } });
    const r = await reg.settle(k);
    expect(r).toMatchObject({ navigated: false, leaving: true });
    expect(reg.urlOf(k)).toBe('http://a/old');
  });

  test('navTimedOut: 붙인 사용자 탭은 「표시 안 한 탭」이 돼, 늦게 새 문서가 떠도(표시 없음 · 목적지 주소) 다음 일에서 다시 알아보고 키를 지킨다', async () => {
    const sf = new FakeSafari();
    sf.tabs.push({ url: 'http://a/old', marker: '' });
    const reg = new TabRegistry(sf);
    const k = reg.nextKey();
    reg.register(k, 1, 1, 'http://a/old', { owned: false, stamped: true });
    sf.tabs[0] = { url: 'http://a/dest', marker: reg.markerOf(k) }; // 아직 옛 문서(표시 그대로), 사파리는 목적지를 보고한다
    await reg.navTimedOut(k);
    expect(reg.urlOf(k)).toBe('http://a/old'); // 기록한 주소는 그대로
    expect(reg.spot(k)).toMatchObject({ unstamped: true, altUrl: 'http://a/dest' });
    sf.tabs[0] = { url: 'http://a/dest', marker: '' }; // 늦게 새 문서가 뜸
    const guard = async (s: Spot): Promise<Guarded<string>> => {
      const t = sf.tabs[s.index - 1];
      if (!t) return { stale: true };
      if (t.marker === s.key || (s.unstamped && t.marker === '' && (t.url === s.url || t.url === s.altUrl))) {
        t.marker = s.key;
        return { value: 'ok' };
      }
      return { stale: true };
    };
    expect(await reg.withTab(k, guard)).toBe('ok'); // TAB_CLOSED 없이
    expect(sf.tabs[0]!.marker).toBe(reg.markerOf(k));
    expect(reg.spot(k)).toMatchObject({ unstamped: false });
  });

  test('navTimedOut: 새 문서가 뜨지 않고 옛 문서 그대로면 다음 일에서 도로 표시 있는 탭이 된다', async () => {
    const sf = new FakeSafari();
    sf.tabs.push({ url: 'http://a/old', marker: '' });
    const reg = new TabRegistry(sf);
    const k = reg.nextKey();
    reg.register(k, 1, 1, 'http://a/old', { owned: false, stamped: true });
    sf.tabs[0] = { url: 'http://a/dest', marker: reg.markerOf(k) };
    await reg.navTimedOut(k);
    const guard = async (s: Spot): Promise<Guarded<string>> => (sf.tabs[s.index - 1]!.marker === s.key ? { value: 'ok' } : { stale: true });
    expect(await reg.withTab(k, guard)).toBe('ok');
    expect(reg.spot(k)).toMatchObject({ unstamped: false });
    expect(reg.spot(k).altUrl).toBeUndefined();
  });

  test('navTimedOut: 우리가 연 탭이거나 표시가 이미 없는 탭은 건드리지 않는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs[0]!.marker = reg.markerOf(k);
    await reg.navTimedOut(k);
    expect(reg.spot(k).unstamped).toBe(false); // owned
    const k2 = reg.nextKey();
    sf.tabs.push({ url: 'http://a/y', marker: '' });
    reg.register(k2, 1, 2, 'http://a/y', { owned: false, stamped: true });
    await reg.navTimedOut(k2); // 표시가 이미 없다
    expect(reg.spot(k2).unstamped).toBe(false);
  });

  test('settle: waitUntil commit 은 호스트까지 그대로 전해진다(안 주면 빈 값)', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    await reg.settle(k);
    await reg.settle(k, { waitUntil: 'commit' });
    expect(sf.settleWaits).toEqual([undefined, 'commit']);
  });

  test('settle: 자리에 다른 키의 표시가 있으면 표시로 찾고, 못 찾을 때만 TAB_CLOSED 로 키를 지운다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const a = openOwned(sf, reg, 'http://a/1');
    const b = openOwned(sf, reg, 'http://a/2');
    sf.tabs.reverse(); // 자리가 바뀜 — a 는 이제 2번째, 기록한 1번째엔 b 의 표시
    expect(await reg.settle(a)).toMatchObject({ navigated: false });
    expect(sf.tabs[1]!.marker).toBe(reg.markerOf(a));
    sf.tabs.splice(1, 1); // a 가 닫힘
    await expect(reg.settle(a)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(reg.ownedKeys()).toEqual([b]);
    await expect(reg.settle('t99')).rejects.toMatchObject({ code: 'TAB_CLOSED' });
  });

  test('표시를 읽다 난 다른 오류는 TAB_CLOSED 로 바꾸지 않고 키도 지우지 않는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs.unshift({ url: 'http://user/0', marker: '' }); // 기록한 자리의 탭이 달라져 probe 를 하게 된다
    sf.probeError = new SafariError('JS_FROM_APPLE_EVENTS_OFF', '꺼짐');
    await expect(reg.resolve(k)).rejects.toMatchObject({ code: 'JS_FROM_APPLE_EVENTS_OFF' });
    expect(reg.ownedKeys()).toEqual([k]);
  });

  test('목록만 본 사용자 탭은 자리가 바뀌면 같은 주소의 다른 탭으로 옮겨 잡지 않는다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    sf.tabs.push({ url: 'http://user/same', marker: '' }, { url: 'http://user/z', marker: '' }, { url: 'http://user/same', marker: '' });
    const [a] = await reg.sync(await sf.list());
    sf.tabs.shift(); // 사용자가 A 를 닫음 — 같은 주소의 B 는 2번째로 당겨졌다
    await expect(reg.closeTab(a!.key)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(sf.tabs).toHaveLength(2); // B 는 그대로
  });

  test('[M3] 표시 없는 탭은 주소 꼴이 달라도(끝 슬래시) 같은 탭으로 알아본다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    sf.tabs.push({ url: 'https://a.com', marker: '' });
    const [a] = await reg.sync(await sf.list());
    sf.tabs[0]!.url = 'https://a.com/'; // 문서 자신의 주소(location.href)로 기록이 바뀐 것과 같은 꼴 차이
    const again = await reg.sync(await sf.list());
    expect(again[0]!.key).toBe(a!.key);
  });

  test('닫기가 시간 초과한 뒤 탭이 이미 없으면 성공으로 센다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    openOwned(sf, reg, 'http://a/1');
    openOwned(sf, reg, 'http://a/2');
    sf.closeTimesOutOnce = true;
    expect((await reg.closeOwned()).closed).toBe(2);
    expect(sf.tabs).toHaveLength(0);
  });

  test('일을 마친 뒤 돌려준 주소로 기록을 새로 한다', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    await reg.withTab(k, async () => ({ value: 1, url: 'http://a/x#spa' }));
    expect(reg.spot(k).url).toBe('http://a/x#spa');
  });
  test('다른 서버 프로세스의 표시는 같은 키여도 맞지 않는다', async () => {
    const sf = new FakeSafari();
    const mine = new TabRegistry(sf, 'aaaa1111');
    const other = new TabRegistry(sf, 'bbbb2222');
    expect(mine.markerOf('t1')).not.toBe(other.markerOf('t1'));
    const k = openOwned(sf, mine, 'http://a/x'); // t1
    // 다른 서버도 같은 사파리에서 t1 을 쓴다 — 그 탭이 앞에 끼어들어 자리가 밀렸다
    const otherKey = other.nextKey();
    expect(otherKey).toBe(k);
    sf.tabs.unshift({ url: 'http://a/x', marker: other.markerOf(otherKey) });
    expect(await mine.resolve(k)).toEqual({ windowId: 1, index: 2 }); // 주소가 같아도 내 표시의 탭만 잡는다
    // 내 탭이 사라지면 다른 서버의 t1 을 내 것으로 착각하지 않는다
    sf.tabs.splice(1, 1);
    await expect(mine.resolve(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(sf.tabs).toHaveLength(1); // 다른 서버의 탭은 그대로
    // 끝난 세션이 남긴 옛 표시도 맞지 않는다
    const k2 = openOwned(sf, mine, 'http://a/y');
    sf.tabs.unshift({ url: 'http://a/y', marker: `${k2}.deadbeef` });
    expect((await mine.closeOwned()).closed).toBe(1);
    expect(sf.tabs.map((t) => t.marker)).toEqual([`${k2}.deadbeef`, other.markerOf(otherKey)]);
  });

  describe('예기치 못한 이동으로 표시가 사라진 우리 탭', () => {
    test('withTab: 새 문서로 표시를 잃은 탭에는 표시를 다시 적지 않는다(TAB_CLOSED, 표시 없는 탭은 그대로)', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' }; // XHR 뒤 늦은 이동 · JS 리다이렉트: 새 문서라 표시가 없다
      const run = async (s: Spot): Promise<Guarded<string>> => (sf.tabs[s.index - 1]?.marker === s.key ? { value: 'ok' } : { stale: true });
      await expect(reg.withTab(k, run)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      expect(sf.tabs).toEqual([{ url: 'http://a/after', marker: '' }]);
      expect(reg.ownedKeys()).toEqual([]); // 보이는 목록에서는 빠진다(잃어버림)
    });

    test('sync(listTabs): 표시를 잃은 우리 탭은 목록에서 빠지고 표시 없는 탭에 표시를 적지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' };
      const listed = await reg.sync(await sf.list());
      expect(listed).toHaveLength(1);
      expect(listed[0]!.owned).toBe(false);
      expect(sf.tabs).toEqual([{ url: 'http://a/after', marker: '' }]);
    });

    test('closeOwned: 표시를 잃은(표시 없는) 탭은 자리 · 주소가 비슷해도 닫지 않고, 표시가 있는 우리 탭만 닫는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' };
      openOwned(sf, reg, 'http://a/y'); // 표시가 있는 우리 탭
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs).toEqual([{ url: 'http://a/after', marker: '' }]);
    });

    test('표시를 잃었다가 이동을 시킨 쪽이 rebind 하면 우리 탭으로 되살아나 닫힌다(진행 중인 동작 바로 뒤)', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' };
      await reg.rebind(k);
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs).toHaveLength(0);
    });

    test('탭이 정말 닫혔으면(표시 없는 다른 탭이 자리에 와도 주소가 다르면) 지금처럼 TAB_CLOSED', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs.splice(0, 1); // 사용자가 닫음
      await expect(reg.withTab(k, async () => ({ stale: true }))).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      expect(reg.ownedKeys()).toEqual([]);
    });
  });

  describe('표시로 다시 찾기 · 잃어버림 · 닫을 때 훑기', () => {
    /** 우리 탭 앞에 사용자 탭이 끼고(순번 +1), 우리 탭 주소가 바뀐(표시는 같은 문서라 남음) 사파리. */
    function shiftedAndRedirected() {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs.unshift({ url: 'http://user/new', marker: '' });
      sf.tabs[1]!.url = 'http://a/x?redirected=1';
      return { sf, reg, k };
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    function manyTabs(n: number) {
      const sf = new FakeSafari();
      for (let i = 1; i <= n; i++) sf.tabs.push({ url: `http://user/${i}`, marker: '' });
      return sf;
    }

    test('[포커스 1] 순번이 밀리고 주소도 바뀐 우리 탭을 sync 뒤에도 우리 탭으로 알아보고, closeOwned 가 닫는다', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      const listed = await reg.sync(await sf.list());
      expect(listed.find((e) => e.raw.url === 'http://a/x?redirected=1')).toMatchObject({ key: k, owned: true });
      expect(reg.ownedKeys()).toEqual([k]);
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/new']);
    });

    test('[포커스 1] sync 없이 바로 closeOwned 해도 닫고, 자리에 와 있던 사용자 탭에 우리 표시를 적지 않는다', async () => {
      const { sf, reg } = shiftedAndRedirected();
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs).toEqual([{ url: 'http://user/new', marker: '' }]);
    });

    test('[포커스 1] sync 가 표시를 못 읽어 못 찾아도(잃어버림) 보이는 목록에서는 빠지고, closeOwned 가 표시 훑기로 닫는다', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      sf.readStuckOnce = true; // sync 때 표시 읽기가 멈춰 못 찾음
      const listed = await reg.sync(await sf.list());
      expect(listed.every((e) => !e.owned)).toBe(true); // 보이는 목록에서는 뺀다
      expect(reg.ownedKeys()).toEqual([]);
      expect(reg.isOwned(k)).toBe(true); // 하지만 잊지는 않았다
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/new']);
    });

    test('잃어버린 탭도 나중에 표시가 보이면 다시 우리 탭으로 돌아온다', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      sf.readStuckOnce = true;
      await reg.sync(await sf.list());
      expect(reg.ownedKeys()).toEqual([]);
      sf.tabs.push({ url: 'http://user/another', marker: '' }); // 탭 목록이 바뀌어 다시 훑는다
      const listed = await reg.sync(await sf.list());
      expect(listed.find((e) => e.raw.url === 'http://a/x?redirected=1')).toMatchObject({ key: k, owned: true });
      expect(reg.ownedKeys()).toEqual([k]);
    });

    test('못 찾은 탭을 탭 목록이 그대로인 채 sync 마다 되풀이해 들여다보지 않는다', async () => {
      const { sf, reg } = shiftedAndRedirected();
      sf.tabs[1]!.marker = ''; // 우리 탭의 표시가 사라졌다(어디에도 없다)
      await reg.sync(await sf.list());
      const after1 = sf.readCalls.length;
      expect(after1).toBeGreaterThan(0);
      await reg.sync(await sf.list());
      await reg.sync(await sf.list());
      expect(sf.readCalls.length).toBe(after1);
    });

    test('[포커스 2] 같은 주소의 사용자 탭(표시 없음)이 앞에 있어도 닫지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/search?q=1');
      sf.tabs.unshift({ url: 'http://a/search?q=1', marker: '' }); // 사용자가 같은 검색 쪽을 따로 열어 앞에 둠
      sf.tabs[1]!.url = 'http://a/search?q=1&page=2'; // 우리 탭은 주소가 바뀜
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs).toEqual([{ url: 'http://a/search?q=1', marker: '' }]);
    });

    test('[포커스 2] 같은 주소의 사용자 탭이 뒤에 있어도 닫지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/search?q=1');
      sf.tabs.unshift({ url: 'http://user/0', marker: '' });
      sf.tabs.push({ url: 'http://a/search?q=1', marker: '' });
      sf.tabs[1]!.url = 'http://a/search?q=1&page=2';
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/0', 'http://a/search?q=1']);
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
    });

    test('[포커스 3] 사용자가 우리 탭을 닫았으면(탭 수는 상한 안) 못 찾음 안내 없이 조용히 정리하고 아무 탭도 닫지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' }, { url: 'http://user/2', marker: '' });
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs.pop(); // 사용자가 우리 탭을 닫음
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/1', 'http://user/2']);
      expect(reg.isOwned(k)).toBe(false); // 정리됐다
    });

    test('[포커스 3] sync 로 잃어버림이 된 뒤에 탭이 정말 닫힌 것이 드러나도 못 찾음이 아니다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' }, { url: 'http://user/2', marker: '' });
      openOwned(sf, reg, 'http://a/x');
      await reg.sync(await sf.list());
      sf.tabs.pop();
      sf.tabs.shift();
      await reg.sync(await sf.list()); // 못 찾음 → 잃어버림
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.tabs).toHaveLength(1);
    });

    test('잃어버린 탭은 표시가 정확히 맞을 때만 돌아온다 — 그 자리에 새로 온 사용자 탭에 표시를 적지 않는다(sync)', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' }, { url: 'http://user/2', marker: '' });
      openOwned(sf, reg, 'http://a/x');
      await reg.sync(await sf.list());
      sf.tabs.pop(); // 우리 탭이 닫힘
      await reg.sync(await sf.list()); // 못 찾음 → 잃어버림
      sf.tabs.push({ url: 'http://user/new', marker: '' }); // 사용자가 새 탭을 열어 우리 옛 자리(3번)에 온다
      const listed = await reg.sync(await sf.list());
      expect(listed.every((e) => !e.owned)).toBe(true);
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.tabs).toHaveLength(3);
    });

    test('잃어버린 탭의 키로 일을 시켜도(withTab · settle · rebind) 자리에 온 표시 없는 사용자 탭에 표시를 적지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' });
      const k = openOwned(sf, reg, 'http://a/x');
      await reg.sync(await sf.list());
      sf.tabs.pop();
      await reg.sync(await sf.list()); // 잃어버림
      sf.tabs.push({ url: 'http://user/new', marker: '' }); // 우리 옛 자리(2번)에 사용자 탭
      const run = async (s: Spot): Promise<Guarded<string>> => (sf.tabs[s.index - 1]?.marker === s.key ? { value: 'ok' } : { stale: true });
      await expect(reg.withTab(k, run)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      await expect(reg.settle(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      await expect(reg.rebind(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
    });

    // 끝낼 때는 우리 표시가 있는 탭만 닫는다 — 우리 옛 자리로 밀려 온 표시 없는 사용자 탭은 「우리 탭이 새 문서가 돼 표시를 잃은 것」과 겉으로 같아도 건드리지 않는다.
    test('[포커스 3] 우리 탭 뒤에 사용자 탭이 있었고 우리 탭이 닫혔어도, 밀려 온 표시 없는 사용자 탭은 닫지도 표시를 적지도 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' });
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.push({ url: 'http://user/2', marker: '' });
      sf.tabs.splice(1, 1); // 사용자가 우리 탭을 닫음 — user/2 가 우리 옛 자리로 당겨짐
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.tabs).toEqual([{ url: 'http://user/1', marker: '' }, { url: 'http://user/2', marker: '' }]);
    });

    test('표시 없이 기억한(unstamped) 우리 탭은 자리 · 주소가 그대로일 때만 닫고, 한 번 못 찾으면 잃어버림으로 남기지 않고 잊는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://a/x', marker: '' });
      const k = reg.nextKey();
      reg.register(k, 1, 1, 'http://a/x', { owned: true, stamped: false });
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 }); // 자리 · 주소가 그대로
      expect(sf.tabs).toHaveLength(0);

      const k2 = reg.nextKey();
      sf.tabs.push({ url: 'http://a/x', marker: '' });
      reg.register(k2, 1, 1, 'http://a/x', { owned: true, stamped: false });
      sf.tabs.unshift({ url: 'http://user/front', marker: '' }); // 자리가 밀림
      await reg.sync(await sf.list());
      expect(reg.isOwned(k2)).toBe(false); // 잃어버림이 아니라 잊었다
      // 나중에 표시 없는 사용자 탭이 그 옛 자리에 같은 주소로 나타나도 되살리지도 닫지도 않는다
      sf.tabs[0] = { url: 'http://a/x', marker: '' };
      await reg.sync(await sf.list());
      expect(reg.isOwned(k2)).toBe(false);
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.tabs).toHaveLength(2);
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
    });

    test('잃어버린(표시 있던) 탭이 있어도 표시 없는 같은 주소 탭이 자리에 나타나면 되살리지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[1]!.url = 'http://a/x?r=1';
      sf.readStuckOnce = true;
      await reg.sync(await sf.list()); // 잃어버림
      sf.tabs.pop();
      sf.tabs.push({ url: 'http://a/x?r=1', marker: '' }); // 표시 없는 같은 주소의 사용자 탭
      const listed = await reg.sync(await sf.list());
      expect(listed.every((e) => !e.owned)).toBe(true);
      expect(reg.isOwned(k)).toBe(true);
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
    });

    test('모든 탭을 읽고도 표시가 없으면 잃어버림으로 남기지 않고 잊는다(sync 마다 되풀이해 훑지 않는다)', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      sf.tabs[1]!.marker = '';
      await reg.sync(await sf.list());
      expect(reg.isOwned(k)).toBe(false);
    });

    test('같은 훑기 안에서 멈춘 묶음은 다시 시도하지 않는다', async () => {
      const sf = manyTabs(25);
      const reg = new TabRegistry(sf);
      const a = openOwned(sf, reg, 'http://a/1');
      const b = openOwned(sf, reg, 'http://a/2');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[26]!.marker = '';
      sf.tabs[27]!.marker = ''; // 두 우리 탭 모두 표시가 어디에도 없다
      sf.readStuckOnce = true;
      await reg.sync(await sf.list());
      expect(sum(sf.readCalls)).toBeLessThanOrEqual(27); // 탭 27개를 각각 한 번만(멈춘 묶음도 다시 보내지 않는다)
      expect(reg.isOwned(a) && reg.isOwned(b)).toBe(true); // 멈춘 묶음이 있어 「없다」고 단정하지 못했다(잃어버림)
    });

    test('표시를 읽을 수 없는 탭이 있으면 못 본 것으로 세어, 못 찾은 우리 탭은 missing 에 든다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' }, { url: 'http://user/special', marker: '', unreadable: true });
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.pop(); // 사용자가 우리 탭을 닫았다 — 하지만 읽을 수 없는 탭이 있어 확신하지 못한다
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 1 });
      expect(sf.tabs).toHaveLength(2);
    });

    test('표시를 읽을 수 없는 탭이 있어도 읽을 수 있는 곳에서 찾으면 닫는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/special', marker: '', unreadable: true });
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[2]!.url = 'http://a/x?r=1';
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/front', 'http://user/special']);
    });

    test('「Apple 이벤트에서 JavaScript 허용」이 꺼져 표시 훑기가 안 돼도 sync 는 던지지 않는다(못 본 것으로 두고 계속) — closeOwned 는 못 찾음으로 센다', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      sf.readError = new SafariError('JS_FROM_APPLE_EVENTS_OFF', '꺼짐');
      const listed = await reg.sync(await sf.list());
      expect(listed.every((e) => !e.owned)).toBe(true);
      expect(reg.isOwned(k)).toBe(true); // 못 본 것이라 잊지 않았다
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 1 });
    });

    test('[포커스 4] 탭이 150개일 때 우리 탭이 60개 밖에 있어 못 봤으면 못 찾음(missing 1)이고 아무 탭도 닫지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x'); // 기록한 순번 1
      for (let i = 1; i <= 149; i++) sf.tabs.push({ url: `http://user/${i}`, marker: '' });
      // 우리 탭이 130번째로 밀리고 주소도 바뀜
      sf.tabs.splice(0, 1);
      sf.tabs.splice(129, 0, { url: 'http://a/x?moved=1', marker: reg.markerOf(k) });
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs.splice(1, 1); // 150개
      expect(sf.tabs).toHaveLength(150);
      const before = JSON.stringify(sf.tabs);
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 1 });
      expect(sum(sf.readCalls)).toBeLessThanOrEqual(120); // 닫기 중 다시 찾기 60 + 마지막 훑기 60
      expect(Math.max(...sf.readCalls)).toBeLessThanOrEqual(10);
      expect(JSON.stringify(sf.tabs)).toBe(before); // 사용자 탭 · 우리 탭 모두 그대로, 표시도 안 적었다
    });

    test('[포커스 4] 탭이 150개여도 훑기는 60개 · 짧은 묶음으로 끝난다(resolve)', async () => {
      const sf = manyTabs(150);
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[151]!.url = 'http://a/x?r=1';
      const t0 = Date.now();
      expect(await reg.resolve(k)).toEqual({ windowId: 1, index: 152 });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(sum(sf.readCalls)).toBeLessThanOrEqual(60);
      expect(Math.max(...sf.readCalls)).toBeLessThanOrEqual(10);
    });

    test('[포커스 4] 탭 150개에서 못 찾는 우리 탭: resolve 의 훑기는 60개를 넘지 않고, 못 본 탭이 있으니 잊지 않는다', async () => {
      const sf = manyTabs(150);
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs[150]!.marker = ''; // 우리 탭의 표시가 어디에도 없다
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      await expect(reg.resolve(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      expect(sum(sf.readCalls)).toBeLessThanOrEqual(60);
      expect(reg.isOwned(k)).toBe(true);
    });

    test('못 본 탭이 있을 때는 자리에 와 있는 표시 없는 사용자 탭에 우리 표시를 적지 않는다', async () => {
      const sf = manyTabs(150);
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x'); // 기록한 순번 151
      for (let i = 0; i < 100; i++) sf.tabs.unshift({ url: `http://user/front${i}`, marker: '' }); // 우리 탭은 251번째(60개 밖)로 밀림, 151번째는 사용자 탭
      sf.tabs[250]!.url = 'http://a/x?r=1';
      const run = async (s: Spot): Promise<Guarded<string>> => (sf.tabs[s.index - 1]?.marker === s.key ? { value: 'ok' } : { stale: true });
      await expect(reg.withTab(k, run)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
      expect(sf.tabs[150]!.marker).toBe(''); // 자리에 있던 사용자 탭
      expect(sf.tabs.filter((t) => t.marker !== '')).toHaveLength(1); // 표시는 우리 탭에만
      expect(reg.isOwned(k)).toBe(true); // 잃어버림으로 남았다
    });

    test('멈춘 탭이 든 묶음은 건너뛰고, closeOwned 의 표시 훑기가 나머지에서 찾아 닫는다', async () => {
      const sf = manyTabs(25);
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[26]!.url = 'http://a/x?r=1';
      sf.readStuckOnce = true; // 순번이 가까운 첫 묶음이 멈춤
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.every((t) => t.marker === '')).toBe(true);
      expect(sf.tabs).toHaveLength(26);
    });

    test('우리 항목 표시가 아닌 표시(붙잡은 사용자 탭 · 다른 서버 · 끝난 세션)는 훑어도 닫지 않는다', async () => {
      const sf = new FakeSafari();
      const mine = new TabRegistry(sf, 'aaaa1111');
      sf.tabs.push({ url: 'http://user/adopted', marker: '' });
      const adopted = await mine.adopt(1, 1); // 사용자 탭을 붙잡음 — 우리 instanceId 의 표시가 적힌다
      const k = openOwned(sf, mine, 'http://a/x');
      sf.tabs.push({ url: 'http://other/1', marker: 't1.bbbb2222' }, { url: 'http://old/1', marker: `${k}.deadbeef` });
      sf.tabs[1]!.url = 'http://a/x?r=1';
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      expect(await mine.closeOwned()).toEqual({ closed: 1, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/front', 'http://user/adopted', 'http://other/1', 'http://old/1']);
      expect(mine.isOwned(adopted)).toBe(false);
    });

    // R3-1: 잃어버린 탭은 표시가 정확히 맞을 때만 돌아온다 — 같은 주소에 경고창이 떠 표시를 못 읽는 사용자 탭을 「경고창 탭」으로 되살려 주소로 닫지 않는다.
    test('[R3] 잃어버린 우리 탭의 옛 주소와 같고 경고창에 막힌(표시 없는) 사용자 탭을 되살리지도 닫지도 않는다', async () => {
      const { sf, reg, k } = shiftedAndRedirected();
      sf.readError = new SafariError('TIMEOUT', '표시 읽기 멈춤'); // 표시 훑기가 계속 안 된다
      await reg.sync(await sf.list()); // 우리 탭을 못 찾아 잃어버림 — 기록한 주소는 옛 주소 http://a/x 그대로
      expect(reg.ownedKeys()).toEqual([]);
      sf.tabs.push({ url: 'http://a/x', marker: '', probeStuck: true }); // 사용자의 같은 주소 탭, 경고창이 떠 표시를 못 읽음
      const listed = await reg.sync(await sf.list());
      expect(listed.every((e) => !e.owned)).toBe(true); // 되살리지 않았다
      expect(reg.ownedKeys()).toEqual([]);
      expect(reg.isOwned(k)).toBe(true); // 우리 탭은 아직 잃어버림으로 남아 있다
      sf.readError = null;
      expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 }); // 표시로 찾은 진짜 우리 탭만 닫는다
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/new', 'http://a/x']); // 경고창 탭은 그대로
    });

    test('[R3] 잃어버린 우리 탭이 정말 닫혔다면 같은 주소의 경고창 사용자 탭은 끝까지 안 닫는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'http://user/1', marker: '' });
      const k = openOwned(sf, reg, 'http://a/x');
      sf.readError = new SafariError('TIMEOUT', '표시 읽기 멈춤');
      sf.tabs.unshift({ url: 'http://user/front', marker: '' });
      sf.tabs[2]!.url = 'http://a/x?r=1';
      await reg.sync(await sf.list()); // 잃어버림
      sf.readError = null;
      sf.tabs.pop(); // 우리 탭이 닫힘
      sf.tabs.push({ url: 'http://a/x', marker: '', probeStuck: true });
      await reg.sync(await sf.list());
      expect(reg.ownedKeys()).toEqual([]);
      expect(reg.isOwned(k)).toBe(true);
      const before = JSON.stringify(sf.tabs);
      await reg.closeOwned();
      expect(JSON.stringify(sf.tabs)).toBe(before);
    });

    // R3-2: 우리 페이지 탭은 항상 http(s) 다 — 시작 페이지 · 즐겨찾기 · about: · 빈 주소 탭은 표시를 읽지 않고, 못 읽은 탭으로 세지도 않는다.
    test('[R3] http(s) 가 아닌 탭(시작 페이지 · 즐겨찾기 · about · 빈 주소)은 표시를 읽으러 들여다보지 않고, 훑기를 못 끝낸 것으로 세지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      sf.tabs.push({ url: 'favorites://', marker: '', unreadable: true }, { url: '', marker: '', unreadable: true }, { url: 'about:blank', marker: '', unreadable: true }, { url: 'http://user/1', marker: '' });
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.pop(); // 사용자가 우리 탭을 닫았다
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 }); // 「못 찾았어요」가 아니라 조용히 정리
      expect(sf.readSpotLog).toEqual(['1:4']); // http 탭 하나만 읽었다
    });

    test('[R3] http(s) 가 아닌 탭은 60개 상한에도 들지 않는다 — 웹 탭이 60개 이하면 다 본 것이다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      for (let i = 0; i < 10; i++) sf.tabs.push({ url: 'favorites://', marker: '', unreadable: true });
      for (let i = 1; i <= 55; i++) sf.tabs.push({ url: `http://user/${i}`, marker: '' });
      openOwned(sf, reg, 'http://a/x');
      sf.tabs.pop(); // 우리 탭이 닫혔다 — 전체 탭 65개, 웹 탭 55개
      expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
      expect(sf.readSpotLog).toHaveLength(55);
    });

    // R4: 스스로 새 문서가 돼 표시를 잃은 우리 탭(늦은 리디렉트)은, 마지막으로 기록한 창 모습과 비교해 탭 수 · 이웃 주소가 같고 주소가 다른 탭들의 기록 주소가 아닐 때만 되찾는다.
    describe('스스로 옮겨 간 우리 탭(R4)', () => {
      /** 호스트가 하는 확인을 흉내 낸다: 표시가 맞거나, 표시 안 한 탭이면 표시가 없고 주소가 같을 때 표시를 적고 일한다. */
      const run = (sf: FakeSafari) => async (s: Spot): Promise<Guarded<string>> => {
        const t = sf.tabs[s.index - 1];
        if (!t) return { stale: true };
        if (t.marker === s.key) return { value: 'ok' };
        if (s.unstamped && t.marker === '' && t.url === s.url) {
          t.marker = s.key;
          return { value: 'ok' };
        }
        return { stale: true };
      };
      /** [u1, 우리 탭, u2] 를 열고 창 모습을 기록(sync)해 둔다. */
      async function threeTabs() {
        const sf = new FakeSafari();
        const reg = new TabRegistry(sf);
        sf.tabs.push({ url: 'http://user/1', marker: '' });
        const k = openOwned(sf, reg, 'http://a/x');
        sf.tabs.push({ url: 'http://user/2', marker: '' });
        await reg.sync(await sf.list());
        return { sf, reg, k };
      }
      const lateRedirect = (sf: FakeSafari) => {
        sf.tabs[1]!.marker = ''; // 새 문서가 떠 표시가 사라짐
        sf.tabs[1]!.url = 'http://a/next';
      };

      test('(a) 늦은 리디렉트로 표시를 잃어도 탭 수 · 이웃이 그대로면 다음 일에서 되찾아 표시를 다시 적고 일한다', async () => {
        const { sf, reg, k } = await threeTabs();
        lateRedirect(sf);
        expect(await reg.withTab(k, run(sf))).toBe('ok');
        expect(sf.tabs[1]!.marker).toBe(reg.markerOf(k));
        expect(sf.tabs[0]!.marker + sf.tabs[2]!.marker).toBe(''); // 사용자 탭에는 안 적었다
        expect(reg.urlOf(k)).toBe('http://a/next');
      });

      test('(a) 끝낼 때(closeOwned)도 탭 수 · 이웃이 그대로면 그 탭을 닫는다', async () => {
        const { sf, reg } = await threeTabs();
        lateRedirect(sf);
        expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
        expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/1', 'http://user/2']);
      });

      test('(b) 사용자가 우리 탭을 닫아 u2 가 우리 순번으로 당겨지면(탭 수가 줄었다) 건드리지 않는다', async () => {
        const { sf, reg, k } = await threeTabs();
        sf.tabs.splice(1, 1);
        const before = JSON.stringify(sf.tabs);
        await expect(reg.withTab(k, run(sf))).rejects.toMatchObject({ code: 'TAB_CLOSED' });
        expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
        expect(JSON.stringify(sf.tabs)).toBe(before);
      });

      test('(c) 우리 탭을 닫고 끝에 새 탭을 열어 탭 수가 같아도 이웃 주소가 달라 건드리지 않는다', async () => {
        const { sf, reg, k } = await threeTabs();
        sf.tabs.splice(1, 1);
        sf.tabs.push({ url: 'http://user/3', marker: '' });
        const before = JSON.stringify(sf.tabs);
        await expect(reg.withTab(k, run(sf))).rejects.toMatchObject({ code: 'TAB_CLOSED' });
        expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
        expect(JSON.stringify(sf.tabs)).toBe(before);
      });

      test('이웃이 같아도 자리의 탭 주소가 창의 다른 탭이 기록된 주소면 우리 탭이 아니다(사용자가 탭을 맞바꿈)', async () => {
        const { sf, reg } = await threeTabs();
        sf.tabs[1] = { url: 'http://user/2', marker: '' }; // 우리 탭이 닫히고 같은 주소의 다른 탭이 자리에 있다
        const before = JSON.stringify(sf.tabs);
        expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
        expect(JSON.stringify(sf.tabs)).toBe(before);
      });

      test('창 모습을 기록한 적이 없으면(sync · 열기 기록 없음) 되찾지 않는다', async () => {
        const sf = new FakeSafari();
        const reg = new TabRegistry(sf);
        sf.tabs.push({ url: 'http://user/1', marker: '' });
        openOwned(sf, reg, 'http://a/x');
        sf.tabs.push({ url: 'http://user/2', marker: '' });
        lateRedirect(sf);
        expect(await reg.closeOwned()).toEqual({ closed: 0, missing: 0 });
        expect(sf.tabs).toHaveLength(3);
      });

      test('열기 기록(noteWindow)만으로도 되찾는다 — 열자마자 늦게 리디렉트되는 경우', async () => {
        const sf = new FakeSafari();
        const reg = new TabRegistry(sf);
        sf.tabs.push({ url: 'http://user/1', marker: '' });
        openOwned(sf, reg, 'http://a/x');
        reg.noteWindow(1, sf.tabs.map((t) => t.url)); // 드라이버가 열고 나서 호스트가 알려 준 창 모습을 기록
        sf.tabs[1]!.marker = '';
        sf.tabs[1]!.url = 'http://a/next';
        expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
        expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/1']);
      });

      // 알려진 드문 한계: 우리 탭이 닫히고 같은 주소 · 같은 이웃 · 같은 탭 수의 다른 탭이 같은 자리에 오면 구별할 수 없다.
      // (그 탭의 주소가 창의 다른 탭 기록 주소와 같지 않아야 하므로, 사용자가 그 자리에 완전히 새 주소의 탭을 열었을 때다.)
      test('(d) 알려진 한계: 우리 탭을 닫고 탭 수 · 이웃이 똑같게 새 주소의 사용자 탭이 그 자리에 오면 우리 탭으로 본다', async () => {
        const { sf, reg } = await threeTabs();
        sf.tabs[1] = { url: 'http://user/brand-new', marker: '' };
        expect(await reg.closeOwned()).toEqual({ closed: 1, missing: 0 });
        expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/1', 'http://user/2']);
      });
    });

    test('우리 탭이 여럿이고 뒤섞여 밀려도 모두 닫는다(닫을수록 순번이 당겨져도)', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/1');
      openOwned(sf, reg, 'http://a/2');
      openOwned(sf, reg, 'http://a/3');
      sf.tabs.unshift({ url: 'http://user/0', marker: '' }, { url: 'http://user/00', marker: '' });
      sf.tabs.splice(3, 0, { url: 'http://user/mid', marker: '' });
      for (const t of sf.tabs) if (t.marker !== '') t.url += '?x=1';
      expect(await reg.closeOwned()).toEqual({ closed: 3, missing: 0 });
      expect(sf.tabs.map((t) => t.url)).toEqual(['http://user/0', 'http://user/00', 'http://user/mid']);
    });
  });
});
