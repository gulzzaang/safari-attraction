export interface SnapshotOptions {
  /** 대화형 요소만(글 덩어리는 뺀다). */
  interactive?: boolean;
  /** 이 CSS 선택자(또는 `e12` 같은 ref)에 맞는 첫 요소 안만 읽는다. */
  selector?: string;
  /** 화면에 보이는 범위가 아니라 문서 전체를 읽는다. */
  full?: boolean;
}

/**
 * 페이지 안에서 돌릴 자바스크립트 원문. 값은 글(문자열)이다 — 머리 줄 `- title: "…" [url=…]` 다음에
 * 대화형 요소 `- <역할> "<이름>" [ref=eN]` 과 글 덩어리 `- <종류> "<글>"` 가 문서 순서대로 이어진다.
 * ref 는 요소에 `data-sa-ref` 로 붙어 같은 문서 안에서는 다시 읽어도 같다.
 * 사파리의 `do JavaScript` 는 마지막 식의 값을 돌려주므로 즉시 실행 함수 하나다.
 */
export function buildSnapshotSource(opts: SnapshotOptions = {}): string {
  const o = { interactive: !!opts.interactive, selector: opts.selector ?? "", full: !!opts.full };
  return `(${PAGE_FN})(${JSON.stringify(o)})`;
}

/**
 * 페이지 안 공용 찾기 함수 둘(소스 글). 읽기 · 조작이 같은 규칙으로 요소를 찾도록 둘 다 이 글을 끼워 쓴다.
 *   __saDeepAll(selector)       화면에 그려지는 순서(shadow root 는 호스트 자리, 같은 출처 iframe 은 iframe 자리)로 깊이 우선, 일치를 모두.
 *   __saDeepQuery(selectorOrRef) 먼저 문서에서 찾고, 없으면 위 순서로 첫 일치. `e12` 꼴은 data-sa-ref 로 찾는다.
 * 다른 출처 iframe · 닫힌 shadow root 는 들어갈 수 없어 건너뛴다. 오류(잘못된 선택자)는 그대로 던진다.
 * 백틱 · 달러-중괄호는 쓰지 않는다(String.raw).
 */
export const DEEP_SOURCE = String.raw`
  function __saTreeRoots(acc, root) {
    acc.push(root);
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.shadowRoot) __saTreeRoots(acc, e.shadowRoot);
      if (e.tagName === 'IFRAME') {
        var d = null;
        try { d = e.contentDocument; } catch (x) {}
        if (d && d.documentElement) __saTreeRoots(acc, d);
      }
    }
    return acc;
  }
  function __saSel(s) { return /^e\d+$/.test(s) ? '[data-sa-ref="' + s + '"]' : s; }
  // 평평한 트리(화면에 그려지는 순서)로 깊이 우선: shadow root 안은 호스트 자리에, slot 은 배정된 노드 자리에,
  // 같은 출처 iframe 안은 iframe 자리에 나온다. 초점 이동(Tab) 순서가 이 순서다.
  function __saDeepAll(sel) {
    var out = [];
    function visit(el) {
      if (el.matches(sel)) out.push(el);
      var kids = el.children;
      if (el.shadowRoot) kids = el.shadowRoot.children;
      else if (el.tagName === 'SLOT' && typeof el.assignedNodes === 'function') {
        var an = el.assignedNodes({ flatten: true }), els = [];
        for (var k = 0; k < an.length; k++) if (an[k].nodeType === 1) els.push(an[k]);
        kids = els;
      } else if (el.tagName === 'IFRAME') {
        var d = null;
        try { d = el.contentDocument; } catch (x) {}
        kids = d && d.documentElement ? [d.documentElement] : [];
      }
      var arr = Array.prototype.slice.call(kids);
      for (var i = 0; i < arr.length; i++) visit(arr[i]);
    }
    visit(document.documentElement);
    return out;
  }
  function __saDeepQuery(sel) {
    sel = __saSel(sel);
    var first = document.querySelector(sel);
    if (first) return first;
    var rs = __saTreeRoots([], document);
    for (var i = 1; i < rs.length; i++) {
      var f = rs[i].querySelector(sel);
      if (f) return f;
    }
    return null;
  }
`;

