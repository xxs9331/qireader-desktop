(() => {
  'use strict';
  if (window !== window.top || window.qiFilter) return;
  const bridge = window.qireaderMobile;
  if (!bridge) return;
  let sequence = 0, user = '', route = '', queue = Promise.resolve(), epoch = 0;
  let state = { blocked: true }, refreshing = null, configured = '', nativeAction = false;
  const pending = new Map(), adding = new Set();
  const feedRoute = () => /^\/(?:$|(?:feeds|subscriptions|categories)\/[^/]+\/?$)/.test(location.pathname);
  const send = (action, value = {}) => new Promise((resolve, reject) => {
    const request = ++sequence;
    const timer = setTimeout(() => { pending.delete(request); reject(Error('应用响应超时，请重新打开')); }, 10000);
    pending.set(request, { resolve, reject, timer });
    bridge.postMessage(JSON.stringify({ request, action, ...value }));
  });
  const update = value => { state = value; renderLamps(); };
  bridge.onmessage = event => {
    try {
      const result = JSON.parse(event.data), item = pending.get(result.request);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(result.request);
      if (result.state) update(result.state);
      if (result.ok) item.resolve(result.state); else item.reject(Error(result.error || '操作失败'));
    } catch { /* A malformed message must not acknowledge an addition. */ }
  };
  const report = message => { void send('error', { message }).catch(() => {}); };
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const response = await fetch('/api/session/user', { credentials: 'same-origin', cache: 'no-store' });
      const body = response.ok ? await response.json() : null;
      const next = typeof body?.result?.id === 'string' && body.result.id.length <= 512 ? body.result.id : '';
      if (user !== next) { user = next; epoch++; }
      await send('ready', { user });
      return user;
    })().catch(async error => {
      user = ''; epoch++; state = { blocked: true };
      await send('ready', { user: '' }).catch(() => {});
      throw error;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  window.qiFilter = { update, refresh: () => refresh().catch(() => {}) };
  const waitFor = async check => {
    for (let i = 0; i < 60 && feedRoute(); i++) {
      const value = check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('未找到稍后阅读控件，请刷新后重试');
  };
  const menuItem = labels => [...document.querySelectorAll('#portal [tabindex="0"],#portal [role^="menuitem"]')]
    .find(node => labels.includes(node.textContent.trim()) && node.getClientRects().length &&
      (!labels.includes('Read Later') || node.hasAttribute('aria-checked') ||
        node.querySelector('svg.lucide-square,svg.lucide-square-check,svg.lucide-square-check-big,svg rect')));
  function checked(node) {
    const aria = node.getAttribute('aria-checked');
    if (aria !== null) return aria === 'true';
    const icon = node.querySelector('svg');
    if (!icon) throw Error('无法确认稍后阅读状态，请刷新后重试');
    return Boolean(icon.querySelector('path,polyline,circle+circle'));
  }
  const dismiss = node => (node || document.activeElement || document.body)
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  let controls, currentNav;
  function renderLamps() {
    if (!controls) return;
    const lamps = controls.querySelector('[role="progressbar"]');
    const target = Number.isInteger(state.target) ? state.target : 5;
    const count = Number.isInteger(state.count) ? state.count : 0;
    if (lamps.children.length !== target) lamps.replaceChildren(...Array.from({ length: target }, () => {
      const lamp = document.createElement('span'); lamp.setAttribute('aria-hidden', 'true'); return lamp;
    }));
    for (const [index, lamp] of [...lamps.children].entries()) lamp.classList.toggle('lit', index < count);
    lamps.setAttribute('aria-valuemin', '0'); lamps.setAttribute('aria-valuemax', target); lamps.setAttribute('aria-valuenow', Math.min(count, target));
    lamps.setAttribute('aria-label', `本轮已添加 ${count} / ${target} 篇`);
  }
  function mergeNavigation() {
    if (!controls) {
      controls = document.createElement('div'); controls.id = 'qi-filter-controls';
      const lamps = document.createElement('div'); lamps.id = 'qi-filter-lamps'; lamps.setAttribute('role', 'progressbar');
      const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = '⚙'; settings.setAttribute('aria-label', '设置'); settings.title = '设置';
      settings.addEventListener('click', () => { void send('settings').catch(error => report(error.message)); });
      controls.append(lamps, settings); renderLamps();
    }
    const cachedBounds = currentNav?.getBoundingClientRect();
    const cachedVisible = currentNav?.isConnected && currentNav.getClientRects().length && cachedBounds.right > 0 && cachedBounds.left < innerWidth && getComputedStyle(currentNav).visibility !== 'hidden';
    const nav = cachedVisible ? currentNav : [...document.querySelectorAll('nav')].find(node => {
      if (node.id === 'qi-filter-fallback' || node.closest('aside,#portal,[data-is-entry],[data-focus-container="sidebar"]')) return false;
      const bounds = node.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.height > 100 || bounds.top < 0 || bounds.top >= 100 || bounds.left < 0 || bounds.right > innerWidth + 1) return false;
      return node.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
    });
    const fallback = document.getElementById('qi-filter-fallback');
    if (nav) {
      if (nav !== currentNav) {
        currentNav?.removeAttribute('data-qi-filter-nav'); currentNav?.removeAttribute('data-qi-filter-static');
        currentNav = nav; nav.setAttribute('data-qi-filter-nav', 'true');
        if (getComputedStyle(nav).position === 'static') nav.setAttribute('data-qi-filter-static', 'true');
      }
      if (controls.parentElement !== nav) nav.append(controls);
      fallback?.remove();
      if (document.documentElement.classList.contains('qi-filter-fallback')) document.documentElement.classList.remove('qi-filter-fallback');
    } else if (!fallback) {
      const bar = document.createElement('nav'); bar.id = 'qi-filter-fallback'; bar.append(controls);
      document.body.prepend(bar); document.documentElement.classList.add('qi-filter-fallback');
    }
  }
  async function magazine() {
    const button = [...document.querySelectorAll('button[title="视图选项"],button[title="View Options"]')]
      .find(node => !node.closest('[data-is-entry]'));
    let options = button;
    if (!options) {
      let root = document.querySelector('[data-focus-container="entryList"]');
      for (let i = 0; root && i < 5 && !options; i++, root = root.parentElement) options = [...root.querySelectorAll('button')]
        .find(node => !node.closest('[data-is-entry]') && node.getClientRects().length &&
          (node.querySelector('svg.lucide-ellipsis,svg.lucide-ellipsis-vertical') || node.querySelectorAll('svg circle').length === 3));
    }
    if (!options) return;
    options.click();
    let item = await waitFor(() => menuItem(['杂志', 'Magazine']) || menuItem(['视图选项', 'View Options']));
    if (!['杂志', 'Magazine'].includes(item.textContent.trim())) { item.click(); item = await waitFor(() => menuItem(['杂志', 'Magazine'])); }
    if (!checked(item)) item.click();
    dismiss(item);
  }
  function confirmAdd(id, trigger) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const url = new URL(entry.name), parts = url.pathname.split('/').map(decodeURIComponent);
          if (url.origin !== location.origin || entry.startTime < started || !['fetch', 'xmlhttprequest'].includes(entry.initiatorType) ||
              !parts.includes('entries') || parts.at(-3) !== id || parts.at(-2) !== 'tags') continue;
          clearTimeout(timer); observer.disconnect();
          if (entry.responseStatus >= 200 && entry.responseStatus < 300) resolve();
          else reject(Error('加入稍后阅读未获服务器确认，请刷新核对后重试'));
          return;
        }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(Error('添加超时，请刷新核对后重试')); }, 15000);
      observer.observe({ type: 'resource' });
      try { nativeAction = true; trigger(); } catch (error) { clearTimeout(timer); observer.disconnect(); reject(error); }
      finally { nativeAction = false; }
    });
  }
  function add(row) {
    const id = row.getAttribute('data-is-entry');
    if (!id || id.length > 512 || state.blocked || adding.has(id)) return;
    const capturedUser = user, capturedRoute = location.pathname, capturedEpoch = epoch;
    if (!capturedUser) { report('请先登录 QiReader'); return; }
    adding.add(id); row.setAttribute('data-filter-saving', 'true');
    let hiddenMenu = false;
    queue = queue.catch(() => {}).then(async () => {
      const active = () => !state.blocked && user === capturedUser && epoch === capturedEpoch && location.pathname === capturedRoute && feedRoute() &&
        row.isConnected && row.getAttribute('data-is-entry') === id;
      if (!active()) return;
      await refresh(); if (!active()) return;
      if (row.hasAttribute('data-filter-added')) return;
      const button = row.querySelector('button[title="稍后阅读"],button[title="Read Later"]');
      let trigger;
      if (button) {
        const icon = button.querySelector('svg');
        const pressed = button.getAttribute('aria-pressed');
        if (pressed === 'true' || icon?.getAttribute('fill') && icon.getAttribute('fill') !== 'none') return;
        if (pressed !== 'false' && !icon?.hasAttribute('fill')) throw Error('无法确认稍后阅读状态，请刷新核对');
        trigger = () => button.click();
      } else {
        // Preserve native state checks without ever displaying the automatic context menu.
        document.documentElement.classList.add('qi-filter-native-menu'); hiddenMenu = true;
        const bounds = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + 20, clientY: bounds.top + 20 }));
        const item = await waitFor(() => menuItem(['稍后阅读', 'Read Later']));
        if (!active()) { dismiss(item); return; }
        if (checked(item)) { dismiss(item); return; }
        trigger = () => item.click();
      }
      await confirmAdd(id, trigger);
      if (user !== capturedUser || epoch !== capturedEpoch) throw Error('账号已切换，请刷新核对添加结果');
      await send('saved', { user: capturedUser, id });
      if (row.isConnected && row.getAttribute('data-is-entry') === id) row.setAttribute('data-filter-added', 'true');
    }).catch(error => report(error.message)).finally(async () => {
      if (hiddenMenu) {
        dismiss(menuItem(['稍后阅读', 'Read Later']));
        await new Promise(resolve => requestAnimationFrame(() => {
          for (const animation of document.getElementById('portal')?.getAnimations({ subtree: true }) || []) {
            try { animation.finish(); } catch { /* Infinite loading animations cannot be finished. */ }
          }
          requestAnimationFrame(() => { document.documentElement.classList.remove('qi-filter-native-menu'); resolve(); });
        }));
      }
      adding.delete(id); if (row.getAttribute('data-is-entry') === id) row.removeAttribute('data-filter-saving');
    });
  }
  const entry = event => event.target instanceof Element ? event.target.closest('[data-is-entry]') : null;
  window.addEventListener('contextmenu', event => {
    if (event.isTrusted && feedRoute() && entry(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('pointerdown', event => { if (feedRoute() && entry(event)) event.stopImmediatePropagation(); }, true);
  window.addEventListener('click', event => {
    if (nativeAction) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && /\/(?:entries|tags)\//.test(new URL(link.href, location.href).pathname)) {
      if (!entry(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    }
    if (!feedRoute()) return;
    const row = entry(event);
    if (!row) return;
    event.preventDefault(); event.stopImmediatePropagation();
    add(row);
  }, true);
  let timer;
  function routeChanged() {
    const current = location.pathname;
    if (/\/(?:entries|tags)\//.test(current)) { location.replace('/'); return; }
    const filtering = feedRoute();
    if (document.documentElement.classList.contains('qi-filter-mode') !== filtering) document.documentElement.classList.toggle('qi-filter-mode', filtering);
    mergeNavigation();
    if (current !== route) {
      route = current; epoch++; configured = '';
      void refresh().catch(() => {});
    }
    if (feedRoute() && configured !== current && document.querySelector('[data-is-entry]')) {
      configured = current; void magazine().catch(error => report(error.message));
    }
  }
  function start() {
    const style = document.createElement('style');
    style.textContent = `[data-focus-container="articleView"],html.qi-filter-mode [data-is-entry] button,a[href^="/tags/!readlater"],a[href^="/tags/!starred"]{display:none!important}
      [data-filter-saving="true"]{opacity:.5}[data-filter-added="true"]{box-shadow:inset 2px 0 #888}
      html.qi-filter-mode [data-is-entry]{cursor:pointer;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;user-select:none}
      html.qi-filter-native-menu #portal,html.qi-filter-native-menu #portal *{visibility:hidden!important;pointer-events:none!important}
      [data-qi-filter-nav]{padding-right:110px!important;box-sizing:border-box!important}
      [data-qi-filter-static]{position:relative!important}
      #qi-filter-controls{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:flex-end;gap:6px;width:100px;max-width:calc(100vw - 16px)}
      #qi-filter-controls button{display:block!important;flex:0 0 28px;box-sizing:border-box;width:28px;margin:0;border:0;background:transparent;color:inherit;padding:4px;font:20px sans-serif;-webkit-tap-highlight-color:transparent}
      #qi-filter-lamps{display:flex;gap:4px;max-width:64px;overflow-x:auto;scrollbar-width:none;padding:4px 0}
      #qi-filter-lamps span{display:block;width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:#888}
      #qi-filter-lamps span.lit{background:#5b947e}
      #qi-filter-fallback{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;background:Canvas;color:CanvasText;z-index:100}
      html.qi-filter-fallback body{padding-top:44px}`;
    document.head.append(style);
    const schedule = () => { clearTimeout(timer); timer = setTimeout(routeChanged, 80); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('popstate', routeChanged);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh().catch(() => {}); });
    routeChanged();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
