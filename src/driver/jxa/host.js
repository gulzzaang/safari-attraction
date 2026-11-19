// 사파리를 부리는 JXA 호스트. `osascript -l JavaScript host.js` 로 띄워 두고,
// stdin 으로 한 줄에 요청 하나 `{id, op, args}` 를 받아
// stdout 으로 한 줄에 답 하나 `{id, ok:true, value}` / `{id, ok:false, error:{message, number, code?}}` 를 쓴다.
// Node 쪽은 한글 등을 \uXXXX 로 이스케이프해 보내므로 입력은 항상 ASCII 다(청크 경계에서 글자가 잘릴 일이 없다).
// stdin 이 닫히면(길이 0) 끝낸다. 사파리를 켜는 일은 하지 않는다 — 꺼져 있으면 SAFARI_NOT_RUNNING 을 돌려준다.
ObjC.import("Foundation");

const Safari = Application("Safari");
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
// 표시가 키와 같거나, 아직 표시를 안 한 탭(args.unstamped)이면서 표시가 없고 주소가 기록과 같을 때.
// args.urlOnly 는 JS 를 못 도는 탭(경고창이 떠 있는 탭)을 닫을 때만 쓴다 — 표시를 못 읽으니 주소만 본다.
function guardTab(args) {
  if (args.urlOnly) {
    let tab;
    try {
      tab = tabOf(args);
      return str(tab.url()) === args.url ? { tab, marker: "" } : null;
    } catch (e) {
      return null;
    }
  }
  const p = probeTab(args.windowId, args.index);
  if (!p) return null;
  if (p.marker === args.key) return p;
  if (args.unstamped && p.marker === "" && p.url === args.url) return p;
  return null;
}

