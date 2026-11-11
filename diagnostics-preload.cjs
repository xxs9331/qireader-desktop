// Isolated-world observer; no desktop API is exposed to websites.
const { ipcRenderer: debugIPC } = require('electron');
(() => {
  const send = (event, details = {}) => debugIPC.send('desktop:diagnostic', { event, ...details });
  for (const name of ['click', 'auxclick', 'contextmenu']) window.addEventListener(name, event => {
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target) return;
    const control = target.closest('button,a,input,textarea,select,[role="button"],[role="menuitem"]') || target;
    const parts = [];
    for (let node = control; node && parts.length < 4; node = node.parentElement) {
      parts.unshift(`${node.tagName.toLowerCase()}:${Array.prototype.indexOf.call(node.parentElement?.children || [], node) + 1}`);
    }
    send(name === 'click' ? 'click' : name === 'auxclick' ? 'aux-click' : 'context-menu', { target: parts.join('/'), button: event.button, editable: Boolean(control.matches('input,textarea,select') || control.closest('[contenteditable]')),
      trusted: event.isTrusted, control: location.protocol === 'file:' ? control.id : undefined, destination: control.closest('a')?.href });
  }, true);
  window.addEventListener('error', event => send(event.target instanceof Element ? 'resource-error' : 'script-error', {
    destination: event.target instanceof Element ? event.target.src || event.target.href : event.filename,
    line: Number.isInteger(event.lineno) ? event.lineno : undefined
  }), true);
  window.addEventListener('unhandledrejection', () => send('script-rejection'));
  window.addEventListener('pagehide', () => send('page-hidden'));
  document.addEventListener('visibilitychange', () => send(document.hidden ? 'page-background' : 'page-visible'));
  window.addEventListener('DOMContentLoaded', () => {
    send('page-dom-ready');
    let previous = '', timer;
    function inspect() {
      const body = document.body?.innerText || '';
      const text = document.title + '\n' + body.slice(0, 12000);
      const challenge = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],input[name*="captcha"],#captcha')]
        .some(node => {
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          return rect.width >= 16 && rect.height >= 16 && style.visibility !== 'hidden' && style.opacity !== '0';
        });
      if (process.isMainFrame) send('document-status', { length: body.length, challenge });
      // shortcut: article text may match; signals are clues, not load verdicts.
      const signal = /验证码|安全验证|人机验证|访问验证|captcha|verify you are human|checking your browser/i.test(text) ? 'challenge-suspected' :
        /网页无法打开|无法访问此网站|access denied|ERR_CONNECTION|ERR_PROXY|ERR_NAME_NOT_RESOLVED/i.test(text) ? 'error-suspected' :
          !document.body?.innerText.trim() ? 'empty-body' : 'body-present';
      if (signal !== previous) { previous = signal; send('page-signal', { signal }); }
    }
    inspect();
    new MutationObserver(() => {
      if (!timer) timer = setTimeout(() => { timer = null; inspect(); }, 1000);
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }, { once: true });
})();
