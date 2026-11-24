// 사파리-어트랙션 확장 background(service worker).
// - 툴바 단추 · 단축키(⌥⇧E) → 그 탭의 content script 에게 「패널 열기 · 닫기」.
// - 패널(content script)이 port 로 묻기 · /info 를 보내면, 네이티브 핸들러에게 받은 연결 정보(포트 · 토큰)로 앱 로컬 서버에 묻고
//   답을 줄 단위로 port 로 돌려준다. **토큰은 이 파일의 메모리에만 있다** — content script · 페이지 · 저장소 · 로그에 보내지 않는다.
"use strict";

if (typeof importScripts === "function") {
  importScripts("lib/page.js", "lib/text.js", "lib/stream.js", "lib/bridge.js");
}

const ext = globalThis.browser || globalThis.chrome;
const lib = globalThis.SAPanelLib;

const bridge = lib.createBridge({
  // 네이티브 핸들러(SafariWebExtensionHandler)가 panel-link.json 을 읽어 { port, token } 또는 { error } 를 준다.
  getLinkNative: () => ext.runtime.sendNativeMessage("application.id", { type: "getLink" }),
  fetch: (url, init) => fetch(url, init),
  hasHostPermission: () => ext.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
});

// ── 패널 쪽 연결 ─────────────────────────────────────────────────────────────
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "sa-panel") return;
  let controller = null; // 지금 도는 묻기(하나만)

  const send = (message) => {
    try { port.postMessage(message); } catch (_) { /* 패널이 이미 닫힘 */ }
  };

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "info") {
      bridge.info(send);
    } else if (msg.t === "ask") {
      const request = sanitizeAsk(msg);
      if (!request) { send({ t: "error", message: "질문이 비어 있어요" }); return; }
      if (controller) controller.abort(); // 앞 질문이 남아 있으면 끊는다(서버 자리를 돌려준다)
      const mine = new AbortController();
      controller = mine;
      bridge.ask(request, send, mine.signal).finally(() => { if (controller === mine) controller = null; });
    } else if (msg.t === "cancel") {
      if (controller) { controller.abort(); controller = null; }
    }
  });

  // 패널을 닫거나 탭이 이동하면 묻기를 끊는다 — 서버가 CLI 를 멈추고 동시 질문 자리를 돌려준다.
  port.onDisconnect.addListener(() => {
    if (controller) { controller.abort(); controller = null; }
  });
});

/** 패널이 보낸 묻기를 서버로 보낼 모양으로 다시 다듬는다(모르는 키는 버린다). */
function sanitizeAsk(msg) {
  const question = typeof msg.question === "string" ? msg.question.trim().slice(0, 20000) : "";
  if (!question) return null;
  const request = { question, webSearch: msg.webSearch === true };
  if (msg.page && typeof msg.page === "object") request.page = lib.buildPage(msg.page);
  return request;
}

// ── 패널 모양(CSS) 전달 ──────────────────────────────────────────────────────
// 닫힌 Shadow DOM 안에 넣을 CSS 글을 content script 가 달라고 하면 이 확장의 panel.css 를 읽어 준다
// (페이지가 읽을 수 있는 web_accessible_resources 를 열지 않으려고).
let cssPromise = null;
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.t !== "css") return false;
  if (!cssPromise) {
    cssPromise = fetch(ext.runtime.getURL("panel.css")).then((r) => r.text()).catch(() => { cssPromise = null; return ""; });
  }
  cssPromise.then((css) => sendResponse({ css }));
  return true; // 비동기 응답
});

// ── 열기 · 닫기 ──────────────────────────────────────────────────────────────
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
