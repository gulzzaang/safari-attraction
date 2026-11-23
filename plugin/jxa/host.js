// 사파리를 부리는 JXA 호스트. `osascript -l JavaScript host.js` 로 띄워 두고,
// stdin 으로 한 줄에 요청 하나 `{id, op, args}` 를 받아
// stdout 으로 한 줄에 답 하나 `{id, ok:true, value}` / `{id, ok:false, error:{message, number, code?}}` 를 쓴다.
// Node 쪽은 한글 등을 \uXXXX 로 이스케이프해 보내므로 입력은 항상 ASCII 다(청크 경계에서 글자가 잘릴 일이 없다).
// stdin 이 닫히면(길이 0) 끝낸다. NSData 의 length 는 JS 숫자가 아니라서 `=== 0` 이 거짓이 된다 — 꼭 Number() 로 바꿔 비교한다.
// 오래 기다리는 반복은 부모(Node 서버)가 사라졌는지도 본다(고아가 되면 PPID 가 바뀐다). 사파리를 켜는 일은 하지 않는다 — 꺼져 있으면 SAFARI_NOT_RUNNING 을 돌려준다.
ObjC.import("Foundation");
ObjC.import("unistd");
ObjC.import("stdlib");

const Safari = Application("Safari");
const PARENT_PID = (() => {
  try {
    return Number($.getppid());
  } catch (e) {
    return 0;
  }
})();

// 부모가 사라졌으면(고아) 곧바로 끝낸다. 못 알아내면 계속 돈다.
function exitIfOrphaned() {
  let orphan = false;
  try {
    orphan = PARENT_PID > 1 && Number($.getppid()) !== PARENT_PID;
  } catch (e) {}
  if (orphan) $.exit(0);
}

// delay 대신 쓴다 — 기다리기 전에 부모가 살아 있는지 본다.
function nap(sec) {
  exitIfOrphaned();
  delay(sec);
}
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function writeLine(obj) {
  const s = JSON.stringify(obj) + "\n";
  stdout.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}

// 탭 자리 `windowId` + `index`(index 는 사파리 방식 1부터). 탭 키(t1, t2 …)는 Node 쪽 TabRegistry 가 자리와 이어 준다.
function tabOf(args) {
  return Safari.windows.byId(args.windowId).tabs[args.index - 1];
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

// 우리가 붙잡은 탭의 페이지 안에 적어 두는 표시(`document.documentElement.dataset.saTab = 탭 키`).
// 사용자가 탭을 옮기거나 다른 탭이 닫혀 자리 번호가 밀려도 표시로 같은 탭을 알아본다.
// 같은 문서 안에서는 남고, 새 문서를 불러오면(전체 이동 · 새로고침) 사라진다.
function isJsOffError(e) {
  const m = String((e && e.message) || e);
  return /Apple Events|Apple 이벤트/i.test(m) && /JavaScript/i.test(m);
}

function readMarker(tab) {
  try {
    return str(Safari.doJavaScript("document.documentElement.dataset.saTab || ''", { in: tab }));
  } catch (e) {
    // 「Apple 이벤트에서 JavaScript 허용」이 꺼진 건 올린다. 그 밖의 오류(JS 를 못 돌리는 특수 페이지 등)는 표시 없음으로 본다.
    if (isJsOffError(e)) throw e;
    return "";
  }
}

function stampTab(tab, key) {
  try {
    Safari.doJavaScript("document.documentElement.dataset.saTab = " + JSON.stringify(String(key)), { in: tab });
    return true;
  } catch (e) {
    if (isJsOffError(e)) throw e;
    return false;
  }
}

// 그 자리에 탭이 있으면 {tab, url, marker}, 없으면 null.
function probeTab(windowId, index) {
  let tab;
  let url;
  try {
    tab = Safari.windows.byId(windowId).tabs[index - 1];
    url = str(tab.url());
  } catch (e) {
    return null;
  }
  return { tab, url, marker: readMarker(tab) };
}

// 요청이 가리킨 자리의 탭이 정말 그 키의 탭일 때만 돌려준다.
// 표시가 키와 같거나, 아직 표시를 안 한 탭(args.unstamped)이면서 표시가 없고 주소가 기록(url) 또는 대신 받아들일 주소(altUrl)와 같을 때.
// args.urlOnly 는 JS 를 못 도는 탭(경고창이 떠 있는 탭)을 닫을 때만 쓴다 — 표시를 못 읽으니 주소만 본다.
function urlIs(u, args) {
  // Node 쪽이 같은 주소의 여러 꼴(기록한 그대로 · 정규화한 것)을 args.urls 로 보낸다. 없는 옛 요청은 url · altUrl.
  const forms = args.urls || [args.url, args.altUrl];
  return forms.indexOf(u) >= 0;
}

function guardTab(args) {
  if (args.urlOnly) {
    let tab;
    try {
      tab = tabOf(args);
      return (args.urlForms || [args.url]).indexOf(str(tab.url())) >= 0 ? { tab, marker: "" } : null; // 기록한 주소(altUrl 은 안 본다)의 여러 꼴
    } catch (e) {
      return null;
    }
  }
  const p = probeTab(args.windowId, args.index);
  if (!p) return null;
  if (p.marker === args.key) return p;
  if (args.unstamped && p.marker === "" && urlIs(p.url, args)) return p;
  return null;
}

// 탭 확인 · 표시 · 일을 한 번의 doJavaScript 로 한다(args.script = Node 쪽 buildGuardedSource 가 만든 글. 자리의 탭을 주소로 읽지 않는다).
// 소스가 돌았을 수 있는 한 느린 길로 넘기지 않는다 — 느린 길은 소스를 다시 돌리므로 동작(클릭 · 제출 · 입력)이 두 번 일어난다.
// 돌려주는 것:
//   {kind: "ok", tab, value, url, leaving}  표시가 맞아 소스가 돌았다(url 은 문서 자신의 location.href).
//   {kind: "fallback"}  소스가 돌지 않았다는 게 확실할 때만: 자리를 못 가리켰거나 스크립트가 표시 불일치({ok:false})를 알렸거나, 탭 · 창이 없다는 Apple Event 오류(-1728 · -1719 · Invalid index · Can't get).
//                       느린 길(guardTab)로 다시 확인한다.
//   {kind: "ran", tab}  돌았을 수 있다 — 사파리가 null 을 돌려줬거나(소스가 오류를 던졌다. 사파리는 페이지 안 오류를 오류로 올리지 않는다) 답 글을 읽을 수 없다(페이지가 JSON 을 바꿔 놓음 등). 소스를 다시 돌리면 안 된다.
// 그 밖의 doJavaScript 오류(시간 초과 -1712 · 변환 오류 …)는 예전 runJs 처럼 그대로 올린다.
function isTabGoneError(e) {
  const n = e && e.errorNumber;
  const m = String((e && e.message) || e);
  return n === -1728 || n === -1719 || /Can't get|Invalid index|가져올 수 없|유효하지 않은 인덱스/i.test(m);
}

function guardedRun(args) {
  let tab;
  try {
    tab = tabOf(args);
  } catch (e) {
    return { kind: "fallback" };
  }
  let raw;
  try {
    raw = Safari.doJavaScript(args.script, { in: tab });
  } catch (e) {
    if (isTabGoneError(e) && !isJsOffError(e)) return { kind: "fallback" }; // 탭 · 창이 없다 — 느린 길이 판단한다
    throw e;
  }
  if (typeof raw !== "string") return { kind: "ran", tab };
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    return { kind: "ran", tab };
  }
  if (r && r.ok === false) return { kind: "fallback" }; // 스크립트가 표시 불일치를 알렸다 — 소스는 안 돌았다
  if (!r || r.ok !== true) return { kind: "ran", tab };
  return { kind: "ok", tab, value: typeof r.value === "string" ? r.value : "", url: typeof r.url === "string" ? r.url : undefined, leaving: r.leaving === true };
}

