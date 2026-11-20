import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표(it=…). 시험은 이 꼬리표가 든 탭만 만지고 닫는다 — 이동하는 시험도 꼬리표를 주소에 실어 간다.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

const RUN = `it=pw-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

describeIt('Playwright 식 이름(Locator · Page)', () => {
  let d: SafariDriver;

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
  });

  async function closeMine(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const found = (await d.listTabs()).find(isMine);
      if (!found) return;
      await d.closeTab(found.key);
    }
  }
  afterEach(closeMine);
  afterAll(async () => {
    try {
      await closeMine();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  const open = async (name: string) => {
    const { tab } = await d.openTab(mine(name));
    return new Page(d, tab.key);
  };
  const text = (page: Page, sel: string) => page.locator(sel).textContent();

  test('getByRole: 이름(부분 · 대소문자 무시 · exact · RegExp)으로 단추 · 링크 · 입력칸 · 체크박스를 찾는다', async () => {
    const page = await open('pw.html');
    await page.getByRole('button', { name: '보내기' }).click();
    expect(await page.getByRole('button', { name: '보내' }).count()).toBe(1); // 부분 일치
    expect(await page.getByRole('button', { name: '보내', exact: true }).count()).toBe(0); // 통째로 같아야
    expect(await page.getByRole('button', { name: '보내기', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: /^취소$/ }).count()).toBe(1);
    expect(await page.getByRole('link', { name: '홈' }).getAttribute('href')).toBe('#a');
    expect(await page.getByRole('link').count()).toBe(2); // aria-hidden 링크는 접근성 트리에 없다
    expect(await page.getByRole('textbox', { name: '이름' }).count()).toBe(1); // placeholder 가 이름이어도 label 로 찾는다
    expect(await page.getByRole('textbox', { name: '이름을 입력' }).count()).toBe(1);
    expect(await page.getByRole('checkbox', { name: '소식 받기' }).isChecked()).toBe(true);
    expect(await page.getByRole('checkbox', { name: '약관' }).isChecked()).toBe(false);
    expect(await page.getByRole('heading', { name: 'playwright 호환' }).count()).toBe(1); // heading 은 snapshot 역할이 아니라 ARIA 기본 역할
    expect(await page.getByRole('navigation').count()).toBe(1);
    expect(await page.getByRole('listitem').count()).toBe(3);
    await expect(page.getByRole('button', { name: '없는 단추' }).click({ timeout: 300 })).rejects.toThrow("0.3초 기다렸지만 누를 수 있는 요소가 없어요: getByRole('button', {name: '없는 단추'})");
  });

  test('getByRole 은 shadow 의 slot 으로만 이름이 오는 단추도 snapshot 이 보여 준 이름으로 찾는다', async () => {
    const page = await open('shadow.html');
    await page.getByRole('button', { name: '보내기' }).click();
    expect(await text(page, '#out2')).toBe('보내기 눌림');
    await page.getByRole('button', { name: '검색 열기' }).click(); // 호스트의 aria-label 로만 이름이 있는 단추
    expect(await text(page, '#out2')).toBe('검색 눌림');
    await page.getByRole('button', { name: '안쪽 단추' }).click();
    expect(await text(page, '#out')).toBe('눌림');
    await page.getByPlaceholder('안쪽 입력').fill('섀도');
    expect(await page.getByPlaceholder('안쪽 입력').inputValue()).toBe('섀도');
    expect(await page.getByText('슬롯 단추').count()).toBe(1);
  });

  test('같은 출처 iframe 안의 요소도 getBy… 로 찾는다', async () => {
    const page = await open('frames.html');
    await page.getByRole('button', { name: '프레임 단추' }).click();
    expect(await text(page, '#fout')).toBe('프레임 눌림');
    expect(await page.getByText('프레임 눌림').count()).toBe(1);
    await page.getByPlaceholder('프레임 입력').fill('안쪽 글');
    expect(await page.getByPlaceholder('프레임 입력').inputValue()).toBe('안쪽 글');
    expect(await page.getByRole('textbox').count()).toBe(1);
  });

  test('getByText(부분 · exact · 대소문자 무시 · RegExp), getByLabel, getByPlaceholder, getByTestId', async () => {
    const page = await open('pw.html');
    expect(await page.getByText('안녕').count()).toBe(2); // 가장 작은 요소 둘
    expect(await page.getByText('안녕', { exact: true }).count()).toBe(1);
    expect(await page.getByText('HELLO world').count()).toBe(1);
    expect(await page.getByText('HELLO world', { exact: true }).count()).toBe(0);
    expect(await page.getByText(/반갑/).count()).toBe(1);
    expect(await page.getByText('숨김 글').count()).toBe(0); // 안 보이는 글은 뺀다
    await page.getByLabel('이름').fill('홍길동');
    expect(await page.getByPlaceholder('이름을 입력').inputValue()).toBe('홍길동');
    expect(await page.getByLabel('소식 받기').count()).toBe(1); // aria-label
    expect(await page.getByLabel('약관에 동의').count()).toBe(1); // 감싼 label
    await page.getByTestId('name-input').fill('테스트 아이디');
    expect(await text(page, 'body') !== '').toBe(true);
    expect(await page.locator('#nm').inputValue()).toBe('테스트 아이디');
    expect(await page.getByTestId('name-input').count()).toBe(1);
    expect(await page.getByTestId('없음').count()).toBe(0);
    await expect(page.getByTestId('없음').click({ timeout: 300 })).rejects.toThrow(/누를 수 있는 요소가 없어요: getByTestId\('없음'\)/);
    await page.getByText('Hello World').click(); // 글 요소를 눌러도 오류가 없다
  });

  test('first · last · nth · count · all · locator(하위) · filter({hasText})', async () => {
    const page = await open('pw.html');
    const li = page.locator('li');
    expect(await li.count()).toBe(3);
    expect(await li.first().textContent()).toBe('첫째 항목');
    expect(await li.last().textContent()).toBe('셋째 항목');
    expect(await li.nth(1).textContent()).toBe('둘째 항목');
    expect(await li.nth(5).count()).toBe(0);
    const all = await li.all();
    expect(await Promise.all(all.map((l) => l.textContent()))).toEqual(['첫째 항목', '둘째 항목', '셋째 항목']);
    expect(await page.locator('ul').locator('li').count()).toBe(3);
    expect(await page.locator('nav').locator('a').count()).toBe(3); // CSS 는 숨은 것도 센다
    expect(await li.filter({ hasText: '둘째' }).textContent()).toBe('둘째 항목');
    expect(await li.filter({ hasText: /^셋/ }).count()).toBe(1);
    expect(await li.filter({ hasText: '없는 글' }).count()).toBe(0);
    expect(await page.getByRole('navigation').getByRole('link', { name: '소개' }).count()).toBe(1);
  });

  test('엄격하지 않다: 여러 개가 맞으면 보이는 첫 번째에 동작한다', async () => {
    const page = await open('pw.html');
    expect(await page.locator('.dup').count()).toBe(2);
    await page.locator('.dup').click(); // 앞의 것은 display:none — 보이는 뒤의 것이 눌린다
    expect(await text(page, '#log')).toBe('1');
    expect(await page.locator('.dup').isVisible()).toBe(true);
    expect(await page.locator('.dup').first().isVisible()).toBe(false); // first() 는 글자 그대로 첫 번째
  });

  test('selectOption: 값 · 글 · index · 여럿, 고른 값을 돌려준다', async () => {
    const page = await open('pw.html');
    expect(await page.locator('#color').selectOption('g')).toEqual(['g']); // 값
    expect(await page.locator('#color').selectOption('파랑')).toEqual(['b']); // 글
    expect(await page.locator('#color').selectOption({ label: '빨강' })).toEqual(['r']);
    expect(await page.locator('#color').selectOption({ index: 1 })).toEqual(['g']);
    expect(await page.getByLabel('여럿').selectOption(['r', 'b'])).toEqual(['r', 'b']);
    expect(await page.selectOption('#multi', ['g'])).toEqual(['g']);
    await expect(page.locator('#color').selectOption('없는 값', { timeout: 300 })).rejects.toThrow(/고를 선택지가 아직 없음/);
    await expect(page.locator('#nm').selectOption('x')).rejects.toThrow(/select/);
  });

  test('selectOption 의 onchange 가 주소를 바꿔도 같은 키가 이어진다', async () => {
    const page = await open('pw.html');
    await page.locator('#navsel').selectOption('go');
    expect(await page.title()).toBe('결과: 선택으로 왔다');
    expect((await d.listTabs()).find((t) => t.key === page.key)?.url).toContain('result.html');
  });

  test('check · uncheck · isChecked · isEnabled · isVisible · innerText · inputValue · getAttribute', async () => {
    const page = await open('pw.html');
    expect(await page.getByLabel('약관에 동의').isChecked()).toBe(false);
    await page.getByLabel('약관에 동의').check();
    expect(await page.getByLabel('약관에 동의').isChecked()).toBe(true);
    await page.getByLabel('약관에 동의').check(); // 이미 켜져 있으면 그대로
    expect(await page.locator('#agree').isChecked()).toBe(true);
    await page.getByLabel('약관에 동의').uncheck();
    expect(await page.locator('#agree').isChecked()).toBe(false);
    await page.uncheck('#news');
    expect(await page.locator('#news').isChecked()).toBe(false);
    await page.check('#news');
    expect(await page.locator('#news').isChecked()).toBe(true);
    await expect(page.locator('#send').check()).rejects.toThrow(/체크박스나 라디오/);

    expect(await page.getByRole('button', { name: '취소' }).isEnabled()).toBe(false);
    expect(await page.getByRole('button', { name: '보내기' }).isEnabled()).toBe(true);
    expect(await page.locator('#hid').isVisible()).toBe(false);
    expect(await page.isVisible('#send')).toBe(true);
    expect(await page.locator('#없는요소').isVisible()).toBe(false); // 없으면 false(오류 아님)
    expect(await page.locator('#hid').innerText()).toBe('숨김 글'); // 그려지지 않는 요소의 innerText 는 textContent 와 같다(브라우저 규칙)
    expect(await page.getByText('첫째 항목').innerText()).toBe('첫째 항목');
    expect(await page.innerText('#hov')).toBe('올려 보세요');
    await page.fill('#nm', '값');
    expect(await page.inputValue('#nm')).toBe('값');
    expect(await page.getAttribute('#nm', 'placeholder')).toBe('이름을 입력');
    expect(await page.getAttribute('#nm', 'nope')).toBeNull();
    expect(await page.textContent('#hov')).toBe('올려 보세요');
  });

  test('type · pressSequentially 는 글자마다 keydown · input 이벤트를 만든다', async () => {
    const page = await open('pw.html');
    await page.locator('#typed').type('abc');
    expect(await page.inputValue('#typed')).toBe('abc');
    expect(await text(page, '#evlog')).toBe('keydown=3 input=3');
    await page.getByPlaceholder('쳐 보기').pressSequentially('de');
    expect(await page.inputValue('#typed')).toBe('abcde'); // 이어서 뒤에 쳐진다
    expect(await text(page, '#evlog')).toBe('keydown=5 input=5');
    await page.locator('#typed').press('Backspace');
    expect(await page.inputValue('#typed')).toBe('abcd');
    await page.press('#typed', 'e');
    await page.type('#typed', 'f');
    expect(await page.inputValue('#typed')).toBe('abcdef');
  });

  test('hover 는 mouseover 를 일으키고, focus 는 초점을 옮기고, scrollIntoViewIfNeeded 는 오류 없이 끝난다', async () => {
    const page = await open('pw.html');
    expect(await text(page, '#hov')).toBe('올려 보세요');
    await page.locator('#hov').hover();
    expect(await text(page, '#hov')).toBe('올라옴');
    await page.locator('#nm').focus();
    expect(await page.evaluate(() => document.activeElement!.id)).toBe('nm');
    await page.locator('#hov').scrollIntoViewIfNeeded();
  });

  test('waitForSelector · waitFor: 500ms 뒤에 생기는 요소를 기다리고, hidden · detached 도 기다린다', async () => {
    const page = await open('pw.html');
    await page.locator('#addlate').click();
    expect(await page.locator('#late').count()).toBe(0); // 아직
    const t0 = Date.now();
    const loc = await page.waitForSelector('#late');
    expect(Date.now() - t0).toBeGreaterThan(150);
    expect(await loc.textContent()).toBe('늦게 나타남');
    await page.waitForSelector('#late', { state: 'attached' }); // 이미 있으니 바로

    await page.locator('#vanish').click();
    expect(await page.locator('#late2').isVisible()).toBe(true);
    await page.locator('#late2').waitFor({ state: 'hidden' });
    expect(await page.locator('#late2').isVisible()).toBe(false);
    await page.waitForSelector('#nothing-here', { state: 'detached' });
    await page.getByText('안녕', { exact: true }).waitFor();

    const t1 = Date.now();
    await expect(page.locator('#never').waitFor({ timeout: 700 })).rejects.toThrow(/0\.7초 안에 locator\('#never'\) 가 보이게 되지 않았어요/);
    expect(Date.now() - t1).toBeLessThan(3000);
    await page.waitForTimeout(50);
  });

  test('waitForURL: 폼을 제출한 뒤 글 패턴 · RegExp · 함수 · 정확한 글', async () => {
    const page = await open('search.html');
    await page.getByRole('searchbox').first().fill('에베레스트산');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/result.html?q=*');
    expect(decodeURIComponent(page.url())).toContain('result.html?q=에베레스트산');
    await page.waitForURL(/result\.html\?q=(에베레스트산|%EC%97%90)/);
    await page.waitForURL((u) => u.pathname === '/result.html');
    await page.waitForURL(page.url());
    expect(await page.title()).toBe('결과: 에베레스트산');
    const t0 = Date.now();
    await expect(page.waitForURL('**/없는주소', { timeout: 600 })).rejects.toThrow(/0\.6초 안에 주소가 .*\/없는주소 와\(과\) 맞지 않았어요/);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test('waitForURL 은 이동이 일어나는 동안에도 키를 지키고, 이동한 뒤 다 뜰 때까지 기다린다', async () => {
    const page = await open('form.html');
    await page.evaluate(() => { setTimeout(() => { location.href = 'result.html' + location.search + '&q=' + encodeURIComponent('늦은 이동'); }, 400); });
    await page.waitForURL(/result\.html/);
    expect(await page.title()).toBe('결과: 늦은 이동');
  });

  test('reload 는 같은 탭 · 같은 키로 다시 불러온다', async () => {
    const page = await open('pw.html');
    const before = (await d.listTabs()).filter(isMine).length;
    const stamp = await text(page, '#stamp');
    await page.evaluate(() => { (window as unknown as { __beforeReload: number }).__beforeReload = 99; });
    await page.reload();
    expect(await text(page, '#stamp')).not.toBe(stamp);
    expect(await page.evaluate(() => (window as unknown as { __beforeReload: number }).__beforeReload)).toBe(1); // 문서가 새로 떴다
    expect((await d.listTabs()).filter(isMine)).toHaveLength(before);
  });

  test('goBack · goForward 는 같은 탭에서 이력을 오가고 오래 걸리지 않는다', async () => {
    const page = await open('pw.html');
    await page.goto(mine('result.html') + '&q=' + encodeURIComponent('두 번째'));
    expect(await page.title()).toBe('결과: 두 번째');
    const t0 = Date.now();
    await page.goBack();
    const backMs = Date.now() - t0;
    expect(await page.title()).toBe('Playwright 호환 시험 페이지');
    const t1 = Date.now();
    await page.goForward();
    const fwdMs = Date.now() - t1;
    expect(await page.title()).toBe('결과: 두 번째');
    console.log(`goBack ${backMs}ms · goForward ${fwdMs}ms`);
    expect(Math.max(backMs, fwdMs)).toBeLessThan(6000);
    expect((await d.listTabs()).filter(isMine)).toHaveLength(1);
    await page.goBack(); // 같은 키로 이어서 쓴다
    expect(await text(page, '#stamp')).not.toBe('');
  });

  test('자동 기다림: 700ms 뒤에 생기는 단추를 기다림 없이 눌러도 되고, 500ms 뒤에 풀리는 입력칸에도 쓴다', async () => {
    const page = await open('pw.html');
    await page.locator('#spawn').click();
    expect(await page.locator('#later-btn').count()).toBe(0); // 아직 없다
    const t0 = Date.now();
    await page.getByRole('button', { name: '나중 단추' }).click(); // 따로 waitFor 없이
    expect(Date.now() - t0).toBeLessThan(5000); // 700ms 뒤에 생기는 것을 기다려서 눌렀다(앞의 호출 시간이 달라 하한은 두지 않는다)
    expect(await text(page, '#log2')).toBe('나중 단추 눌림');

    await page.locator('#enable').click();
    expect(await page.locator('#slow-in').isEnabled()).toBe(false);
    await page.locator('#slow-in').fill('풀린 뒤 씀');
    expect(await page.inputValue('#slow-in')).toBe('풀린 뒤 씀');

    // 이미 준비된 것은 기다리지 않는다
    const t1 = Date.now();
    await page.locator('#send').click();
    expect(Date.now() - t1).toBeLessThan(1500);
    // 안 보이는 것은 끝내 못 눌러서 시간 초과(있지만 안 보임)
    await expect(page.locator('.dup').first().click({ timeout: 400 })).rejects.toThrow(/0\.4초 기다렸지만 누를 수 있는 요소가 없어요: locator\('\.dup'\)\.first\(\) \(마지막 확인: 있지만 안 보임\)/);
    // 비활성 단추
    await expect(page.getByRole('button', { name: '취소' }).click({ timeout: 400 })).rejects.toThrow(/마지막 확인: 있지만 비활성/);
  });

  test('getByRole 의 상태 옵션(level · checked · pressed · expanded · selected · includeHidden)과 filter({hasNotText})', async () => {
    const page = await open('pw.html');
    expect(await page.getByRole('heading', { level: 2 }).textContent()).toBe('제목 둘');
    expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
    expect(await page.getByRole('heading').count()).toBe(3);
    expect(await page.getByRole('checkbox', { checked: true }).count()).toBe(1); // 소식 받기만
    expect(await page.getByRole('checkbox', { checked: false }).count()).toBe(1); // 약관
    expect(await page.getByRole('button', { pressed: true }).textContent()).toBe('토글 단추');
    expect(await page.getByRole('button', { expanded: false }).textContent()).toBe('펼치기 단추');
    expect(await page.getByRole('tab', { selected: true }).textContent()).toBe('탭 하나');
    expect(await page.getByRole('button', { name: '숨은 단추' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: '숨은 단추', includeHidden: true }).count()).toBe(1);
    expect(await page.locator('li').filter({ hasNotText: '둘째' }).count()).toBe(2);
    expect(() => page.getByRole('button', { disabled: true } as never)).toThrow('getByRole 이 모르는 옵션이에요: disabled');
    expect(() => page.locator('li').filter({ has: page.locator('b') } as never)).toThrow(/has 는 아직 지원하지 않아요/);
  });

  test('Playwright 식 선택자: button:has-text · role=button[name] · css= · text=/re/ · >>', async () => {
    const page = await open('pw.html');
    await page.locator('button:has-text("보내기")').click();
    expect(await page.locator('button:has-text("보내기")').count()).toBe(1);
    expect(await page.locator('role=button[name="보내기"]').count()).toBe(1);
    expect(await page.locator('role=button[name=/^취소$/]').isEnabled()).toBe(false);
    expect(await page.locator('role=heading[level=2]').textContent()).toBe('제목 둘');
    expect(await page.locator('css=#send').count()).toBe(1);
    expect(await page.locator('text=/반갑/').count()).toBe(1);
    expect(await page.locator('text="안녕"').count()).toBe(1);
    expect(await page.locator('li >> nth=1').textContent()).toBe('둘째 항목');
    expect(await page.locator('nav >> a:has-text("소개")').getAttribute('href')).toBe('#b');
    expect(await page.locator('nav >> role=link[name="홈"]').count()).toBe(1);
    expect(await page.locator('ul').locator('li:has-text("셋째")').count()).toBe(1);
    expect(() => page.locator('xpath=//a')).toThrow(/xpath.*getByRole/);
  });

  test('연쇄 드롭다운: 600ms 뒤에 생기는 선택지를 selectOption 이 기다린다 · {value,label} 은 모두 맞아야 한다', async () => {
    const page = await open('pw.html');
    await page.locator('#loadopts').click();
    expect(await page.locator('#dep option').count()).toBe(1);
    const t0 = Date.now();
    expect(await page.locator('#dep').selectOption('x')).toEqual(['x']);
    expect(Date.now() - t0).toBeGreaterThan(150);
    await expect(page.locator('#color').selectOption('없는 선택지', { timeout: 300 })).rejects.toThrow(/0\.3초 기다렸지만 고를 수 있는 요소가 없어요: locator\('#color'\) \(마지막 확인: 고를 선택지가 아직 없음\)/);
    await expect(page.locator('#color').selectOption({ value: 'g', label: '빨강' }, { timeout: 300 })).rejects.toThrow(/고를 선택지가 아직 없음/); // 값과 글이 서로 다르면 AND 라 안 맞는다
    expect(await page.locator('#color').selectOption({ value: 'g', label: '초록' })).toEqual(['g']);
  });

  test('inputValue · isChecked 는 label 을 그 입력칸으로 보고, 체크 상태가 없는 요소는 한국어 오류', async () => {
    const page = await open('pw.html');
    await page.locator('#nm').fill('라벨 시험');
    expect(await page.locator('label[for="nm"]').inputValue()).toBe('라벨 시험');
    expect(await page.locator('label:has-text("약관에 동의")').isChecked()).toBe(false);
    await page.locator('#agree').check();
    expect(await page.locator('label:has-text("약관에 동의")').isChecked()).toBe(true);
    await expect(page.locator('#send').isChecked()).rejects.toThrow(/체크 상태가 없는 요소예요/);
  });

  test('content() 는 문서 전체 HTML 글이다', async () => {
    const page = await open('pw.html');
    const html = await page.content();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('PW-CONTENT-MARKER');
    expect(html).toContain('<title>Playwright 호환 시험 페이지</title>');
  });
});
