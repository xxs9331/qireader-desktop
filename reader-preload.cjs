const { ipcRenderer } = require('electron');
let bindings = {};
let screening = false;
ipcRenderer.on('desktop:bindings', (_event, value) => { bindings = value; });
ipcRenderer.on('reader:screening', (_event, value) => { screening = value === true; });

let reportPosition = () => {};
if (process.isMainFrame && !process.argv.includes('--qireader-list')) {
  let enabled = false, restoring = false, retry, reportTimer;
  reportPosition = () => {
    if (enabled && !restoring) ipcRenderer.send('desktop:position-changed', { url: location.href, x: window.scrollX, y: window.scrollY });
  };
  const cancelRestore = event => {
    if (!event.isTrusted) return;
    clearTimeout(retry); restoring = false; reportPosition();
  };
  for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) window.addEventListener(name, cancelRestore, { capture: true, passive: true });
  window.addEventListener('scroll', () => {
    if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = null; reportPosition(); }, 150);
  }, { passive: true });
  window.addEventListener('blur', reportPosition);
  window.addEventListener('pagehide', reportPosition);
  ipcRenderer.on('desktop:restore-position', (_event, value) => {
    enabled = true; clearTimeout(retry);
    if (!value || ![value.x, value.y].every(number => Number.isFinite(number) && number >= 0 && number <= 1e8)) return;
    restoring = true;
    let attempts = 0;
    const apply = () => {
      window.scrollTo({ left: value.x, top: value.y, behavior: 'instant' });
      if (Math.abs(window.scrollY - value.y) < 2 && Math.abs(window.scrollX - value.x) < 2 || ++attempts >= 40) { restoring = false; return; }
      retry = setTimeout(apply, 250);
    };
    apply();
  });
}

if (process.isMainFrame) window.addEventListener('keydown', event => {
  if (screening) return;
  if (!event.isTrusted || event.repeat || event.isComposing || event.composedPath().some(node =>
    node instanceof Element && (node.isContentEditable || node.matches('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[role="dialog"],dialog')))) return;
  const key = event.code === 'Space' || event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const binding = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
  const action = Object.keys(bindings).find(action => bindings[action] && bindings[action] === binding);
  if (!action) return;
  reportPosition();
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('desktop:shortcut', action);
}, true);