// settle 의 빠른 길: 표시 · 떠나는 중 깃발 · 문서 자신의 주소 · 제목을 doJavaScript 한 번으로 읽는다(예전에는 tab.url() · 표시 읽기 · 깃발 읽기 · tab.name() 이 따로였다).
// 표시가 이 키일 때(= 아직 옛 문서, 상태 "same")만 여기서 답하고, 그 밖의 모든 경우(표시 없음 = 새 문서 · 다른 키 · 탭 없음 · 못 읽음)는 null 을 돌려줘 예전 확인이 그대로 한다.
const SETTLE_PROBE =
  "JSON.stringify({ m: String(document.documentElement.dataset.saTab || ''), lv: window.__saLeaving === true, href: location.href, t: document.title })";
function settleFast(args) {
  let tab;
  let raw;
  try {
    tab = tabOf(args);
    raw = Safari.doJavaScript(SETTLE_PROBE, { in: tab });
  } catch (e) {
    if (isJsOffError(e)) throw e;
    return null;
  }
  if (typeof raw !== "string") return null;
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!r || r.m !== args.key || typeof r.href !== "string" || r.href === "") return null;
  let isActive;
  try {
    isActive = args.index === Safari.windows.byId(args.windowId).currentTab().index();
  } catch (e) {
    return null;
  }
  return {
    status: "same",
    leaving: r.lv === true,
    tab: { windowId: args.windowId, index: args.index, title: str(r.t), url: r.href, isActive },
  };
}

// 문서를 쓸 수 있는 때인가(Playwright 의 domcontentloaded 처럼): DOMContentLoaded 이벤트가 끝났고(navigation 기록의 domContentLoadedEventEnd > 0 —
// defer · module 스크립트까지 돈 뒤다) body 가 있을 때. navigation 기록을 못 읽으면 readyState 가 complete 일 때로 본다.
// 이미지 · async 스크립트 · 아이프레임이 다 오기 전의 load 이벤트는 기다리지 않는다.
const READY_PROBE = "document.readyState + ' ' + (document.body ? 1 : 0) + ' ' + (((performance.getEntriesByType('navigation')[0] || {}).domContentLoadedEventEnd || 0) > 0 ? 1 : 0)";
function usableState(readyState, hasBody, dclDone) {
  return readyState === "complete" || (hasBody && dclDone);
}

