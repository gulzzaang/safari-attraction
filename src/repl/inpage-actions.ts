/**
 * 페이지 안에서 도는 동작 코드(click · fill · 글쇠 · evaluate · goto). 진짜 입력이 아니라 이벤트를 보내는 방식이다 —
 * 사파리를 앞으로 가져오지 않고 뒤쪽 탭에서도 돌려야 해서다(화면 좌표 클릭은 쓰지 않는다).
 *
 * 한 번 부르면 즉시 실행 함수 하나가 돌고, 값은 JSON 글이다.
 *   성공  {"ok":true,"r":{…}}   r.expectNav = 이 동작이 이 문서를 떠나는 이동을 일으켰다고 그 자리에서 알 수 있다
 *   실패  {"ok":false,"err":"한국어 문장"}
 * 사파리의 `do JavaScript` 는 마지막 식의 값을 돌려주고 약속(Promise)은 기다려 주지 않는다.
 * 페이지 안에서 문자열을 eval 하는 곳은 없다(엄격한 CSP 에서도 돌도록).
 */

import { DEEP_SOURCE, NAME_SOURCE } from "../snapshot/inpage.js";
import { LOCATOR_SOURCE } from "./inpage-locator.js";

/**
 * 동작 이름. click · fill · text · prop · count · state · check · select · lpress · ltype · hover · focus · scroll 은 Locator 의 chain(args.chain)을
 * 풀어 요소를 찾고 바로 동작한다. press · type 은 포커스된 요소에(keyboard), goto · nav 는 문서 이동이다.
 */
export const ACTION_OPS = ["click", "fill", "text", "prop", "count", "state", "check", "select", "lpress", "ltype", "hover", "focus", "scroll", "press", "type", "goto", "nav"] as const;
export type ActionOp = (typeof ACTION_OPS)[number];

/** 페이지 안에서 동작이 끝난 뒤 보내는 결과. */
export interface ActionOk {
  ok: true;
  r: {
    /** 링크 · 폼 제출 · goto 처럼 문서를 떠나는 이동이 일어난 게 분명하다. */
    expectNav?: boolean;
    text?: string;
    /** 값을 돌려주는 동작(prop · count · state · select)의 결과(JSON). */
    v?: unknown;
    /** 동작 중 페이지가 setTimeout 으로 잡아 둔 가장 긴 지연(ms). 없으면 -1. 늦게 일어나는 이동(타이머 리다이렉트)을 기다릴지 정한다. */
    timerMs?: number;
    /** evaluate 결과를 JSON.stringify 한 글(undefined 면 없다). */
    s?: string;
    /** 결과가 약속이라 끝나길 기다려야 한다 — window.__saPend[pending] 을 읽는다. */
    pending?: string;
  };
}
export interface ActionErr {
  ok: false;
  err: string;
}

/** evaluate 가 약속을 돌려줬을 때 결과를 읽는 글. */
export function buildPendingReadSource(id: string): string {
  return `(function(){var p=window.__saPend&&window.__saPend[${JSON.stringify(id)}];if(!p)return JSON.stringify({state:'lost'});if(p.state!=='pending')delete window.__saPend[${JSON.stringify(id)}];return JSON.stringify(p)})()`;
}

export function buildActionSource(op: ActionOp, args: Record<string, unknown> & { tok: string }): string {
  // 요소를 찾는 동작(chain 이 있는 것)만 역할 · 이름 계산과 chain 풀이 코드를 함께 보낸다.
  const loc = Array.isArray(args.chain) ? NAME_SOURCE + LOCATOR_SOURCE : '';
  return `(function(A){${plant('A')}${DEEP_SOURCE}${loc}${PRELUDE}${BODY}})(${JSON.stringify({ ...args, op })})`;
}

const plant = (arg: string) => PLANT.split('__SA_ARG__').join(arg);

/**
 * evaluate 는 식 · 함수의 소스를 스크립트 글에 그대로 끼워 넣는다 — 페이지 안에서 문자열을 eval 하지 않으므로
 * 엄격한 CSP(unsafe-eval 없음)에서도 돈다. 다른 동작의 도우미 함수와 이름이 부딪치지 않게 따로 만든 스크립트다.
 * 식이어야 한다(함수 식이면 arg 를 넣어 부른다). 문법 오류는 스크립트 전체를 깨뜨리므로 부르기 전에 걸러야 한다(page.ts).
 */