// 새 문서가 다 뜰 때까지(최대 15초) 기다려 표시를 적고 탭 정보를 돌려준다(rebind · settle 이 함께 쓴다).
function finishRebind(args, tab) {
  // 읽어 보아 표시가 남아 있는지 확인한다(뜨는 중에 적으면 지워질 수 있다).
  const budget = args.loadBudgetMs || 15000;
  const t1 = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    for (;;) {
      let ready = false;
      try {
        ready = str(Safari.doJavaScript("document.readyState", { in: tab })) === "complete";
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      if (ready || Date.now() - t1 > budget) break;
      delay(0.05);
    }
    const again = probeTab(args.windowId, args.index);
    if (!again) return { status: "gone" };
    if (again.marker !== "" && again.marker !== args.key) return { status: "other" };
    stampTab(tab, args.key);
    if (readMarker(tab) === args.key) break;
    delay(0.1);
  }
  const win = Safari.windows.byId(args.windowId);
  return {
    status: "ok",
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

// 탭이 있는 창만 일반 창으로 본다(설정 창 같은 건 탭이 없다). 맨 앞 것부터.
function normalWindows() {
  const out = [];
  Safari.windows().forEach((w) => {
    try {
      if (w.tabs.length > 0) out.push(w);
    } catch (e) {}
  });
  return out;
}

const ops = {
  listWindows() {
    return normalWindows().map((w) => ({
      id: w.id(),
      index: w.index(),
      isPrivate: false, // 사파리 스크립트 사전에 개인정보 보호 창을 가리키는 속성이 없다.
      tabCount: w.tabs.length,
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
        delay(0.05);
      }
    }
    return finishRebind(args, tab);
  },

  // 이동은 일어났는지 본다 — 표시가 남은 키의 탭이 그대로면 {status:"same"}, 자리의 탭에 표시가 없으면(새 문서)
  // 다 뜰 때까지 기다려 표시를 다시 적고 {status:"navigated"}. 다른 키의 표시 → "other", 탭 없음 → "gone".
  // 읽기만 하고 아무것도 지우지 않는다(표시가 없다는 이유로 탭을 잃지 않게 하려는 확인용).
  settle(args) {
    const p0 = probeTab(args.windowId, args.index);
    if (!p0) return { status: "gone" };
    if (p0.marker !== "" && p0.marker !== args.key) return { status: "other" };
    if (p0.marker === args.key) {
      const win = Safari.windows.byId(args.windowId);
      let leaving = false; // 문서를 떠나는 중인가(beforeunload — Page 가 동작 때 심는 깃발)
      try {
        leaving = Safari.doJavaScript("!!window.__saLeaving", { in: p0.tab }) === true;
      } catch (e) {
        if (isJsOffError(e)) throw e;
      }
      return {
        status: "same",
        leaving,
        tab: { windowId: args.windowId, index: args.index, title: str(p0.tab.name()), url: p0.url, isActive: args.index === win.currentTab().index() },
      };
    }
    const r = finishRebind(args, p0.tab);
    return r.status === "ok" ? { status: "navigated", tab: r.tab } : r;
  },

  // 자리의 탭에 표시를 적는다(탭 붙잡기).
  stamp(args) {
    const tab = tabOf(args);
    tab.url(); // 없는 탭이면 여기서 오류
    return stampTab(tab, args.key);
  },

  // 활성 탭은 바꾸지 않고 맨 뒤에 새 탭을 만든다. 페이지가 뜰 때까지(최대 loadBudgetMs) 기다린다.
  // 새 탭은 맨 앞 창(= 맨 앞 일반 창)에 연다. 사파리 스크립트 사전에는 개인정보 보호 창을 가리키는 속성이 없어
  // 개인정보 보호 창을 가려낼 수 없다 — 맨 앞 창이 개인정보 보호 창이면 거기에 열린다(알려진 한계).
  openTab(args) {
    let win;
    if (args.windowId !== undefined && args.windowId !== null) {
      win = Safari.windows.byId(args.windowId);
      win.id(); // 없는 창이면 여기서 오류
      win.tabs.push(Safari.Tab({ url: args.url }));
    } else {
      const wins = normalWindows();
      if (wins.length === 0) {
        Safari.make({ new: "document", withProperties: { url: args.url } });
        delay(0.3);
        const again = normalWindows();
        if (again.length === 0) throw new Error("새 창을 만들지 못함");
        win = again[0];
      } else {
        win = wins[0];
        win.tabs.push(Safari.Tab({ url: args.url }));
      }
    }
    const windowId = win.id();
    const index = win.tabs.length;
    const tab = win.tabs[index - 1];

    const t0 = Date.now();
    const budget = args.loadBudgetMs || 15000;
    const blank = args.url === "about:blank";
    for (;;) {
      let state = "";
      try {
        state = str(Safari.doJavaScript("location.href + ' ' + document.readyState", { in: tab }));
      } catch (e) {
        // 「Apple 이벤트에서 JavaScript 허용」이 꺼진 오류는 기다려도 소용없다 — 만든 탭을 닫고 그대로 올린다.
        // (사파리 오류 문구는 로케일에 따라 영어 또는 한국어.)
        const m = String(e.message);
        if (/Apple Events|Apple 이벤트/i.test(m) && /JavaScript/i.test(m)) {
          try {
            tab.close();
          } catch (e2) {}
          throw e;
        }
      }
      const sp = state.lastIndexOf(" ");
      const href = state.slice(0, sp);
      const ready = state.slice(sp + 1) === "complete";
      if (ready && href !== "" && (blank || href !== "about:blank")) break;
      if (Date.now() - t0 > budget) break;
      delay(0.05);
    }

    const stamped = args.key ? stampTab(tab, args.key) : false;
    const current = win.currentTab().index();
    return {
      windowId,
      index,
      title: str(tab.name()),
      url: str(tab.url()),
      isActive: index === current,
      stamped,
    };
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
      url = str(g.tab.url()); // 이동했을 수 있으니 지금 주소도 돌려준다(Node 쪽 기록을 새로 한다)
    } catch (e) {}
    return { value, url };
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
    if (req.op !== "ping" && !Safari.running()) {
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
  if (data.length === 0) break; // stdin 닫힘
  const chunk = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() !== "") handle(line);
  }
}