// 새 문서가 쓸 수 있게 될 때까지(최대 args.loadBudgetMs, 기본 15초) 기다려 표시를 적고 탭 정보를 돌려준다(rebind · settle 이 함께 쓴다).
// args.waitUntil === "commit" 이면 기다리지 않고 바로 표시를 적어 본다. 표시가 적혔는지는 stamped 로 알린다 —
// 못 적었으면(false) Node 쪽이 그 탭을 「표시 안 한 탭」으로 기록해, 다음 일 때 자리 · 주소로 다시 알아보고 표시를 다시 적는다.
function finishRebind(args, tab) {
  // 읽어 보아 표시가 남아 있는지 확인한다(뜨는 중에 적으면 지워질 수 있다).
  const budget = args.loadBudgetMs || 15000;
  const t1 = Date.now();
  const commitOnly = args.waitUntil === "commit";
  let stamped = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (; !commitOnly; ) {
      let ready = false;
      try {
        const st = str(Safari.doJavaScript(READY_PROBE, { in: tab })).split(" ");
        ready = usableState(st[0], st[1] === "1", st[2] === "1");
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      if (ready || Date.now() - t1 > budget) break;
      nap(0.05);
    }
    const again = probeTab(args.windowId, args.index);
    if (!again) return { status: "gone" };
    if (again.marker !== "" && again.marker !== args.key) return { status: "other" };
    stampTab(tab, args.key);
    if (readMarker(tab) === args.key) {
      stamped = true;
      break;
    }
    if (commitOnly) break;
    nap(0.1);
  }
  const win = Safari.windows.byId(args.windowId);
  return {
    status: "ok",
    stamped,
    tab: {
      windowId: args.windowId,
      index: args.index,
      title: str(tab.name()),
      url: str(tab.url()),
      isActive: args.index === win.currentTab().index(),
    },
  };
}

function windowTabInfos(w) {
  const windowId = w.id();
  const names = w.tabs.name();
  const urls = w.tabs.url();
  const current = w.currentTab().index();
  return names.map((name, i) => ({
    windowId,
    index: i + 1,
    title: str(name),
    url: str(urls[i]),
    isActive: i + 1 === current,
  }));
}

// 최소화한 창은 사파리에서 visible() 이 false 가 된다 — 닫힌 창이 아니다.
function isMinimized(w) {
  try {
    return w.miniaturized() === true;
  } catch (e) {
    return false;
  }
}

// 탭을 읽을 수 있는가(닫힌 채 남은 창은 탭이 0 개이거나 읽다가 오류가 난다).
function hasReadableTabs(w) {
  try {
    return w.tabs.length > 0;
  } catch (e) {
    return false;
  }
}

// 닫힌 창인가. 닫은 창은 한참(몇 분) 사파리 창 목록에 남아 visible() 이 false 가 되고 탭이 없다.
// visible() 이 false 여도 최소화한 창이거나, 탭을 그대로 읽을 수 있는 창(사파리를 숨겼거나 — Cmd-H — 다른 Space · 전체 화면에 있는 창)이면 닫힌 것이 아니다.
function isGone(w) {
  try {
    return w.visible() === false && !isMinimized(w) && !hasReadableTabs(w);
  } catch (e) {
    return true;
  }
}

// 탭이 있고 닫히지 않은 창만 일반 창으로 본다(설정 창 같은 건 탭이 없다). 맨 앞 것부터. 최소화한 창도 들어간다.
function normalWindows() {
  const out = [];
  Safari.windows().forEach((w) => {
    try {
      if (!isGone(w) && w.tabs.length > 0) out.push(w);
    } catch (e) {}
  });
  return out;
}

// id 로 창을 찾는다. 없거나 닫혔으면 null(최소화한 창은 있는 창이다). 창을 가리킬 때는 항상 이것(순서가 바뀌어도 같은 창).
function aliveWindow(windowId) {
  try {
    const w = Safari.windows.byId(windowId);
    if (w.id() !== windowId) return null;
    if (isGone(w)) return null;
    return w;
  } catch (e) {
    return null;
  }
}

function currentTabName(w) {
  try {
    return str(w.currentTab().name());
  } catch (e) {
    return "";
  }
}

