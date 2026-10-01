// pi-proto runtime: loaded into every rendered prototype. It makes the
// prototype behave (pages, links, show/hide, back) and lets the storybook
// around it swap one node in place, pick an element, and highlight one.
// Plain JS, no dependencies: it runs in any browser, inside or outside the
// storybook.

(function () {
  'use strict';

  var framed = window.self !== window.top;
  var trail = [];

  function tellParent(message) {
    if (!framed) return;
    message.source = 'pi-proto';
    window.parent.postMessage(message, '*');
  }

  // -------- pages --------
  // Every [data-screen][id] is a page; the one named by the URL hash shows
  // (the first by default). data-goto / href="#page" move between them.
  function pages() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-screen][id]'));
  }
  function current() {
    var all = pages();
    var wanted = decodeURIComponent(location.hash.slice(1));
    return all.filter(function (el) { return el.id === wanted; })[0] || all[0];
  }
  function showPage() {
    var all = pages();
    if (!all.length) return;
    var target = current();
    all.forEach(function (el) { el.hidden = el !== target; });
    tellParent({ type: 'screen', id: target.id });
  }
  function go(id) {
    var from = current();
    if (from && from.id !== id) trail.push(from.id);
    location.hash = id;
    window.scrollTo(0, 0);
  }

  // -------- clicks: go, toggle, back --------
  document.addEventListener('click', function (event) {
    if (picking) return;
    var el = event.target instanceof Element ? event.target.closest('[data-goto],[data-toggle],[data-back]') : null;
    if (!el) return;
    event.preventDefault();
    if (el.hasAttribute('data-back')) {
      var previous = trail.pop();
      if (previous) location.hash = previous; else history.back();
      return;
    }
    if (el.hasAttribute('data-toggle')) {
      var shown = document.getElementById(el.getAttribute('data-toggle'));
      if (shown) shown.hidden = !shown.hidden;
      return;
    }
    go(el.getAttribute('data-goto'));
  }, true);

  window.addEventListener('hashchange', showPage);

  // -------- editing from the storybook --------
  var picking = false;
  var box = null;

  function outline() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-proto-ui', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4f46e5;background:rgba(79,70,229,.08);border-radius:4px;transition:all 60ms ease;display:none';
    var tag = document.createElement('span');
    tag.style.cssText = 'position:absolute;left:-2px;top:-22px;background:#4f46e5;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap';
    box.appendChild(tag);
    document.documentElement.appendChild(box);
    return box;
  }
  function nodeAt(target) {
    return target instanceof Element ? target.closest('[data-node]:not([data-screen])') || target.closest('[data-node]') : null;
  }
  function frame(el, label) {
    var b = outline();
    if (!el) { b.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left - 2 + 'px';
    b.style.top = r.top - 2 + 'px';
    b.style.width = r.width + 4 + 'px';
    b.style.height = r.height + 4 + 'px';
    b.firstChild.textContent = label || el.getAttribute('data-node');
  }
  function labelOf(el) {
    var text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 60);
  }
  function onMove(event) { frame(nodeAt(event.target)); }
  function onPick(event) {
    var el = nodeAt(event.target);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    var page = el.closest('[data-screen]');
    tellParent({
      type: 'picked',
      node: el.getAttribute('data-node'),
      page: page ? page.id : '',
      label: labelOf(el),
      tag: el.tagName.toLowerCase(),
      isPage: el.hasAttribute('data-screen'),
      action: el.getAttribute('data-goto') ? { go: el.getAttribute('data-goto') } : el.getAttribute('data-toggle') ? { toggle: el.getAttribute('data-toggle') } : el.hasAttribute('data-back') ? { back: true } : null,
    });
  }
  function onKey(event) { if (event.key === 'Escape') tellParent({ type: 'pick-cancel' }); }
  function setPicking(on) {
    if (picking === on) return;
    picking = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (on) {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onPick, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onPick, true);
      document.removeEventListener('keydown', onKey, true);
      frame(null);
    }
  }

  function flash(id) {
    var el = document.querySelector('[data-node="' + id + '"]');
    if (!el) return;
    var page = el.closest('[data-screen]');
    if (page && page.hidden) { location.hash = page.id; }
    setTimeout(function () {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      frame(el);
      setTimeout(function () { if (!picking) frame(null); }, 1400);
    }, 60);
  }

  // One node (or page) swapped in place: the rest of the page, its scroll and
  // what is open stay as they are.
  function patch(items, css) {
    (items || []).forEach(function (item) {
      var el = document.querySelector('[data-node="' + item.id + '"]');
      if (!el) return;
      var wasHidden = el.hidden;
      var holder = document.createElement('template');
      holder.innerHTML = item.html;
      var next = holder.content.firstElementChild;
      if (!next) return;
      if (el.hasAttribute('data-screen')) next.hidden = wasHidden;
      el.replaceWith(next);
    });
    if (css) {
      var link = document.querySelector('link[rel="stylesheet"][href*="main.css"]');
      if (link) link.href = link.href.replace(/\?.*$/, '') + '?v=' + Date.now();
    }
  }

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.source !== 'pi-proto-storybook') return;
    if (msg.type === 'pick') setPicking(!!msg.on);
    if (msg.type === 'patch') patch(msg.patches, msg.css);
    if (msg.type === 'go') go(msg.page);
    if (msg.type === 'flash') flash(msg.node);
  });

  function start() {
    showPage();
    tellParent({ type: 'ready' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