export function buildEvalSource(src: string, arg: unknown, tok: string): string {
  return `(function(__saA){${plant('__saA')}
  try {
    var __saVal = (function(){ return (${src}
    ); })();
    if (typeof __saVal === 'function') __saVal = __saVal(__saA.arg);
    var __saR = { timerMs: __saTimers() };
    if (__saVal && typeof __saVal.then === 'function') {
      window.__saPend = window.__saPend || {};
      var __saRec = window.__saPend[__saA.tok] = { state: 'pending' };
      __saVal.then(function (v) { try { __saRec.s = JSON.stringify(v); __saRec.state = 'ok'; } catch (e) { __saRec.err = '결과를 JSON 으로 바꿀 수 없음: ' + (e && e.message); __saRec.state = 'err'; } },
                   function (e) { __saRec.err = String((e && e.message) || e); __saRec.state = 'err'; });
      __saR.pending = __saA.tok;
    } else {
      try { __saR.s = JSON.stringify(__saVal); } catch (e) { return JSON.stringify({ ok: false, err: '결과를 JSON 으로 바꿀 수 없음: ' + (e && e.message) }); }
    }
    return JSON.stringify({ ok: true, r: __saR });
  } catch (e) {
    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
  } finally { __saTimersStop(); }
})(${JSON.stringify({ arg, tok })})`;
}

// 페이지 안에서 도는 코드. 문자열로 둔다(번들러가 함수 이름을 끼워 넣어도 깨지지 않게).
// 백틱 · ${ 는 쓰지 않는다(String.raw).
// 모든 동작의 첫머리: 표시를 심고, 문서를 떠나는 중인지(beforeunload) 깃발을 세우고, 동작 동안 setTimeout 지연을 적어 둔다.
// __SA_ARG__ 는 인자 변수 이름으로 바꿔 넣는다(일반 동작 A, evaluate __saA — 페이지 전역 이름과 안 부딪치게).
const PLANT = String.raw`
  window.__saTok = __SA_ARG__.tok;
  window.__saLeaving = false;
  if (!window.__saUnl) {
    window.__saUnl = 1;
    window.addEventListener('beforeunload', function () { window.__saLeaving = true; });
    // 뒤로 · 앞으로 가기로 이 문서가 되살아나면(bfcache) 「떠나는 중」 깃발이 옛 값으로 남아 있으므로 내린다.
    window.addEventListener('pageshow', function () { window.__saLeaving = false; });
  }
  var __saOrigST = window.setTimeout, __saMax = -1;
  function __saPatched(fn, ms) { var d = +ms || 0; if (d > __saMax) __saMax = d; return __saOrigST.apply(this, arguments); }
  window.setTimeout = __saPatched;
  function __saTimers() { return __saMax; }
  function __saTimersStop() { if (window.setTimeout === __saPatched) window.setTimeout = __saOrigST; }
`;

