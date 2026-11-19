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

// 탭 키 `windowId:index`(index 는 사파리 방식 1부터).
function tabOf(args) {
  return Safari.windows.byId(args.windowId).tabs[args.index - 1];
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
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

  // 활성 탭은 바꾸지 않고 맨 뒤에 새 탭을 만든다. 페이지가 뜰 때까지(최대 loadBudgetMs) 기다린다.
  openTab(args) {
    let win;
    if (args.windowId !== undefined && args.windowId !== null) {
      win = Safari.windows.byId(args.windowId);
      win.id(); // 없는 창이면 여기서 오류
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
        if (/Apple Events/i.test(String(e.message))) throw e;
      }
      const sp = state.lastIndexOf(" ");
      const href = state.slice(0, sp);
      const ready = state.slice(sp + 1) === "complete";
      if (ready && href !== "" && (blank || href !== "about:blank")) break;
      if (Date.now() - t0 > budget) break;
      delay(0.05);
    }

    const current = win.currentTab().index();
    return {
      windowId,
      index,
      title: str(tab.name()),
      url: str(tab.url()),
      isActive: index === current,
    };
  },

  runJs(args) {
    const res = Safari.doJavaScript(args.source, { in: tabOf(args) });
    if (res === null || res === undefined) return "";
    if (typeof res === "string") return res;
    if (typeof res === "number" || typeof res === "boolean") return String(res);
    return JSON.stringify(res);
  },

  closeTab(args) {
    tabOf(args).close();
    return null;
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
