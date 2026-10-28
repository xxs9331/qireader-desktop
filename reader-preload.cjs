const { ipcRenderer } = require('electron');
let bindings = {};
ipcRenderer.on('desktop:bindings', (_event, value) => { bindings = value; });

if (process.isMainFrame) window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.repeat || event.isComposing || event.composedPath().some(node =>
    node instanceof Element && (node.isContentEditable || node.matches('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[role="dialog"],dialog')))) return;
  const key = event.code === 'Space' || event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const binding = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
  const action = Object.keys(bindings).find(action => bindings[action] && bindings[action] === binding);
  if (!action) return;
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('desktop:shortcut', action);
}, true);

// Use rendered QiReader controls; expose no desktop API to the website.
if (process.isMainFrame && process.argv.includes('--qireader-list') && ['https://www.qireader.com', 'https://www.qireader.com.cn'].includes(location.origin)) {
    const removed = new Set();
    const removing = new Set();
    let readyURLs = new Set();
    let openingSequence = 0;
    let queue = [], cursor = -1, queueRoute = '', opening = false, lastNavigation = '';
    let paginationKey = '', paginationPaused = false, lastPageRequest = 0;
    function renderedItems() {
      return [...document.querySelectorAll('[data-is-entry]')].map(row => ({
        id: row.getAttribute('data-is-entry'), url: row.querySelector('a[data-is-entry-title][href]')?.href
      })).filter(item => item.id && item.url && /^https?:$/.test(new URL(item.url).protocol));
    }
    function replenish() {
      if (opening || paginationPaused || queueRoute !== location.pathname || cursor < 0 || queue.length - cursor - 1 >= 2) return;
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
      const sameList = queueRoute === location.pathname;
      if (sameList) {
        // Keep removed articles in reading history and append newly rendered rows.
        const ids = new Set(queue.map(item => item.id));
        for (const item of renderedItems()) if (!ids.has(item.id)) { queue.push(item); ids.add(item.id); }
      }
      const state = {
        previous: sameList && !opening && cursor > 0,
        next: sameList && !opening && cursor >= 0 && queue.slice(cursor + 1).some(item => readyURLs.has(item.url)),
        route: location.pathname, current: sameList ? queue[cursor]?.url : null,
        upcoming: sameList && cursor >= 0 ? queue.slice(cursor + 1, cursor + 65).map(item => item.url) : []
      };
      const serialized = JSON.stringify(state);
      if (serialized !== lastNavigation) { lastNavigation = serialized; ipcRenderer.send('reader:navigation', state); }
      replenish();
    }
    const style = document.createElement('style');
    style.textContent = '[data-desktop-selected="true"]{outline:2px solid #8563ba!important;outline-offset:-2px;background-color:rgba(133,99,186,.10)!important}';
    function listItem(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest('[data-is-entry]');
      const title = row?.querySelector('a[data-is-entry-title][href]');
      if (!row || !title || !/^https?:$/.test(new URL(title.href).protocol)) return;
      if (target.closest('button,input,textarea,select,[contenteditable="true"],[role="button"],[role="checkbox"]')) return;
      const link = target.closest('a');
      if (link && link !== title) return;
      return { row, title };
    }
    // Stop the native tap recognizer before it replaces the narrow list with an article.
    window.addEventListener('pointerdown', event => {
      if (event.button === 0 && listItem(event)) event.stopImmediatePropagation();
    }, true);
    function removeLater(row, id) {
      return new Promise((resolve, reject) => {
        const started = performance.now();
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const parts = new URL(entry.name).pathname.split('/').map(decodeURIComponent);
            if (entry.startTime < started || !['fetch', 'xmlhttprequest'].includes(entry.initiatorType) ||
                !parts.includes('entries') || parts.at(-3) !== id || parts.at(-2) !== 'tags') continue;
            clearTimeout(timer); observer.disconnect();
            if (entry.responseStatus >= 200 && entry.responseStatus < 300) resolve();
            else reject(new Error('移出稍后阅读未获服务器确认，请刷新列表核对后重试'));
            return;
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect(); reject(new Error('移出稍后阅读超时，请刷新列表核对后重试'));
        }, 15000);
        observer.observe({ type: 'resource' });
        // QiReader's native row shortcut toggles Read Later; only call in that list.
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', bubbles: true, cancelable: true }));
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
        const result = await ipcRenderer.invoke('reader:list-article', { route, id, url, trackCompletion: !removed.has(id) && !removing.has(id) });
        if (result?.ok && !removed.has(id) && !removing.has(id) && /^\/tags\/!readlater\/?$/.test(decodeURI(route)) && location.pathname === route) {
          const current = [...document.querySelectorAll('[data-is-entry]')].find(row => row.getAttribute('data-is-entry') === id);
          if (!current) throw new Error('原文已打开，列表条目已离开视图；未自动移除，请返回列表核对');
          removing.add(id); completing = true;
          const confirmation = removeLater(current, id);
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
      updateNavigation();
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
      updateNavigation();
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