const PRELUDE = String.raw`
  function fail(msg) { var e = new Error(msg); e.saPlain = true; throw e; }
  // 요소가 든 문서의 창(iframe 안 요소는 그 iframe 창). 이벤트 · 값 대입은 그 창의 생성자로 만든다.
  function winOf(el) { return (el && el.ownerDocument && el.ownerDocument.defaultView) || window; }
  function linkNav(a) {
    var h = a.getAttribute('href');
    if (!h || h.charAt(0) === '#' || /^\s*(javascript:|mailto:|tel:)/i.test(h)) return false;
    var t = (a.target || '').toLowerCase();
    if ((t && t !== '_self') || a.hasAttribute('download')) return false;
    try {
      var cur = a.ownerDocument.location.href;
      var u = new URL(a.href, cur);
      if (!/^(https?|file):$/.test(u.protocol)) return false;
      if (u.hash && u.href.split('#')[0] === cur.split('#')[0]) return false;
    } catch (e) { return false; }
    return true;
  }
  // 동작 동안 submit 이벤트를 지켜본다(막히지 않고 제출됐으면 이동이 일어난다).
  var sub = { fired: false, nav: false };
  function onSubmit(e) {
    sub.fired = true;
    var f = e.target;
    var tg = ((f && f.target) || '').toLowerCase();
    if (!e.defaultPrevented && (!tg || tg === '_self') && !(f && f.method && f.method.toLowerCase() === 'dialog')) sub.nav = true;
  }
  window.addEventListener('submit', onSubmit);
  // 동작 동안 이 문서를 떠나는 이동(Navigation API 의 navigate 이벤트)이 시작됐나. 핸들러가 곧바로 location.href 를 바꾸는 경우도 잡는다.
  // 같은 문서 안 이동(해시 · pushState) · 내려받기는 뺀다. Navigation API 가 없는 사파리에서는 이 신호 없이 예전처럼 돈다.
  var navFired = false;
  function onNavigate(e) {
    if (e.hashChange || e.downloadRequest || (e.destination && e.destination.sameDocument)) return;
    navFired = true;
  }
  var navApi = window.navigation && typeof window.navigation.addEventListener === 'function' ? window.navigation : null;
  if (navApi) navApi.addEventListener('navigate', onNavigate);

  function mouse(type, el, x, y, buttons) {
    var W = winOf(el);
    var init = { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y,
                 screenX: x, screenY: y, button: 0, buttons: buttons, detail: type === 'click' ? 1 : 0 };
    var ev;
    if (type.indexOf('pointer') === 0 && typeof W.PointerEvent === 'function') {
      init.pointerType = 'mouse'; init.isPrimary = true; init.pointerId = 1;
      ev = new W.PointerEvent(type, init);
    } else ev = new W.MouseEvent(type, init);
    return el.dispatchEvent(ev);
  }
  var FOCUSABLE = 'input,textarea,select,button,a[href],summary,[tabindex],[contenteditable=""],[contenteditable=true]';
  function doClick(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') fail('비활성 요소라 누를 수 없음');
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    mouse('pointerdown', el, x, y, 1);
    mouse('mousedown', el, x, y, 1);
    var f = el.closest ? el.closest(FOCUSABLE) : null;
    if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    mouse('pointerup', el, x, y, 0);
    mouse('mouseup', el, x, y, 0);
    var notPrevented = mouse('click', el, x, y, 0);
    var a = el.closest ? el.closest('a[href]') : null;
    return notPrevented && ((a && linkNav(a)) || sub.nav);
  }

  // Locator 의 chain 을 풀어 동작 대상 하나(보이는 첫 번째)를 고른다. 없으면 한국어 오류.
  function locOne() {
    var m = pwResolve(A.chain);
    if (!m.length) {
      var c = A.chain;
      if (c.length === 1 && c[0].k === 'ref') fail(c[0].s + ' 요소를 찾을 수 없음 — 페이지가 바뀌었을 수 있으니 snapshot 을 다시 찍어 새 ref 를 쓰세요');
      if (c.length === 1 && c[0].k === 'css') fail('선택자에 맞는 요소 없음: ' + c[0].s + ' — snapshot 으로 지금 화면을 확인하세요');
      fail('찾는 요소가 없어요: ' + A.desc);
    }
    return pwPick(m);
  }
  function hoverEvent(type, el, x, y, bubbles) {
    var W = winOf(el);
    var init = { bubbles: bubbles, cancelable: bubbles, composed: true, view: W, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0 };
    var ev;
    if (type.indexOf('pointer') === 0 && typeof W.PointerEvent === 'function') { init.pointerType = 'mouse'; init.isPrimary = true; init.pointerId = 1; ev = new W.PointerEvent(type, init); }
    else ev = new W.MouseEvent(type, init);
    el.dispatchEvent(ev);
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return /^(text|search|email|url|tel|password|number|)$/i.test(el.getAttribute('type') || '');
  }
  function setNativeValue(el, v) {
    var W = winOf(el);
    var proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }
  function inputEvent(el, type, data) {
    var ev, W = winOf(el);
    try { ev = new W.InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, inputType: data === null ? 'deleteContentBackward' : 'insertText', data: data }); }
    catch (e) { ev = new W.Event(type, { bubbles: true }); }
    return el.dispatchEvent(ev);
  }
  // 글자 하나(또는 지우기: ch === null)를 입력칸의 커서 자리에 넣는다.
  function insert(el, ch) {
    if (isTextField(el)) {
      var v = el.value;
      var s = v.length, e = v.length;
      try { if (el.selectionStart !== null) { s = el.selectionStart; e = el.selectionEnd; } } catch (x) {}
      if (ch === null) { if (s === e) { if (s === 0) return; s = s - 1; } ch = ''; }
      if (!inputEvent(el, 'beforeinput', ch === '' ? null : ch)) return;
      setNativeValue(el, v.slice(0, s) + ch + v.slice(e));
      try { el.setSelectionRange(s + ch.length, s + ch.length); } catch (x) {}
      inputEvent(el, 'input', ch === '' ? null : ch);
    } else if (el && el.isContentEditable) {
      if (ch === null) el.ownerDocument.execCommand('delete'); else el.ownerDocument.execCommand('insertText', false, ch);
    }
  }

  var KEYS = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'] };
  var ALIAS = { Esc: 'Escape', Return: 'Enter', ' ': 'Space', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
  function keyEvent(type, name, target) {
    var info = KEYS[name];
    var ch = name === 'Space' ? ' ' : name;
    var kc = info ? info[0] : (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
    var code = info ? info[1] : (/^[a-z]$/i.test(name) ? 'Key' + name.toUpperCase() : (/^[0-9]$/.test(name) ? 'Digit' + name : ''));
    var init = { key: ch, code: code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, view: winOf(target) };
    if (type === 'keypress') { var cc = ch.length === 1 ? ch.charCodeAt(0) : (name === 'Enter' ? 13 : 0); init.charCode = cc; init.keyCode = cc; init.which = cc; }
    return target.dispatchEvent(new (winOf(target).KeyboardEvent)(type, init));
  }
  // 지금 초점이 있는 요소. shadow root · 같은 출처 iframe 안쪽까지 따라 들어간다.
  function activeTarget() {
    var t = document.activeElement;
    for (var i = 0; t && i < 20; i++) {
      var inner = null;
      try {
        if (t.shadowRoot && t.shadowRoot.activeElement) inner = t.shadowRoot.activeElement;
        else if (t.tagName === 'IFRAME' && t.contentDocument && t.contentDocument.activeElement) inner = t.contentDocument.activeElement;
      } catch (e) {}
      if (!inner || inner === t) break;
      t = inner;
    }
    return (!t || t === t.ownerDocument.documentElement) ? (t ? t.ownerDocument.body : document.body) : t;
  }
  function nextFocus(from, back) {
    var all = Array.prototype.filter.call(__saDeepAll(FOCUSABLE), function (e) {
      return !e.disabled && e.getAttribute('tabindex') !== '-1' && e.type !== 'hidden' && (e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    });
    if (!all.length) return null;
    var i = all.indexOf(from);
    return all[i < 0 ? (back ? all.length - 1 : 0) : (i + (back ? -1 : 1) + all.length) % all.length];
  }

  // 글쇠 하나를 누른다. 이동이 일어났으면 true.
  function pressKey(name) {
    name = ALIAS[name] || name;
    var t = activeTarget();
    var mo = new MutationObserver(function () {});
    mo.observe(t.ownerDocument, { childList: true, attributes: true, characterData: true, subtree: true });
    var href0 = location.href;
    var nav = false;
    try {
      var go = keyEvent('keydown', name, t);
      var proceed = go;
      if (go && (name.length === 1 || name === 'Enter' || name === 'Space')) proceed = keyEvent('keypress', name, t);
      if (proceed) {
        if (name.length === 1) insert(t, name);
        else if (name === 'Space') insert(t, ' ');
        else if (name === 'Backspace') insert(t, null);
        else if (name === 'Tab') { var n = nextFocus(t, false); if (n) n.focus(); }
        else if (name === 'Enter') {
          if (t.tagName === 'TEXTAREA') insert(t, '\n');
          else if (t.isContentEditable) t.ownerDocument.execCommand('insertParagraph');
          else if (t.tagName === 'A' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY' || (t.tagName === 'INPUT' && /^(submit|button|image|reset|checkbox|radio)$/i.test(t.type))) nav = doClick(t);
        }
      }
      keyEvent('keyup', name, t);
      if (name === 'Enter' && t.tagName === 'INPUT' && t.form && !nav) {
        // 입력칸에서 엔터를 쳤는데 막혔거나 아무 일도 없으면(합성 키 이벤트는 폼을 알아서 제출하지 않는다) 폼을 제출한다.
        var happened = sub.fired || mo.takeRecords().length > 0 || location.href !== href0;
        if (!go || !proceed || !happened) {
          if (!sub.fired) { try { t.form.requestSubmit(); } catch (e) { fail('폼 제출에 실패: ' + (e && e.message)); } }
        }
      }
    } finally { mo.disconnect(); }
    return nav || sub.nav;
  }

`;