function boundsOf(w) {
  const b = w.bounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// 그 창 현재 탭 페이지의 innerWidth · innerHeight. 못 재면(JS 를 못 도는 페이지) null.
function innerSizeOf(w) {
  try {
    const t = str(Safari.doJavaScript("innerWidth + ',' + innerHeight", { in: w.currentTab() })).split(",");
    return { innerWidth: Number(t[0]), innerHeight: Number(t[1]) };
  } catch (e) {
    if (isJsOffError(e)) throw e;
    return null;
  }
}

function windowState(w, measure) {
  return { gone: false, bounds: boundsOf(w), inner: measure === false ? null : innerSizeOf(w) };
}

// 페이지를 쓸 수 있을 때(usableState — domcontentloaded)까지 최대 args.loadBudgetMs 기다리고, 새 문서의 주소가 보여야 한다(아직 about:blank 면 계속 기다린다. 가려는 곳이 about:blank 면 그대로 둔다).
// load 이벤트까지의 기다림은 Node 쪽(page.waitForLoadState)이 필요할 때만 한다. 「Apple 이벤트에서 JavaScript 허용」이 꺼진 오류는
// 기다려도 소용없으니 onJsOff() 로 만든 것을 치운 뒤 그대로 올린다(사파리 오류 문구는 로케일에 따라 영어 또는 한국어).
function waitForLoad(tab, args, onJsOff) {
  const t0 = Date.now();
  const budget = args.loadBudgetMs || 15000;
  const blank = args.url === "about:blank";
  for (;;) {
    let state = "";
    try {
      state = str(Safari.doJavaScript("location.href + ' ' + " + READY_PROBE, { in: tab }));
    } catch (e) {
      if (isJsOffError(e)) {
        try {
          onJsOff();
        } catch (e2) {}
        throw e;
      }
    }
    const parts = state.split(" ");
    const dclDone = parts.pop() === "1";
    const hasBody = parts.pop() === "1";
    const readyState = parts.pop();
    const href = parts.join(" ");
    if (usableState(readyState, hasBody, dclDone) && href !== "" && (blank || href !== "about:blank")) break;
    if (Date.now() - t0 > budget) break;
    nap(0.05);
  }
}

// 방금 연 우리 탭을 창 안에서 다시 찾는다. 열 때 정한 자리(`index`)는 기다리는 사이 사용자가 탭을 열고 닫으면 다른 탭을 가리키므로,
// 표시를 적거나 닫기 전에 꼭 이것으로 확인한다. 주소는 꼴(http/https · www · 끝 슬래시 · # 뒤)이 달라도 같은 주소로 본다.
function openedKey(u) {
  let s = str(u).replace(/#.*$/, "").replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const cut = s.search(/[\/?]/);
  const host = (cut < 0 ? s : s.slice(0, cut)).toLowerCase();
  let rest = cut < 0 ? "" : s.slice(cut);
  if (rest === "/") rest = "";
  return host + rest;
}

function windowUrlsOf(win) {
  try {
    return win.tabs.url().map(str);
  } catch (e) {
    return undefined;
  }
}

// 열기 전 창의 모습: 탭 수와 연 주소와 같은 주소의 탭 수. 열고 난 뒤 「이 주소 탭이 하나 늘었는지」를 보는 기준이다.
function windowBefore(win, url) {
  const want = openedKey(url);
  try {
    const urls = win.tabs.url().map(str);
    return { count: urls.length, same: urls.filter((u) => openedKey(u) === want).length };
  } catch (e) {
    return { count: -1, same: Infinity }; // 모르면 아래 확인이 가장 조심스럽게(아무것도 믿지 않게) 돈다
  }
}

// 열린 탭 {tab, index} 를 돌려준다. 못 찾으면 null — 그때는 아무 탭에도 표시를 적지 않고 닫지도 않는다(사용자 탭이 먼저).
// 열 때 정한 자리(index)의 탭이 우리 탭이라는 증거는 「창의 탭 수가 열기 전보다 정확히 하나 늘었다」다(사용자가 사이에 탭을 열거나 닫으면 깨진다).
// 1) 탭 수가 그대로 하나 늘었고 그 자리의 탭에 표시가 없으면: 주소가 연 주소와 같거나(이동 · 리디렉트로 주소가 바뀌었어도) 같은 주소의 탭이 열기 전보다 늘지 않았으면 그 탭이다
//    (같은 주소의 사용자 탭이 따로 있어도 우리 탭을 그 탭으로 착각하지 않는다).
// 2) 아니면(순번이 밀렸을 수 있다) 창 끝에서부터 주소가 연 주소와 같고 표시가 없는 탭을 찾는다 — 같은 주소의 탭이 열기 전보다 하나 이상 늘었을 때만.
// readMarkers 가 false 면 표시를 읽지 않는다(「Apple 이벤트에서 JavaScript 허용」이 꺼져 읽을 수 없을 때 — 누구의 표시도 없다).
function findOpened(win, index, url, before, readMarkers) {
  let urls;
  try {
    urls = win.tabs.url().map(str);
  } catch (e) {
    return null;
  }
  const want = openedKey(url);
  const sameNow = urls.filter((u) => openedKey(u) === want).length;
  const markerless = (i) => {
    try {
      const tab = win.tabs[i - 1];
      return !readMarkers || readMarker(tab) === "" ? tab : null;
    } catch (e) {
      if (isJsOffError(e)) throw e;
      return null;
    }
  };
  if (urls.length === before.count + 1 && index <= urls.length && (openedKey(urls[index - 1]) === want || sameNow <= before.same)) {
    const tab = markerless(index);
    if (tab) return { tab, index };
  }
  if (sameNow >= before.same + 1) {
    for (let i = urls.length; i >= 1; i--) {
      if (openedKey(urls[i - 1]) !== want) continue;
      const tab = markerless(i);
      if (tab) return { tab, index: i };
    }
  }
  return null;
}

let screenFnBound = false;

const ops = {
  listWindows() {
    return normalWindows().map((w) => ({
      id: w.id(),
      index: w.index(),
      isPrivate: false, // 사파리 스크립트 사전에 개인정보 보호 창을 가리키는 속성이 없다.
      tabCount: w.tabs.length,
      visible: true,
      minimized: isMinimized(w),
      bounds: boundsOf(w),
      title: currentTabName(w),
    }));
  },

  listTabs() {
    const out = [];
    normalWindows().forEach((w) => {
      windowTabInfos(w).forEach((t) => out.push(t));
    });
    return out;
  },

  // 자리에 있는 탭의 {exists, url, marker}. 표시(marker)는 페이지 안 JS 로 읽는다.
  probe(args) {
    const p = probeTab(args.windowId, args.index);
    return p ? { exists: true, url: p.url, marker: p.marker } : { exists: false, url: "", marker: "" };
  },

  // 여러 자리의 탭 {windowId, index, url, marker} 를 읽기만 한다(표시는 페이지 안 dataset 을 읽을 뿐 아무것도 바꾸지 않는다. 사파리를 앞으로 가져오지 않는다).
  // 없는 탭 · 읽지 못한 탭(읽다 오류가 났거나 args.timeoutMs 를 넘긴 탭)은 결과에서 뺀다 — 부르는 쪽은 빠진 탭을 「못 본 것」으로 센다.
  // 「Apple 이벤트에서 JavaScript 허용」이 꺼진 오류만 올린다. args.timeoutMs 는 탭 하나에 쓰는 시간이다: 한 탭이 넘기면 그 탭은 버리고,
  // 전체가 spots 수 × timeoutMs 를 넘기면 남은 탭은 건너뛴다. 사파리 이벤트 하나를 중간에 끊을 수는 없어서, 아예 멈춘 탭(경고창)은
  // 부르는 쪽의 요청 시간 제한이 호스트를 다시 띄워 끊는다.
  readMarkers(args) {
    const out = [];
    const spots = args.spots || [];
    const per = args.timeoutMs || 500;
    const t0 = Date.now();
    for (let i = 0; i < spots.length; i++) {
      const s0 = Date.now();
      if (s0 - t0 > per * spots.length) break;
      let url;
      let marker;
      try {
        const tab = Safari.windows.byId(spots[i].windowId).tabs[spots[i].index - 1];
        url = str(tab.url());
        marker = str(Safari.doJavaScript("document.documentElement.dataset.saTab || ''", { in: tab }));
      } catch (e) {
        if (isJsOffError(e)) throw e;
        continue; // 없는 탭이거나 표시를 읽지 못한 탭 — 못 본 것
      }
      if (Date.now() - s0 > per) continue; // 탭 하나가 시간을 넘겼다 — 못 본 것
      out.push({ windowId: spots[i].windowId, index: spots[i].index, url, marker });
    }
    return out;
  },

  // 우리가 연 탭이 제자리에서 이동했다(주소 이동 · 링크 · 폼 전송). 새 문서에는 표시가 없다 — 불러오기가 끝나길 기다려
  // 표시를 다시 적고 탭 정보를 돌려준다. 자리에 다른 키의 표시가 있으면 {status:"other"}, 탭이 없으면 {status:"gone"}.
  // 아직 옛 문서(표시가 그대로)면 이동이 시작되길 잠깐(최대 1.5초) 기다리고, 그래도 안 바뀌면 같은 문서로 본다.
  rebind(args) {
    const p0 = probeTab(args.windowId, args.index);
    if (!p0) return { status: "gone" };
    if (p0.marker !== "" && p0.marker !== args.key) return { status: "other" };
    const tab = p0.tab;
    const t0 = Date.now();
    if (p0.marker === args.key) {
      // 아직 옛 문서 — 새 문서로 바뀌어 표시가 사라질 때까지 기다린다. 주소가 바뀌었는데 표시가 남아 있으면 이동이 시작된 것이니
      // 더 기다리고(최대 5초), 주소도 안 바뀌면(1.5초) 같은 문서로 본다(주소 이동이 없었거나 같은 문서 안 이동).
      for (;;) {
        let m = args.key;
        let u = args.url;
        try {
          u = str(tab.url());
          m = readMarker(tab);
        } catch (e) {
          if (isJsOffError(e)) throw e;
        }
        if (m !== args.key) break;
        const waited = Date.now() - t0;
        if (waited > (u !== args.url ? 5000 : 1500)) break;
        nap(0.05);
      }
    }
    return finishRebind(args, tab);
  },

  // 이동은 일어났는지 본다 — 표시가 남은 키의 탭이 그대로면 {status:"same"}, 자리의 탭에 표시가 없으면(새 문서)
  // 쓸 수 있을 때까지(args.waitUntil 이 "commit" 이면 기다리지 않고) 기다려 표시를 다시 적고 {status:"navigated"}. 다른 키의 표시 → "other", 탭 없음 → "gone".
  // 읽기만 하고 아무것도 지우지 않는다(표시가 없다는 이유로 탭을 잃지 않게 하려는 확인용).
  settle(args) {
    const quick = settleFast(args);
    if (quick) return quick;
    const p0 = probeTab(args.windowId, args.index);
    if (!p0) return { status: "gone" };
    if (p0.marker !== "" && p0.marker !== args.key) return { status: "other" };
    if (p0.marker === args.key) {
      const win = Safari.windows.byId(args.windowId);
      let leaving = false; // 문서를 떠나는 중인가(beforeunload — Page 가 동작 때 심는 깃발)
      // 아직 옛 문서의 주소는 그 문서 자신의 location.href 로 읽는다. 이동이 진행 중일 때 사파리의 tab.url() 은 가는 중인 목적지를 돌려주므로
      // 옛 문서의 주소로 쓰면 안 된다(읽지 못하면 기록해 둔 주소를 그대로 돌려준다).
      let url = args.url !== undefined && args.url !== null ? args.url : p0.url;
      try {
        const st = JSON.parse(str(Safari.doJavaScript("JSON.stringify([!!window.__saLeaving, location.href])", { in: p0.tab })));
        leaving = st[0] === true;
        if (typeof st[1] === "string" && st[1] !== "") url = st[1];
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      return {
        status: "same",
        leaving,
        tab: { windowId: args.windowId, index: args.index, title: str(p0.tab.name()), url, isActive: args.index === win.currentTab().index() },
      };
    }
    const r = finishRebind(args, p0.tab);
    return r.status === "ok" ? { status: "navigated", tab: r.tab, stamped: r.stamped } : r;
  },

  // 자리의 탭에 표시를 적는다(탭 붙잡기).
  stamp(args) {
    const tab = tabOf(args);
    tab.url(); // 없는 탭이면 여기서 오류
    return stampTab(tab, args.key);
  },

  // 활성 탭은 바꾸지 않고 맨 뒤에 새 탭을 만든다. 페이지를 쓸 수 있을 때까지(최대 loadBudgetMs) 기다린다(load 까지는 아니다).
  // 새 탭은 맨 앞 창(= 맨 앞 일반 창)에 연다. 사파리 스크립트 사전에는 개인정보 보호 창을 가리키는 속성이 없어
  // 개인정보 보호 창을 가려낼 수 없다 — 맨 앞 창이 개인정보 보호 창이면 거기에 열린다(알려진 한계).
  openTab(args) {
    let win;
    let before = { count: 0, same: 0 }; // 열기 전 창의 모습(탭이 하나 늘었는지 보는 기준)
    if (args.windowId !== undefined && args.windowId !== null) {
      win = Safari.windows.byId(args.windowId);
      win.id(); // 없는 창이면 여기서 오류
      before = windowBefore(win, args.url);
      win.tabs.push(Safari.Tab({ url: args.url }));
    } else {
      const wins = normalWindows();
      if (wins.length === 0) {
        Safari.make({ new: "document", withProperties: { url: args.url } });
        nap(0.3);
        const again = normalWindows();
        if (again.length === 0) throw new Error("새 창을 만들지 못함");
        win = again[0];
      } else {
        // 맨 앞의 최소화하지 않은 창, 모두 최소화했으면 맨 앞의 최소화한 창(새 창을 만들지 않는다).
        win = wins.filter((w) => !isMinimized(w))[0] || wins[0];
        before = windowBefore(win, args.url);
        win.tabs.push(Safari.Tab({ url: args.url }));
      }
    }
    const windowId = win.id();
    const index0 = win.tabs.length;
    const tab0 = win.tabs[index0 - 1];

    // 자리(index0)의 탭을 곧이곧대로 믿지 않는다 — 기다리는 사이 사용자가 탭을 열고 닫으면 순번이 밀려 사용자 탭을 가리킬 수 있다.
    // JS 허용이 꺼져 닫을 때도 다시 찾은 우리 탭만 닫는다. 이때는 표시를 읽을 수 없다 — 읽지 않고 같은 확인(탭 수 · 주소)으로 찾는다. 못 찾으면 닫지 않는다.
    const closeOurs = () => {
      const f = findOpened(win, index0, args.url, before, false);
      if (f) f.tab.close();
    };
    waitForLoad(tab0, args, closeOurs);

    let found;
    try {
      found = findOpened(win, index0, args.url, before, true);
    } catch (e) {
      if (isJsOffError(e)) {
        try {
          closeOurs();
        } catch (e2) {}
      }
      throw e;
    }
    if (!found) throw new Error("방금 연 탭을 확인하지 못함 — 표시를 적지 않았고, 열린 탭이 남아 있을 수 있음");
    const index = found.index;
    const tab = found.tab;
    // 밀린 탭이면 기다림이 엉뚱한 탭을 본 것이다 — 우리 탭에 대해 다시 기다린다.
    if (index !== index0) waitForLoad(tab, args, closeOurs);

    const stamped = args.key ? stampTab(tab, args.key) : false;
    const current = win.currentTab().index();
    return {
      windowId,
      index,
      title: str(tab.name()),
      url: str(tab.url()),
      isActive: index === current,
      stamped,
      windowUrls: windowUrlsOf(win), // 연 직후 창의 모습(Node 쪽이 늦게 스스로 옮겨 간 탭을 되찾을 때 견준다)
    };
  },

  // 활성화하지 않고 새 문서 창을 열어 사파리 창 순서 맨 뒤(보이는 창들 가운데)로 보내고, 페이지를 쓸 수 있을 때까지 기다린다.
  // 새 창은 만들기 전 창 id 목록과 비교해 찾는다. 앞 앱은 바꾸지 않는다(activate 를 부르지 않는다).
  openWindow(args) {
    const before = Safari.windows().map((w) => w.id());
    Safari.make({ new: "document", withProperties: { url: args.url } });
    const findNew = () => Safari.windows().filter((w) => before.indexOf(w.id()) < 0 && !isGone(w));
    let created = findNew();
    for (let i = 0; i < 100 && created.length === 0; i++) {
      nap(0.1);
      created = findNew();
    }
    // 어느 창이 우리 것인지 모르면 아무것도 닫지 않는다(사용자 창을 닫을 수 있으니).
    if (created.length !== 1) throw new Error("새 창을 하나로 특정하지 못함(" + created.length + "개) — 새로 열린 창이 남아 있을 수 있음");
    const windowId = created[0].id();
    // 여기부터 실패하면 우리가 만든 창을 닫고 그대로 올린다(창이 홀로 남지 않게).
    try {
      const win = () => Safari.windows.byId(windowId);

      // 맨 뒤로: 일반 창 가운데 가장 뒤에 있는 창의 순서로 보낸다(안 보이는 닫힌 창이 더 뒤에 있어도 그 앞에 둔다).
      const others = normalWindows().filter((w) => w.id() !== windowId);
      if (others.length > 0) win().index = Math.max.apply(null, others.map((w) => w.index()));

      for (let i = 0; i < 50 && win().tabs.length === 0; i++) nap(0.1);
      const tab = () => win().tabs[0];
      // 만들자마자 표시를 한 번 적어 둔다(시간을 넘겨 치울 때 우리 창을 알아보는 단서. 새 문서가 뜨면 지워질 수 있다).
      if (args.key) stampTab(tab(), args.key);
      waitForLoad(tab(), args, () => win().close());

      const stamped = args.key ? stampTab(tab(), args.key) : false;
      return {
        windowId,
        windowIndex: win().index(),
        tab: {
          windowId,
          index: 1,
          title: str(tab().name()),
          url: str(tab().url()),
          isActive: win().currentTab().index() === 1,
        },
        stamped,
      };
    } catch (e) {
      try {
        Safari.windows.byId(windowId).close();
      } catch (e2) {}
      throw e;
    }
  },

  // 지금 사파리가 가진 창 번호 전부(닫힌 채 남은 창 · 설정 창 포함). openWindow 가 새 창을 알아보는 기준.
  windowIds() {
    return Safari.windows().map((w) => w.id());
  },

  // openWindow 가 시간을 넘겨 호스트가 죽은 뒤 홀로 남은 새 창을 치운다: args.beforeIds 에 없던 창 가운데
  // 첫 탭의 표시가 args.key 인 것만 닫는다. 표시를 확인하지 못한 새 창은 그냥 두고 unconfirmed 로 센다.
  closeStamped(args) {
    let closed = 0;
    let unconfirmed = 0;
    Safari.windows().forEach((w) => {
      try {
        if (args.beforeIds.indexOf(w.id()) >= 0 || isGone(w)) return;
        let marker = "";
        try {
          marker = readMarker(w.tabs[0]);
        } catch (e) {}
        if (marker === args.key) {
          w.close();
          closed++;
        } else {
          unconfirmed++;
        }
      } catch (e) {
        unconfirmed++;
      }
    });
    return { closed, unconfirmed };
  },

  // 창 바깥 크기와 페이지 크기. 창이 없거나 닫혔으면 {gone:true}.
  windowState(args) {
    const w = aliveWindow(args.windowId);
    return w ? windowState(w, args.measure) : { gone: true };
  },

  // 창 바깥 크기(와 자리)를 바꾸고 잠깐 기다린 뒤 지금 크기를 돌려준다. x · y 를 안 주면 자리는 그대로.
  setBounds(args) {
    const w = aliveWindow(args.windowId);
    if (!w) return { gone: true };
    const b = w.bounds();
    w.bounds = {
      x: args.x === undefined || args.x === null ? b.x : args.x,
      y: args.y === undefined || args.y === null ? b.y : args.y,
      width: args.width,
      height: args.height,
    };
    nap(0.3);
    return windowState(w);
  },

  // 창을 닫고, 목록에서 보이지 않게 될 때까지(최대 3초) 기다린다.
  closeWindow(args) {
    const w = aliveWindow(args.windowId);
    if (!w) return { gone: true };
    w.close();
    for (let i = 0; i < 30 && aliveWindow(args.windowId); i++) nap(0.1);
    return { gone: false, closed: aliveWindow(args.windowId) === null };
  },

  // 이 앱에 화면 기록 권한이 있는가(사파리를 건드리지 않는다).
  screenAccess() {
    ObjC.import("CoreGraphics");
    if (!screenFnBound) {
      ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
      screenFnBound = true;
    }
    return $.CGPreflightScreenCaptureAccess() === true;
  },

  // 자리의 탭이 args.key 의 탭일 때만 돈다. 아니면 {stale: true}(Node 쪽이 탭을 다시 찾는다).
  runJs(args) {
    const g = guardTab(args);
    if (!g) return { stale: true };
    if (g.marker !== args.key) stampTab(g.tab, args.key); // 표시 없던 탭(붙잡기 전, 새로고침 뒤)에 지금 적는다
    const res = Safari.doJavaScript(args.source, { in: g.tab });
    let value;
    if (res === null || res === undefined) value = "";
    else if (typeof res === "string") value = res;
    else if (typeof res === "number" || typeof res === "boolean") value = String(res);
    else value = JSON.stringify(res);
    let url;
    try {
      // 이동했을 수 있으니 지금 주소도 돌려준다(Node 쪽 기록을 새로 한다). 문서 자신의 주소 — tab.url() 은 이동 중이면 가는 중인 목적지다.
      url = str(Safari.doJavaScript("location.href", { in: g.tab }));
    } catch (e) {}
    return { value, url };
  },

  // runJs 의 빠른 길: 탭 확인 · 표시 · 일이 doJavaScript 한 번이다(args.script). 소스가 안 돈 게 확실할 때만 {fallback: true}(느린 길 runJs 가 소스를 보낸다).
  // 소스가 돌았을 수 있으면(null · 못 읽는 답) 다시 돌리지 않고 빈 값을 돌려준다 — 자리 확인(guardTab)은 표시를 안 적은 탭에 표시를 적기 위한 것이다.
  // 자리 확인이 실패했을 때는 문서가 JS 를 못 도는지만 가린다(JS 를 못 도는 문서면 소스가 안 돈 것이니 stale).
  runJsFast(args) {
    const f = guardedRun(args);
    if (f.kind === "ok") return { value: f.value, url: f.url, leaving: f.leaving };
    if (f.kind === "ran") {
      const g = guardTab(args);
      if (g) {
        if (g.marker !== args.key) stampTab(g.tab, args.key); // 문법 오류로 글이 안 돌았으면 표시도 안 적혔다
        return { value: "" };
      }
      // 자리가 키의 탭이 아니다. 문서가 JS 를 못 돌면(시작 페이지 · 특수 페이지) null 은 소스가 돌지 않은 것이니 stale 로 돌려 Node 가 탭을 다시 찾게 한다.
      // JS 를 돌 수 있는 문서면 소스는 돌았을 수 있으니 다시 돌리지 않게 빈 값.
      let probe = null;
      try {
        probe = Safari.doJavaScript("1", { in: f.tab });
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      return probe === null || probe === undefined ? { stale: true } : { value: "" };
    }
    return { fallback: true };
  },

  // 자리의 탭을 그 창의 현재 탭으로 만든다(창을 앞으로 가져오지 않는다). args.script 가 있으면 확인은 doJavaScript 한 번(빠른 길)이고, 안 되면 예전 확인으로 돌아간다.
  showTab(args) {
    if (args.script) {
      let f = { kind: "fallback" };
      try {
        f = guardedRun(args); // 소스는 null — 부작용이 없으니 어떤 오류든 예전 확인으로 돌아가 판단한다(JS 꺼짐만 올린다)
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      if (f.kind === "ok") {
        Safari.windows.byId(args.windowId).currentTab = f.tab;
        return { value: null };
      }
    }
    const g = guardTab(args);
    if (!g) return { stale: true };
    const w = Safari.windows.byId(args.windowId);
    w.currentTab = g.tab;
    return { value: null };
  },

  closeTab(args) {
    const g = guardTab(args);
    if (!g) return { stale: true };
    g.tab.close();
    return { value: null };
  },

  ping() {
    return "pong";
  },
};

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    writeLine({ id: null, ok: false, error: { message: "잘못된 요청 줄: " + String(e.message) } });
    return;
  }
  try {
    const op = ops[req.op];
    if (!op) throw new Error("모르는 op: " + req.op);
    // 꺼진 사파리를 JXA 가 켜 버리지 않도록, 사파리를 건드리는 op 는 먼저 실행 여부를 본다.
    if (req.op !== "ping" && req.op !== "screenAccess" && !Safari.running()) {
      writeLine({ id: req.id, ok: false, error: { code: "SAFARI_NOT_RUNNING", message: "사파리가 꺼져 있음" } });
      return;
    }
    writeLine({ id: req.id, ok: true, value: op(req.args || {}) });
  } catch (e) {
    writeLine({
      id: req.id,
      ok: false,
      error: { message: String((e && e.message) || e), number: e && e.errorNumber },
    });
  }
}

let buffer = "";
for (;;) {
  const data = stdin.availableData;
  if (Number(data.length) === 0) break; // stdin 닫힘
  const chunk = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() !== "") handle(line);
  }
}