// 페이지 안에서 도는 코드. 일부러 문자열로 둔다(번들러가 함수 이름을 끼워 넣어도 깨지지 않게).
const PAGE_FN = String.raw`function (o) {
` + DEEP_SOURCE + String.raw`
  var NAME_MAX = 60, TEXT_MAX = 140, SOFT_CHARS = 20000;
  var INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=""],[contenteditable=true]';
  var BLOCK = 'h1,h2,h3,h4,p,li,td,th';
  var BLOCK_ROLE = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', P: 'paragraph', LI: 'listitem', TD: 'cell', TH: 'cell' };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1 };

  function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

  var title = clip(document.title || '', TEXT_MAX);
  var out = ['- title: ' + q(title) + ' [url=' + location.href + ']'];

  var root = document.body || document.documentElement;
  if (o.selector) {
    try { root = __saDeepQuery(o.selector); } catch (e) { return out.concat('- error: ' + q('선택자가 잘못됨: ' + o.selector)).join('\n'); }
    if (!root) return out.concat('- error: ' + q('선택자에 맞는 요소 없음: ' + o.selector)).join('\n');
  }

  // ref 번호는 문서 안에서 이어 붙인다. 이미 붙은 것(이전 읽기 · 다른 도구)의 가장 큰 번호 다음부터.
  if (typeof window.__saRefN !== 'number') {
    var max = 0, used = __saDeepAll('[data-sa-ref]');
    for (var u = 0; u < used.length; u++) { var m = /^e(\d+)$/.exec(used[u].getAttribute('data-sa-ref') || ''); if (m && +m[1] > max) max = +m[1]; }
    window.__saRefN = max;
  }
  function refOf(el) {
    var r = el.getAttribute('data-sa-ref');
    if (!r) { r = 'e' + (++window.__saRefN); el.setAttribute('data-sa-ref', r); }
    return r;
  }

  var vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
  // 화면에 보이는지. iframe 안 요소는 자기 창 안의 위치에 iframe 의 위치를 차례로 더해 맨 위 창 기준으로도 따진다.
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (!o.full) {
      var win = el.ownerDocument.defaultView, L = r.left, T = r.top, R = r.right, B = r.bottom;
      for (var depth = 0; win && depth < 10; depth++) {
        var wv = win === window ? vw : (win.innerWidth || 0), wh = win === window ? vh : (win.innerHeight || 0);
        if (B <= 0 || R <= 0 || T >= wh || L >= wv) return false;
        if (win === window) break;
        var fe = null;
        try { fe = win.frameElement; } catch (x) {}
        if (!fe) break;
        var fr = fe.getBoundingClientRect();
        L += fr.left; R += fr.left; T += fr.top; B += fr.top;
        win = win.parent;
      }
    }
    if (typeof el.checkVisibility === 'function') { if (!el.checkVisibility({ visibilityProperty: true })) return false; }
    else { var cs = el.ownerDocument.defaultView.getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; }
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function isInteractive(el) { return el.matches(INTERACTIVE); }
  function isBlock(el) { return el.matches(BLOCK); }

  // 요소의 보이는 글. 안쪽의 대화형 요소 · 다른 글 덩어리는 따로 줄이 되므로 여기서는 뺀다.
  function ownText(el) {
    var s = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.nodeValue + ' ';
        else if (c.nodeType === 1) {
          if (SKIP_TAGS[c.tagName] || c.getAttribute('aria-hidden') === 'true' || c.hidden) continue;
          if (isInteractive(c) || isBlock(c)) continue;
          walk(c);
        }
        if (s.length > TEXT_MAX * 3) return;
      }
    })(el);
    return clip(s, TEXT_MAX);
  }
  // 평평한 트리의 글(innerText · textContent 는 사파리에서 slot 에 배정된 노드를 빼 먹는다):
  // slot 은 배정된 노드(없으면 slot 안의 기본 내용), shadow 호스트는 shadow root 안, 숨은 것 · svg 등은 건너뛴다.
  function flatText(root, limit) {
    var s = '', cap = limit * 3;
    function visit(c) {
      if (s.length > cap) return;
      if (c.nodeType === 3) { s += c.nodeValue; return; }
      if (c.nodeType !== 1) return;
      var tg = c.tagName;
      if (SKIP_TAGS[tg] || c.getAttribute('aria-hidden') === 'true' || c.hidden) return;
      var disp = 'inline';
      if (tg !== 'SLOT') {
        try { var cs = c.ownerDocument.defaultView.getComputedStyle(c); disp = cs.display; if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return; } catch (x) {}
        if (disp === 'none') return;
      }
      var pad = (disp.indexOf('inline') !== 0 && disp !== 'contents') || tg === 'BR';
      if (pad) s += ' ';
      if (tg === 'SLOT' && typeof c.assignedNodes === 'function') {
        var an = c.assignedNodes({ flatten: true });
        if (an.length) for (var i = 0; i < an.length; i++) visit(an[i]);
        else kids(c);
      } else if (c.shadowRoot) kids(c.shadowRoot);
      else kids(c);
      if (pad) s += ' ';
    }
    function kids(n) { for (var c = n.firstChild; c; c = c.nextSibling) { if (s.length > cap) return; visit(c); } }
    if (root.nodeType === 11) kids(root); else visit(root);
    return clip(s, limit);
  }
  function fullText(el) { return flatText(el, NAME_MAX); }
  // 안쪽 조종 요소의 이름이 비었을 때, 바로 그 shadow 호스트의 aria-label · title · 평평한 글을 빌린다(더 바깥 호스트까지는 올라가지 않는다 — 앱 전체 글이 이름이 되는 것을 막는다).
  function hostName(el) {
    var r = el.getRootNode && el.getRootNode();
    if (!r || !r.host) return '';
    var h = r.host;
    return clip(h.getAttribute('aria-label') || '', NAME_MAX) || clip(h.getAttribute('title') || '', NAME_MAX) || flatText(h, NAME_MAX);
  }

  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r && /^(button|link|tab|checkbox|menuitem)$/.test(r)) return r;
    var t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SUMMARY') return 'summary';
    if (t === 'INPUT') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button';
      if (ty === 'file') return 'file';
      if (ty === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return r || 'generic';
  }

  function labelOf(el) {
    try { if (el.labels && el.labels.length) return clip(el.labels[0].textContent || '', NAME_MAX); } catch (e) {}
    return '';
  }

  function describe(el) {
    var role = roleOf(el), t = el.tagName;
    var isPw = t === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
    var isField = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
    var val = '';
    if (isField && !isPw && role !== 'checkbox' && role !== 'radio') {
      if (t === 'SELECT') { var so = el.selectedOptions && el.selectedOptions[0]; val = so ? so.textContent : ''; }
      else val = el.value || '';
    }
    var name = clip(el.getAttribute('aria-label') || '', NAME_MAX)
      || clip(el.getAttribute('placeholder') || '', NAME_MAX)
      || (isField ? labelOf(el) : '')
      || (isField ? '' : fullText(el))
      || (role === 'button' && !isPw ? clip(el.getAttribute('value') || '', NAME_MAX) : '')
      || clip(el.getAttribute('title') || el.getAttribute('alt') || '', NAME_MAX);
    if (!name) name = hostName(el);
    if (!name && val && !isPw) { name = clip(val, NAME_MAX); val = ''; } // 이름이 없을 때만 값을 이름 자리에
    var line = '- ' + role + ' ' + q(name) + ' [ref=' + refOf(el) + ']';
    if (val && !(role === 'button')) line += ' [value=' + q(clip(val, 40)) + ']';
    if ((role === 'checkbox' || role === 'radio') && el.checked) line += ' [checked]';
    else if (el.getAttribute('aria-checked') === 'true') line += ' [checked]';
    if (el.disabled) line += ' [disabled]';
    return line;
  }

  var sel2 = o.interactive ? INTERACTIVE : INTERACTIVE + ',' + BLOCK;
  var chars = 0, done = false;
  function push(depth, line) {
    line = new Array(depth + 1).join('  ') + line;
    out.push(line);
    chars += line.length + 1;
    if (chars >= SOFT_CHARS) done = true;
  }
  function originOf(f) {
    try { return new URL(f.src || f.getAttribute('src') || '', location.href).origin; } catch (e) { return String(f.getAttribute('src') || ''); }
  }

  // 요소 하나(와 그 아래)를 문서 순서대로 걷는다. 열린 shadow root · 같은 출처 iframe 은 한 단계 들여 이어 걷는다.
  function walkEl(el, depth) {
    if (done) return;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    if (tag === 'IFRAME') {
      if (!shown(el)) return;
      var doc = null;
      try { doc = el.contentDocument; } catch (e) {}
      if (doc && (doc.body || doc.documentElement)) {
        push(depth, '- iframe ' + q(clip(el.getAttribute('title') || doc.title || originOf(el), NAME_MAX)));
        walkEl(doc.body || doc.documentElement, depth + 1);
      } else {
        var fo = originOf(el);
        // 출처가 이 페이지와 다른 게 분명할 때만 「다른 사이트」. sandbox · srcdoc · 같은 출처인데 못 읽는 경우는 따로 알린다.
        if (!el.hasAttribute('sandbox') && !el.hasAttribute('srcdoc') && fo && fo !== 'null' && fo !== location.origin) push(depth, '- iframe ' + q(fo) + ' (다른 사이트라 안쪽은 못 읽음)');
        else push(depth, '- iframe ' + q(el.hasAttribute('srcdoc') ? 'srcdoc' : fo) + ' (안쪽을 읽을 수 없음)');
      }
      return;
    }
    if (el.matches(sel2) && !(tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') && shown(el)) {
      if (isInteractive(el)) push(depth, describe(el));
      else {
        var tx = ownText(el);
        if (tx) push(depth, '- ' + BLOCK_ROLE[tag] + ' ' + q(tx));
      }
    }
    if (done) return;
    if (el.shadowRoot) { walkKids(el.shadowRoot.children, depth + 1); return; }
    if (tag === 'SLOT' && typeof el.assignedNodes === 'function') {
      var an = el.assignedNodes({ flatten: true }), els = [];
      for (var k = 0; k < an.length; k++) if (an[k].nodeType === 1) els.push(an[k]);
      walkKids(els, depth);
      return;
    }
    if (tag.indexOf('-') > 0 && !el.children.length && !(el.textContent || '').trim() && window.customElements && customElements.get(tag.toLowerCase()) && shown(el)) {
      push(depth, '- <' + tag.toLowerCase() + '> (닫힌 shadow root — 안쪽은 못 읽음)');
      return;
    }
    walkKids(el.children, depth);
  }
  function walkKids(kids, depth) {
    // 걷는 동안 목록이 바뀌어도 안전하게 먼저 복사한다.
    var arr = Array.prototype.slice.call(kids);
    for (var i = 0; i < arr.length && !done; i++) walkEl(arr[i], depth);
  }
  walkEl(root, 0);
  return out.join('\n');
}`;
