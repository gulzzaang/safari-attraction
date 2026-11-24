// 사파리-어트랙션 확장 background(manifest 의 background.scripts — lib/*.js 가 먼저 실리고 이 파일이 마지막).
// - 툴바 단추 · 단축키(⌥⇧E) → 그 탭의 content script 에게 「패널 열기 · 닫기」.
// - 패널(content script)이 port 로 묻기 · /info 를 보내면, 네이티브 핸들러에게 받은 연결 정보(포트 · 토큰)로 앱 로컬 서버에 묻고
//   답을 줄 단위로 port 로 돌려준다. **토큰은 이 파일의 메모리에만 있다** — content script · 페이지 · 저장소 · 로그에 보내지 않는다.
(function () {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  const lib = globalThis.SAPanelLib;

  // lib 이 안 실렸으면(확장 파일을 못 읽음) 조용히 죽지 말고 눈에 띄게 멈춘다.
  if (!lib || typeof lib.createBridge !== "function" || typeof lib.sanitizeAsk !== "function" || typeof lib.createAlertForwarder !== "function") {
    console.error("사파리-어트랙션: 확장 파일을 못 읽었어요");
    try {
      ext.action.setBadgeText({ text: "!" });
      ext.action.setTitle({ title: "사파리-어트랙션: 확장 파일을 못 읽었어요 — 확장을 껐다 켜 보세요" });
    } catch (_) { /* 무시 */ }
    return;
  }

  const bridge = lib.createBridge({
    // 네이티브 핸들러(SafariWebExtensionHandler)가 panel-link.json 을 읽어 { port, token } 또는 { error } 를 준다.
    getLinkNative: () => ext.runtime.sendNativeMessage("application.id", { type: "getLink" }),
    fetch: (url, init) => fetch(url, init),
    hasHostPermission: () => ext.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
  });

  // 사이트 알림 → 앱. 지켜볼 사이트 목록(/alert-hosts, 5분 기억)에 맞는 호스트만 /alert 로 보낸다.
  // 앱 꺼짐 · 연결 실패 · 403 은 조용히 버린다(패널 안내 없음). 토큰 · 알림 글은 어디에도 찍지 않는다.
  const alerts = lib.createAlertForwarder({ request: (path, init) => bridge.request(path, init) });

  /** 이 확장 자신의 content script · 페이지에서 온 것만 받는다. */
  const fromSelf = (sender) => !!sender && sender.id === ext.runtime.id;

  // ── 패널 쪽 연결 ───────────────────────────────────────────────────────────
  ext.runtime.onConnect.addListener((port) => {
    if (port.name !== "sa-panel" || !fromSelf(port.sender)) return;
    let controller = null; // 지금 도는 묻기(하나만)

    const send = (message) => {
      try { port.postMessage(message); } catch (_) { /* 패널이 이미 닫힘 */ }
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "info") {
        bridge.info(send);
      } else if (msg.t === "ask") {
        const request = lib.sanitizeAsk(msg);
        if (!request) { send({ t: "error", id: lib.askIdOf(msg), message: "질문이 비어 있어요" }); return; }
        if (controller) controller.abort(); // 앞 질문이 남아 있으면 끊는다(서버 자리를 돌려준다)
        const mine = new AbortController();
        controller = mine;
        // 질문 번호를 모든 줄에 붙여 돌려준다 — 패널은 지금 번호가 아닌 줄을 버린다.
        const tagged = (m) => send({ ...m, id: request.id });
        bridge.ask(request.body, tagged, mine.signal).finally(() => { if (controller === mine) controller = null; });
      } else if (msg.t === "cancel") {
        if (controller) { controller.abort(); controller = null; }
      }
    });

    // 패널을 닫거나 탭이 이동하면 묻기를 끊는다 — 서버가 CLI 를 멈추고 동시 질문 자리를 돌려준다.
    port.onDisconnect.addListener(() => {
      if (controller) { controller.abort(); controller = null; }
    });
  });

  // ── 사이트 알림(content script → 여기 → 앱) ────────────────────────────────
  ext.runtime.onMessage.addListener((msg, sender) => {
    if (!fromSelf(sender) || !msg || msg.t !== "alert") return false;
    // 호스트는 보낸 탭의 주소에서 다시 읽는다(없을 때만 메시지의 것).
    const senderHost = lib.hostFromUrl(sender.url || (sender.tab && sender.tab.url) || "");
    const payload = lib.alertPayload(msg, senderHost);
    if (payload) alerts.forward(payload).catch(() => { /* 조용히 버림 */ });
    return false;
  });

  // ── 패널 모양(CSS) 전달 ────────────────────────────────────────────────────
  // 닫힌 Shadow DOM 안에 넣을 CSS 글을 content script 가 달라고 하면 이 확장의 panel.css 를 읽어 준다
  // (페이지가 읽을 수 있는 web_accessible_resources 를 열지 않으려고).
  let cssPromise = null;
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!fromSelf(sender) || !msg || msg.t !== "css") return false;
    if (!cssPromise) {
      cssPromise = fetch(ext.runtime.getURL("panel.css")).then((r) => r.text()).catch(() => { cssPromise = null; return ""; });
    }
    cssPromise.then((css) => sendResponse({ css }));
    return true; // 비동기 응답
  });

  // ── 열기 · 닫기 ────────────────────────────────────────────────────────────
  async function togglePanel(tab) {
    if (!tab || typeof tab.id !== "number") return;
    try {
      await ext.tabs.sendMessage(tab.id, { t: "toggle" });
      try { await ext.action.setBadgeText({ tabId: tab.id, text: "" }); } catch (_) { /* 무시 */ }
    } catch (_) {
      // 이 탭에는 content script 가 없다 — 확장을 켠 뒤 열어 둔 페이지이거나 http(s) 페이지가 아님.
      try {
        await ext.action.setBadgeText({ tabId: tab.id, text: "!" });
        await ext.action.setTitle({ tabId: tab.id, title: "이 페이지를 새로 고친 뒤 다시 눌러 주세요(http · https 페이지에서만 열려요)" });
      } catch (_) { /* 무시 */ }
    }
  }

  ext.action.onClicked.addListener((tab) => { togglePanel(tab); });

  ext.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-panel") return;
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    togglePanel(tab);
  });
})();
