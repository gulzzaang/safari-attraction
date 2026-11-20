import { describe, expect, test } from 'vitest';
import { SafariError } from '../../src/driver/types.js';
import { TabRegistry, type Guarded, type Probe, type RawTab, type RebindResult, type SettleResult, type Spot, type TabBackend } from '../../src/driver/tab-registry.js';

/** 사파리 흉내: 창 하나에 탭들이 있고, 탭마다 페이지 안 표시(marker)를 가진다. */
class FakeSafari implements TabBackend {
  tabs: { url: string; marker: string }[] = [];
  /** 켜 두면 close 가 한 번 시간 초과를 내고(탭은 실제로 닫힘) 이후는 정상. */
  closeTimesOutOnce = false;
  probeError: SafariError | null = null;
  list = async (): Promise<RawTab[]> =>
    this.tabs.map((t, i) => ({ windowId: 1, index: i + 1, title: t.url, url: t.url, isActive: i === 0 }));
  probe = async (windowId: number, index: number): Promise<Probe> => {
    if (this.probeError) throw this.probeError;
    const t = this.tabs[index - 1];
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
    expect(await reg.closeOwned()).toBe(2);
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
    expect(await reg.closeOwned()).toBe(1);
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
    expect(await reg.closeOwned()).toBe(1);
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
    expect(await reg.closeOwned()).toBe(2);
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
    expect(await mine.closeOwned()).toBe(1);
    expect(sf.tabs.map((t) => t.marker)).toEqual([`${k2}.deadbeef`, other.markerOf(otherKey)]);
  });

  describe('예기치 못한 이동으로 표시가 사라진 우리 탭', () => {
    test('withTab: 키를 지키고 표시를 다시 적은 뒤 일을 마친다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' }; // XHR 뒤 늦은 이동 · JS 리다이렉트: 새 문서라 표시가 없다
      const ran: string[] = [];
      const v = await reg.withTab(k, async (s) => {
        const t = sf.tabs[s.index - 1];
        if (!t || (t.marker !== s.key && !(s.unstamped && t.marker === '' && t.url === s.url))) return { stale: true };
        ran.push(t.url);
        return { value: 'ok' };
      });
      expect(v).toBe('ok');
      expect(ran).toEqual(['http://a/after']);
      expect(reg.ownedKeys()).toEqual([k]);
      expect(sf.tabs[0]!.marker).toBe(reg.markerOf(k));
      expect(await reg.closeOwned()).toBe(1);
      expect(sf.tabs).toHaveLength(0);
    });

    test('sync(listTabs) 가 키를 지우지 않는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      const k = openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' };
      const listed = await reg.sync(await sf.list());
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ key: k, owned: true });
      expect(reg.ownedKeys()).toEqual([k]);
      expect(await reg.closeOwned()).toBe(1);
    });

    test('closeTab(종료 때 closeOwned)이 이어서 닫는다', async () => {
      const sf = new FakeSafari();
      const reg = new TabRegistry(sf);
      openOwned(sf, reg, 'http://a/x');
      sf.tabs[0] = { url: 'http://a/after', marker: '' };
      expect(await reg.closeOwned()).toBe(1);
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
});