// Use rendered QiReader controls; expose no desktop API to the website.
if (process.isMainFrame && process.argv.includes('--qireader-list') && ['https://www.qireader.com', 'https://www.qireader.com.cn'].includes(location.origin)) {
    const removed = new Set();
    const removing = new Set();
    let readyURLs = new Set();
    let failedURLs = new Set();
    let openingSequence = 0;
    let queue = [], cursor = -1, queueRoute = '', opening = false, lastNavigation = '';
    let paginationKey = '', paginationPaused = false, lastPageRequest = 0;
    const adding = new Set();
    let addingQueue = Promise.resolve(), configuredRoute = '';
    const feedRoute = () => /^\/(?:$|(?:feeds|subscriptions|categories)\/[^/]+\/?$)/.test(location.pathname);
    const screenActive = () => screening && feedRoute();
    const waitFor = async check => {
      for (let i = 0; i < 60 && screenActive(); i++) {
        const result = check(); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error('未找到 QiReader 原生控件，请在视图选项中确认杂志、摘要 3 行及滚动已读');
    };
    const menuItem = labels => [...document.querySelectorAll('#portal [tabindex="0"],#portal [role^="menuitem"]')]
      .find(node => labels.includes(node.textContent.trim()) && node.getClientRects().length &&
        (!labels.includes('Read Later') || node.hasAttribute('aria-checked') ||
          node.querySelector('svg.lucide-square,svg.lucide-square-check,svg.lucide-square-check-big,svg rect')));
    function checked(node) {
      const aria = node.getAttribute('aria-checked');
      if (aria !== null) return aria === 'true';
      const icon = node.querySelector('svg');
      if (!icon) throw Error('无法确认 QiReader 控件状态，请手动核对视图选项或稍后阅读状态');
      return Boolean(icon.querySelector('path,polyline,circle+circle'));
    }
    const dismissMenu = node => (node || document.activeElement || document.body)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    async function configureScreening() {
      try {
        const summaryText = node => [...node.childNodes].filter(child => child.nodeName !== 'BUTTON').map(child => child.textContent).join('').trim();
        const open = async () => {
          if (menuItem(['杂志', 'Magazine'])) return;
          const button = await waitFor(() => {
            const direct = [...document.querySelectorAll('button[title="视图选项"],button[title="View Options"]')]
              .find(node => !node.closest('[data-is-entry],[data-focus-container="articleView"]'));
            if (direct) return direct;
            let root = document.querySelector('[data-focus-container="entryList"]');
            for (let i = 0; root && i < 5; i++, root = root.parentElement) {
              const more = [...root.querySelectorAll('button')].find(node => !node.closest('[data-is-entry],[data-focus-container="articleView"]') && node.getClientRects().length &&
                (node.querySelector('svg.lucide-ellipsis,svg.lucide-ellipsis-vertical') || node.querySelectorAll('svg circle').length === 3));
              if (more) return more;
            }
          });
          button.click();
          const item = await waitFor(() => menuItem(['杂志', 'Magazine']) || menuItem(['视图选项', 'View Options']));
          if (!['杂志', 'Magazine'].includes(item.textContent.trim())) item.click();
          await waitFor(() => menuItem(['杂志', 'Magazine']));
        };
        await open();
        const magazine = menuItem(['杂志', 'Magazine']);
        if (!checked(magazine)) { magazine.click(); await new Promise(resolve => setTimeout(resolve, 100)); await open(); }
        const scroll = await waitFor(() => menuItem(['滚动标记为已读', 'Mark As Read on Scroll']));
        if (!checked(scroll)) scroll.click();
        for (let i = 0; i < 10; i++) {
          const row = await waitFor(() => [...document.querySelectorAll('#portal div')].find(node =>
            /^(摘要行数|Summary Lines)\s*\d+$/.test(summaryText(node)) && node.querySelectorAll('button').length === 2));
          const count = Number(summaryText(row).match(/\d+\s*$/)?.[0]);
          if (count === 3) break;
          if (!Number.isInteger(count) || i === 9) throw Error('摘要行数未能设置为 3，请在 QiReader 视图选项中核对');
          row.querySelectorAll('button')[count < 3 ? 1 : 0].click();
          await waitFor(() => Number(summaryText(row).match(/\d+\s*$/)?.[0]) !== count);
        }
        dismissMenu(menuItem(['杂志', 'Magazine']));
        document.documentElement.setAttribute('data-desktop-screening-ready', location.pathname);
      } catch (error) { if (screenActive()) ipcRenderer.send('reader:error', error.message); }
    }
    async function addLater(row, id) {
      if (adding.has(id)) return;
      adding.add(id); row.setAttribute('data-desktop-saving', 'true');
      const route = location.pathname;
      addingQueue = addingQueue.catch(() => {}).then(async () => {
        if (!screenActive() || location.pathname !== route || !row.isConnected || row.getAttribute('data-is-entry') !== id) return;
        const button = row.querySelector('button[title="稍后阅读"],button[title="Read Later"]');
        if (button) {
          const fill = button.querySelector('svg')?.getAttribute('fill');
          if (!fill || fill === 'none') await changeLater(row, id, true, () => button.click());
        } else {
          const bounds = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + 20, clientY: bounds.top + 20 }));
          const item = await waitFor(() => menuItem(['稍后阅读', 'Read Later']));
          if (!screenActive() || location.pathname !== route || !row.isConnected || row.getAttribute('data-is-entry') !== id) return;
          if (!checked(item)) await changeLater(row, id, true, () => item.click());
          else dismissMenu(item);
        }
        if (row.isConnected && row.getAttribute('data-is-entry') === id) row.setAttribute('data-desktop-added', 'true');
      }).catch(error => ipcRenderer.send('reader:error', error.message)).finally(() => {
        adding.delete(id); if (row.getAttribute('data-is-entry') === id) row.removeAttribute('data-desktop-saving');
      });
      await addingQueue;
    }
    function renderedItems() {
      return [...document.querySelectorAll('[data-is-entry]')].map(row => ({
        id: row.getAttribute('data-is-entry'), url: row.querySelector('a[data-is-entry-title][href]')?.href
      })).filter(item => item.id && item.url && /^https?:$/.test(new URL(item.url).protocol));
    }
    function replenish() {
      if (screening) return;
      if (opening || paginationPaused || queueRoute !== location.pathname || cursor < 0 ||
          queue.slice(cursor + 1).filter(item => !failedURLs.has(item.url)).length >= 2) return;
      const root = document.querySelector('[data-focus-container="entryList"]');
      if (!root) return;
      const rows = root.querySelectorAll('[data-is-entry]');
      const tail = rows[rows.length - 1];
      // Reveal virtual rows before requesting another page; never scroll away during removal.
      if (tail) {
        let scroller = tail.parentElement;
        while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        if (scroller && scroller.clientHeight > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
          scroller.scrollTop += Math.max(1, scroller.clientHeight / 2);
          // Offscreen views can defer native scroll events even after scrollTop changes.
          scroller.dispatchEvent(new Event('scroll'));
          return;
        }
      }
      const button = [...root.querySelectorAll('button')].find(node => /^(显示更多|加载更多|Show More)$/i.test(node.textContent.trim()));
      const key = `${queueRoute}\n${queue.at(-1)?.id || ''}`;
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' ||
          !button.getClientRects().length || key === paginationKey || Date.now() - lastPageRequest < 2000) return;
      // One attempt per queue tail: an error or unchanged page must not become a retry loop.
      paginationKey = key;
      lastPageRequest = Date.now();
      button.click();
    }
    function updateNavigation() {
      if (screening) {
        const state = JSON.stringify({ previous: false, next: false, route: location.pathname, current: null, upcoming: [] });
        if (state !== lastNavigation) { lastNavigation = state; ipcRenderer.send('reader:navigation', JSON.parse(state)); }
        return;
      }
      const sameList = queueRoute === location.pathname;
      if (sameList) {
        // Keep removed articles in reading history and append newly rendered rows.
        const ids = new Set(queue.map(item => item.id));
        for (const item of renderedItems()) if (!ids.has(item.id) && !queue.some(entry => entry.restored && entry.url === item.url)) { queue.push(item); ids.add(item.id); }
      }
      const state = {
        previous: sameList && !opening && cursor > 0,
        next: sameList && !opening && cursor >= 0 && queue.slice(cursor + 1).some(item => readyURLs.has(item.url)),
        route: location.pathname, current: sameList ? queue[cursor]?.url : null,
        upcoming: sameList && cursor >= 0 ? queue.slice(cursor + 1).filter(item => !failedURLs.has(item.url)).slice(0, 64).map(item => item.url) : []
      };
      const serialized = JSON.stringify(state);
      if (serialized !== lastNavigation) { lastNavigation = serialized; ipcRenderer.send('reader:navigation', state); }
      replenish();
    }
    const style = document.createElement('style');
    style.textContent = '[data-desktop-selected="true"]{outline:2px solid #8563ba!important;outline-offset:-2px;background-color:rgba(133,99,186,.10)!important}[data-desktop-saving="true"]{opacity:.65}[data-desktop-added="true"]{box-shadow:inset 3px 0 #8563ba}';
    function listItem(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest('[data-is-entry]');
      const title = row?.querySelector('[data-is-entry-title]');
      if (!row || !title || !screening && (!title.href || !/^https?:$/.test(new URL(title.href).protocol))) return;
      if (target.closest('button,input,textarea,select,[contenteditable="true"],[role="button"],[role="checkbox"]')) return;
      const link = target.closest('a');
      if (link && link !== title) return;
      return { row, title };
    }
    // Stop the native tap recognizer before it replaces the narrow list with an article.
    window.addEventListener('pointerdown', event => {
      if (event.button === 0 && listItem(event)) event.stopImmediatePropagation();
    }, true);
    function changeLater(row, id, adding = false, trigger) {
      return new Promise((resolve, reject) => {
        const started = performance.now();
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const parts = new URL(entry.name).pathname.split('/').map(decodeURIComponent);
            if (entry.startTime < started || !['fetch', 'xmlhttprequest'].includes(entry.initiatorType) ||
                !parts.includes('entries') || parts.at(-3) !== id || parts.at(-2) !== 'tags') continue;
            clearTimeout(timer); observer.disconnect();
            if (entry.responseStatus >= 200 && entry.responseStatus < 300) resolve();
            else reject(new Error(`${adding ? '加入' : '移出'}稍后阅读未获服务器确认，请刷新列表核对后重试`));
            return;
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect(); reject(new Error(`${adding ? '加入' : '移出'}稍后阅读超时，请刷新列表核对后重试`));
        }, 15000);
        observer.observe({ type: 'resource' });
        // QiReader's native row shortcut toggles Read Later; only call in that list.
        if (trigger) trigger();
        else row.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', bubbles: true, cancelable: true }));
      });
    }
    async function openItem(item) {
      const { id, url } = item;
      const route = queueRoute;
      const operation = ++openingSequence;
      let completing = false;
      opening = true;
      updateNavigation();
      const row = [...document.querySelectorAll('[data-is-entry]')].find(node => node.getAttribute('data-is-entry') === id);
      document.querySelectorAll('[data-desktop-selected]').forEach(node => node.removeAttribute('data-desktop-selected'));
      row?.setAttribute('data-desktop-selected', 'true');
      row?.focus({ preventScroll: true });
      try {
        const result = await ipcRenderer.invoke('reader:list-article', { route, id, url, trackCompletion: !item.restored && !removed.has(id) && !removing.has(id) });
        if (result?.ok && !item.restored && !removed.has(id) && !removing.has(id) && /^\/tags\/!readlater\/?$/.test(decodeURI(route)) && location.pathname === route) {
          const current = [...document.querySelectorAll('[data-is-entry]')].find(row => row.getAttribute('data-is-entry') === id);
          if (!current) throw new Error('原文已打开，列表条目已离开视图；未自动移除，请返回列表核对');
          removing.add(id); completing = true;
          const confirmation = changeLater(current, id);
          opening = false; updateNavigation();
          await confirmation;
          removed.add(id);
          ipcRenderer.send('reader:completed', id);
        }
      } catch (error) { ipcRenderer.send('reader:error', error.message); }
      finally {
        if (completing) removing.delete(id);
        if (operation === openingSequence) { opening = false; updateNavigation(); }
      }
    }
    function selectFromList(event) {
      if (event.type === 'click' ? event.button !== 0 : !['Enter', 'o'].includes(event.key)) return;
      const item = listItem(event);
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (screening) {
        if (feedRoute()) void addLater(item.row, item.row.getAttribute('data-is-entry'));
        return;
      }
      if (opening) return;
      const id = item.row.getAttribute('data-is-entry');
      queueRoute = location.pathname;
      queue = renderedItems();
      cursor = queue.findIndex(entry => entry.id === id);
      if (cursor < 0) return;
      removed.delete(id);
      void openItem(queue[cursor]);
    }
    ipcRenderer.on('reader:navigate', (_event, direction) => {
      if (screening) return;
      if (opening || ![-1, 1].includes(direction) || queueRoute !== location.pathname) return;
      updateNavigation();
      let index = cursor + direction;
      if (direction === 1) {
        index = queue.findIndex((item, position) => position > cursor && readyURLs.has(item.url));
        if (index > cursor + 1) queue.splice(cursor + 1, 0, queue.splice(index, 1)[0]);
        if (index >= 0) index = cursor + 1;
      }
      if (index < 0 || index >= queue.length) return;
      cursor = index;
      void openItem(queue[cursor]);
    });
    ipcRenderer.on('reader:pool', (_event, state) => {
      readyURLs = new Set(state.ready);
      failedURLs = new Set(state.failed);
      updateNavigation();
    });
    ipcRenderer.on('reader:resume', (_event, url) => {
      if (screening) return;
      if (opening || !/^https?:$/.test(new URL(url).protocol)) return;
      queueRoute = location.pathname;
      queue = [{ id: '__desktop_resume__', url, restored: true }, ...renderedItems().filter(item => item.url !== url)];
      cursor = 0; updateNavigation();
    });
    window.addEventListener('click', selectFromList, true);
    window.addEventListener('keydown', selectFromList, true);
  window.addEventListener('DOMContentLoaded', () => {
    document.head.append(style);
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const url = new URL(entry.name);
        if (url.origin === location.origin && url.pathname.startsWith('/api/streams/') && entry.responseStatus >= 400) paginationPaused = true;
        if (opening || url.origin !== location.origin || entry.responseStatus < 200 || entry.responseStatus >= 300) continue;
        const change = url.pathname.match(/^\/api\/entries\/[^/]+\/([^/]+)\/tags\//);
        if (change && !removing.has(decodeURIComponent(change[1]))) ipcRenderer.send('reader:progress-changed', { id: decodeURIComponent(change[1]) });
        else if (url.pathname === '/api/session') ipcRenderer.send('reader:progress-changed', { session: true });
      }
    }).observe({ type: 'resource' });
    let last = '';
    let timer;
    let previousRoute = location.pathname;
    let previousNode;
    let previousURL;
    let waitingForDOM = false;

    function inspect() {
      document.documentElement.classList.toggle('desktop-screening', screening);
      if (screenActive() && configuredRoute !== location.pathname && document.querySelector('[data-focus-container="entryList"]')) {
        document.documentElement.removeAttribute('data-desktop-screening-ready');
        configuredRoute = location.pathname; addingQueue = addingQueue.catch(() => {}).then(configureScreening);
      }
      updateNavigation();
      if (screening) return;
      const route = location.pathname;
      const root = document.querySelector('[data-focus-container="articleView"]');
      const node = root?.querySelector('[data-article-url]') || root?.querySelector('article h1 a');
      const url = node?.getAttribute('data-article-url') || node?.href;
      if (route !== previousRoute) {
        // SPA routes can change before the previous article's DOM is replaced.
        waitingForDOM = Boolean(node && node === previousNode && url === previousURL);
        previousRoute = route;
      }
      if (node !== previousNode || url !== previousURL) waitingForDOM = false;
      previousNode = node;
      previousURL = url;
      if (!/\/entries\/[^/]+/.test(route) || !root || !url || waitingForDOM) return;
      const key = `${route}\n${url}`;
      if (key === last) return;
      last = key;
      ipcRenderer.send('reader:article', { route, url });
    }

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(inspect, 100);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-article-url', 'href'] });
    // pushState does not emit popstate; the slow poll also catches route-only changes.
    setInterval(inspect, 350);
    inspect();
  }, { once: true });
}
