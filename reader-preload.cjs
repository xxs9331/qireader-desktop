const { ipcRenderer } = require('electron');

// Use rendered QiReader controls; expose no desktop API to the website.
if (process.isMainFrame && ['https://www.qireader.com', 'https://www.qireader.com.cn'].includes(location.origin)) {
    const removed = new Set();
    let queue = [], cursor = -1, queueRoute = '', opening = false, lastNavigation = '';
    function renderedItems() {
      // shortcut: navigation follows rendered rows; load more in the list for distant items.
      return [...document.querySelectorAll('[data-is-entry]')].map(row => ({
        id: row.getAttribute('data-is-entry'), url: row.querySelector('a[data-is-entry-title][href]')?.href
      })).filter(item => item.id && item.url && /^https?:$/.test(new URL(item.url).protocol));
    }
    function updateNavigation() {
      const sameList = queueRoute === location.pathname;
      if (sameList) {
        // Keep removed articles in reading history and append newly rendered rows.
        const ids = new Set(queue.map(item => item.id));
        for (const item of renderedItems()) if (!ids.has(item.id)) { queue.push(item); ids.add(item.id); }
      }
      const state = { previous: sameList && !opening && cursor > 0, next: sameList && !opening && cursor >= 0 && cursor + 1 < queue.length };
      const serialized = JSON.stringify(state);
      if (serialized !== lastNavigation) { lastNavigation = serialized; ipcRenderer.send('reader:navigation', state); }
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
      opening = true;
      updateNavigation();
      const row = [...document.querySelectorAll('[data-is-entry]')].find(node => node.getAttribute('data-is-entry') === id);
      document.querySelectorAll('[data-desktop-selected]').forEach(node => node.removeAttribute('data-desktop-selected'));
      row?.setAttribute('data-desktop-selected', 'true');
      row?.focus({ preventScroll: true });
      try {
        const result = await ipcRenderer.invoke('reader:list-article', { route, id, url, trackCompletion: !removed.has(id) });
        if (result?.ok && !removed.has(id) && /^\/tags\/!readlater\/?$/.test(decodeURI(route)) && location.pathname === route) {
          const current = [...document.querySelectorAll('[data-is-entry]')].find(row => row.getAttribute('data-is-entry') === id);
          if (!current) throw new Error('原文已打开，列表条目已离开视图；未自动移除，请返回列表核对');
          await removeLater(current, id);
          removed.add(id);
          ipcRenderer.send('reader:completed', id);
        }
      } catch (error) { ipcRenderer.send('reader:error', error.message); }
      finally { opening = false; updateNavigation(); }
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
      const index = cursor + direction;
      if (index < 0 || index >= queue.length) return;
      cursor = index;
      void openItem(queue[cursor]);
    });
    window.addEventListener('click', selectFromList, true);
    window.addEventListener('keydown', selectFromList, true);
  window.addEventListener('DOMContentLoaded', () => {
    document.head.append(style);
    new PerformanceObserver(list => {
      if (opening) return;
      if (list.getEntries().some(entry => {
        const url = new URL(entry.name);
        return url.origin === location.origin && entry.responseStatus >= 200 && entry.responseStatus < 300 &&
          (/^\/api\/entries\/.*\/tags\//.test(url.pathname) || url.pathname === '/api/session');
      })) ipcRenderer.send('reader:progress-changed');
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
