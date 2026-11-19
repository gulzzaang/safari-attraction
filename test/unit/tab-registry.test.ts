import { describe, expect, test } from 'vitest';
import { SafariError } from '../../src/driver/types.js';
import { TabRegistry, type Guarded, type Probe, type RawTab, type RebindResult, type Spot, type TabBackend } from '../../src/driver/tab-registry.js';

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
  sf.tabs[sf.tabs.length - 1]!.marker = key;
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

  test('닫힌 탭은 TAB_CLOSED 이고 우리 탭 목록에서 빠진다(주소가 같은 다른 탭이 있어도)', async () => {
    const sf = new FakeSafari();
    const reg = new TabRegistry(sf);
    const k = openOwned(sf, reg, 'http://a/x');
    sf.tabs = [{ url: 'http://a/x', marker: '' }]; // 닫힘, 자리에는 표시 없는 같은 주소 탭
    await expect(reg.closeTab(k)).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(reg.ownedKeys()).toEqual([]);
    expect(sf.tabs).toHaveLength(1); // 남의 탭은 안 닫음
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
    expect(sf.tabs[0]!.marker).toBe(k);
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
    expect(sf.tabs[1]!.marker).toBe(k2);
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
});