const BODY = String.raw`
  try {
    var r = {};
    switch (A.op) {
      case 'click': {
        var el = locOne();
        r.expectNav = !!doClick(el);
        break;
      }
      case 'fill': {
        var el = locOne();
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        if (el.tagName === 'SELECT') {
          el.focus(); el.value = A.value;
          el.dispatchEvent(new (winOf(el).Event)('input', { bubbles: true })); el.dispatchEvent(new (winOf(el).Event)('change', { bubbles: true }));
        } else if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|file|button|submit|image|reset|range|color|hidden)$/i.test(el.type))) {
          el.focus();
          setNativeValue(el, A.value);
          inputEvent(el, 'input', A.value);
          el.dispatchEvent(new (winOf(el).Event)('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.focus();
          var ed = el.ownerDocument;
          ed.execCommand('selectAll', false, null);
          if (A.value === '') ed.execCommand('delete'); else ed.execCommand('insertText', false, A.value);
        } else {
          fail('글을 채울 수 없는 요소임(' + el.tagName.toLowerCase() + ') — 입력칸이나 편집 가능한 영역을 고르세요');
        }
        break;
      }
      case 'text': {
        r.text = locOne().textContent || '';
        break;
      }
      case 'count': {
        r.v = pwResolve(A.chain).length;
        break;
      }
      case 'state': {
        var ms = pwResolve(A.chain), anyVis = false;
        for (var si = 0; si < ms.length && !anyVis; si++) anyVis = pwVis(ms[si]);
        r.v = { n: ms.length, vis: anyVis };
        break;
      }
      case 'prop': {
        if (A.what === 'isVisible') {
          var pm = pwResolve(A.chain), pv = false;
          for (var pi = 0; pi < pm.length && !pv; pi++) pv = pwVis(pm[pi]);
          r.v = pv;
          break;
        }
        var el = locOne();
        if (A.what === 'innerText') r.v = pwInnerText(el);
        else if (A.what === 'inputValue') {
          if (!('value' in el)) fail('입력칸이 아니라 값을 읽을 수 없음(' + el.tagName.toLowerCase() + ') — ' + A.desc);
          r.v = String(el.value);
        }
        else if (A.what === 'attr') r.v = el.getAttribute(A.name);
        else if (A.what === 'isChecked') {
          if (el.tagName === 'LABEL' && el.control) el = el.control;
          r.v = pwOn(el);
        }
        else if (A.what === 'isEnabled') r.v = !(el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true');
        else fail('알 수 없는 읽기: ' + A.what);
        break;
      }
      case 'check': {
        var el = locOne();
        if (el.tagName === 'LABEL' && el.control) el = el.control;
        var isNative = el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type);
        if (!isNative && !/^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '')) fail('체크박스나 라디오가 아니라 켜고 끌 수 없음: ' + A.desc);
        var want = !!A.want;
        if (pwOn(el) !== want) {
          if (!want && el.type === 'radio') fail('라디오는 끌 수 없음(다른 것을 고르세요): ' + A.desc);
          r.expectNav = !!doClick(el);
          if (isNative && !r.expectNav && pwOn(el) !== want) fail('눌렀는데 상태가 바뀌지 않았음(페이지가 막은 것 같음): ' + A.desc);
        }
        break;
      }
      case 'select': {
        var el = locOne();
        if (el.tagName !== 'SELECT') fail('<select> 요소가 아니라 고를 수 없음(' + el.tagName.toLowerCase() + '): ' + A.desc);
        if (el.disabled) fail('비활성 요소라 고를 수 없음: ' + A.desc);
        var opts = Array.prototype.slice.call(el.options), chosen = [];
        for (var oi = 0; oi < A.sel.length; oi++) {
          var spec = A.sel[oi], found = -1;
          for (var oj = 0; oj < opts.length && found < 0; oj++) {
            var o1 = opts[oj];
            if (spec.any !== undefined ? (o1.value === spec.any || o1.label === spec.any || pwNorm(o1.textContent) === pwNorm(spec.any)) :
                (spec.value !== undefined && o1.value === spec.value) || (spec.label !== undefined && (o1.label === spec.label || pwNorm(o1.textContent) === pwNorm(spec.label))) || (spec.index !== undefined && spec.index === oj)) found = oj;
          }
          if (found < 0) fail('고를 선택지가 없음: ' + JSON.stringify(spec.any !== undefined ? spec.any : spec) + ' — ' + A.desc);
          chosen.push(found);
        }
        if (!chosen.length) fail('고를 선택지를 하나 이상 넘기세요');
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        el.focus();
        if (el.multiple) for (var ok = 0; ok < opts.length; ok++) opts[ok].selected = chosen.indexOf(ok) >= 0;
        else el.selectedIndex = chosen[chosen.length - 1];
        el.dispatchEvent(new (winOf(el).Event)('input', { bubbles: true }));
        el.dispatchEvent(new (winOf(el).Event)('change', { bubbles: true }));
        r.expectNav = sub.nav;
        r.v = Array.prototype.map.call(el.selectedOptions, function (x) { return x.value; });
        break;
      }
      case 'lpress': {
        var el = locOne();
        try { el.focus(); } catch (e) {}
        r.expectNav = !!pressKey(String(A.key));
        break;
      }
      case 'ltype': {
        var el = locOne();
        var wasActive = el.ownerDocument.activeElement === el;
        try { el.focus(); } catch (e) {}
        if (!wasActive && isTextField(el)) { try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }
        var tchars = Array.from(String(A.text)), tnav = false;
        for (var ti = 0; ti < tchars.length; ti++) { if (tchars[ti] === '\n') tnav = pressKey('Enter') || tnav; else pressKey(tchars[ti]); }
        r.expectNav = tnav || sub.nav;
        break;
      }
      case 'hover': {
        var el = locOne();
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        var hr = el.getBoundingClientRect();
        var hx = Math.round(hr.left + hr.width / 2), hy = Math.round(hr.top + hr.height / 2);
        hoverEvent('pointerover', el, hx, hy, true); hoverEvent('pointerenter', el, hx, hy, false);
        hoverEvent('mouseover', el, hx, hy, true); hoverEvent('mouseenter', el, hx, hy, false);
        hoverEvent('pointermove', el, hx, hy, true); hoverEvent('mousemove', el, hx, hy, true);
        break;
      }
      case 'focus': {
        var el = locOne();
        el.focus();
        break;
      }
      case 'scroll': {
        var el = locOne();
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        break;
      }
      case 'nav': {
        r.expectNav = true;
        if (A.dir === 'reload') location.reload();
        else if (A.dir === 'back') history.back();
        else history.forward();
        break;
      }
      case 'press': {
        r.expectNav = !!pressKey(String(A.key));
        break;
      }
      case 'type': {
        var chars = Array.from(String(A.text)), nav = false;
        for (var i = 0; i < chars.length; i++) { if (chars[i] === '\n') nav = pressKey('Enter') || nav; else pressKey(chars[i]); }
        r.expectNav = nav || sub.nav;
        break;
      }
      case 'goto': {
        var next = new URL(A.url, location.href);
        var hashOnly = next.hash !== '' && next.href.split('#')[0] === location.href.split('#')[0];
        location.href = A.url;
        r.expectNav = !hashOnly;
        break;
      }
      default: fail('알 수 없는 동작: ' + A.op);
    }
    if (navFired) r.expectNav = true;
    r.timerMs = __saTimers();
    return JSON.stringify({ ok: true, r: r });
  } catch (e) {
    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
  } finally {
    window.removeEventListener('submit', onSubmit);
    if (navApi) navApi.removeEventListener('navigate', onNavigate);
    __saTimersStop();
  }
`;
