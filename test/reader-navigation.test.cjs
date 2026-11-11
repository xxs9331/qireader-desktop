const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(ids) {
  const listeners = {}, events = {}, messages = [];
  let moreClicks = 0, inspect;
  const url = id => `https://example.test/${id}`;
  const rows = ['current', ...ids].map(id => ({
    getAttribute: () => id, querySelector: () => ({ href: url(id) }), parentElement: null
  }));
  const more = { textContent: '显示更多', getAttribute: () => null,
    getClientRects: () => [{}], click: () => moreClicks++ };
  const root = { querySelectorAll: selector => selector === 'button' ? [more] : rows };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'reader-preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer: {
      on: (name, fn) => { listeners[name] = fn; }, send: (...args) => messages.push(args)
    } }),
    process: { isMainFrame: true, argv: ['--qireader-list'] },
    location: { origin: 'https://www.qireader.com', pathname: '/feeds/test' },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    document: {
      createElement: () => ({}), head: { append() {} }, documentElement: { classList: { toggle() {} } },
      querySelectorAll: () => rows, querySelector: selector => selector.includes('entryList') ? root : null
    },
    PerformanceObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    setInterval: fn => { inspect = fn; }, URL, Element: class {}
  });
  events.DOMContentLoaded();
  listeners['reader:resume']({}, url('current'));
  return {
    pool: (failed, ready = []) => listeners['reader:pool']({}, { failed: failed.map(url), ready: ['current', ...ready].map(url) }),
    inspect: () => inspect(), clicks: () => moreClicks,
    state: () => messages.filter(([name]) => name === 'reader:navigation').at(-1)[1], url
  };
}

test('failed successors no longer block native pagination or repeatedly request the same tail', () => {
  const f = fixture(['blocked-a', 'blocked-b', 'blocked-c']);
  f.pool([]);
  assert.equal(f.clicks(), 0, 'Untried articles must still count toward the buffer');
  f.pool(['blocked-a']);
  assert.equal(f.clicks(), 0, 'Two untried articles must not request another page');
  f.pool(['blocked-a', 'blocked-b', 'blocked-c']);
  assert.equal(f.state().next, false, 'Failed pages cannot be opened as ready articles');
  assert.equal(f.clicks(), 1, 'An available native page must be requested past failed articles');
  for (let i = 0; i < 4; i++) f.inspect();
  assert.equal(f.clicks(), 1, 'An unchanged page must not cause a retry loop');
});

test('failed articles cannot consume the 64-candidate preparation window', () => {
  const failed = Array.from({ length: 65 }, (_, i) => `blocked-${i}`);
  const f = fixture([...failed, 'reachable-a', 'reachable-b']);
  f.pool(failed);
  assert.deepEqual(Array.from(f.state().upcoming), ['reachable-a', 'reachable-b'].map(f.url));
  assert.equal(f.clicks(), 0, 'Two later candidates must prepare before requesting another page');
  f.pool(failed, ['reachable-a']);
  assert.equal(f.state().next, true);
});
