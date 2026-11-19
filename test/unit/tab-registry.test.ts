import { describe, expect, test } from 'vitest';
import { TabRegistry, type Guarded, type Probe, type RawTab, type Spot, type TabBackend } from '../../src/driver/tab-registry.js';

/** 사파리 흉내: 창 하나에 탭들이 있고, 탭마다 페이지 안 표시(marker)를 가진다. */
class FakeSafari implements TabBackend {
  tabs: { url: string; marker: string }[] = [];
  list = async (): Promise<RawTab[]> =>
    this.tabs.map((t, i) => ({ windowId: 1, index: i + 1, title: t.url, url: t.url, isActive: i === 0 }));
  probe = async (windowId: number, index: number): Promise<Probe> => {
    const t = this.tabs[index - 1];
    return t && windowId === 1 ? { exists: true, url: t.url, marker: t.marker } : { exists: false, url: '', marker: '' };
  };
  stamp = async (_w: number, index: number, key: string) => {
    this.tabs[index - 1]!.marker = key;
    return true;
  };
  close = async (s: Spot): Promise<Guarded<null>> => {
    const t = this.tabs[s.index - 1];
    if (!t || (t.marker !== s.key && !(s.unstamped && t.marker === '' && t.url === s.url))) return { stale: true };
    this.tabs.splice(s.index - 1, 1);
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
    sf.tabs.unshift({ url: 'http://user/0', marker: '' });
    const second = await reg.sync(await sf.list());
    expect(second.slice(1).map((e) => e.key)).toEqual(first.map((e) => e.key));
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
});
