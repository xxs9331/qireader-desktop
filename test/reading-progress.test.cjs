const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadingProgress, boundaries } = require('../reading-progress.cjs');
const origin = 'https://www.qireader.com';
const now = +new Date(2026, 9, 28, 12);
const today = boundaries(now).today;
const row = (id, crawledAt = today + 1000) => ({ id, crawledAt, status: 1, tagIds: ['later'], timestamp: '9007199254740993999' });

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-progress-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = { user: 'alice', entries: [], status: 200, pages: null, hook: null, calls: [], retryAfter: null };
  const options = {
    file: path.join(directory, 'progress.json'), now: () => now,
    fetch: async (address, options) => {
      const url = new URL(address);
      server.calls.push(url.pathname);
      assert.equal(url.origin, origin); assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-api-version'], '21.0.0');
      if (server.hook) await server.hook(url);
      if (server.status !== 200) return new Response('{}', { status: server.status, headers: server.retryAfter ? { 'retry-after': server.retryAfter } : {} });
      let result;
      if (url.pathname === '/api/session/user') result = { id: server.user };
      else if (url.pathname === '/api/tags') result = { tags: [{ id: 'later', label: '!readlater' }] };
      else if (url.pathname.startsWith('/api/entry/')) result = server.entries.find(entry => entry.id === decodeURIComponent(url.pathname.split('/').at(-1)));
      else {
        assert.equal(url.pathname, '/api/streams/tag-later');
        assert.equal(url.searchParams.get('unreadOnly'), 'false');
        result = server.pages ? server.pages(url.searchParams.get('olderThan')) : { entries: server.entries, hasMore: false };
      }
      return Response.json({ result });
    }
  };
  return { server, options, store: new ReadingProgress(options) };
}

test('daily goal defaults to 100; automatic week follows its saved cohort; server read flag is not completion', async t => {
  const { server, store } = setup(t);
  server.entries = [row('today'), row('monday', boundaries(now).week + 1000), row('older', boundaries(now).week - 1000), row('future', boundaries(now).tomorrow + 1000)];
  await store.refresh(origin);
  assert.equal(store.summary().total, 100);
  assert.equal(store.summary().automatic, false);
  assert.equal(store.summary('all').total, 4);
  assert.equal(store.summary('all').done, 0);
  assert.equal(store.summary('all').older, 0);
  assert.equal(store.summary('week').total, 2);
  assert.equal(store.summary('week').older, 1);
});

test('confirmed completion persists across restarts, retains denominator, and supports re-add', async t => {
  const { server, store, options } = setup(t);
  server.entries = [row('a'), row('b')];
  await store.refresh(origin);
  const token = await store.track(origin, 'a');
  store.complete(token); store.complete(token);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').done, 1);
  server.entries = [row('b')];
  const reopened = new ReadingProgress(options);
  assert.equal(reopened.summary('all').ready, false); // Verify the logged-in account before revealing stored counts.
  await reopened.refresh(origin);
  assert.equal(reopened.summary('all').total, 2); assert.equal(reopened.summary('all').done, 1);
  server.entries.push(row('a'));
  await reopened.refresh(origin);
  assert.equal(reopened.summary('all').total, 2); assert.equal(reopened.summary('all').done, 0);
});

test('full snapshot detects another device removing an article without losing total', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a'), row('b')]; await store.refresh(origin);
  server.entries = [row('b')]; await store.refresh(origin);
  assert.equal(store.summary('all').remaining, 1); assert.equal(store.summary('all').total, 2);
  server.entries.push(row('c')); await store.refresh(origin);
  assert.equal(store.summary('all').total, 3); assert.equal(store.summary('all').done, 1);
});

test('opaque cursor deduplication and all-page completion; partial failures preserve last counts', async t => {
  const { server, store } = setup(t);
  server.pages = cursor => cursor === null ? { entries: [row('a')], hasMore: true } :
    { entries: [row('a'), row('b')], hasMore: false };
  await store.refresh(origin);
  assert.equal(store.summary('all').total, 2);
  server.pages = () => ({ entries: [row('c')], hasMore: true });
  await store.refresh(origin);
  assert.match(store.summary('all').error, /分页未前进/);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').done, 0);
  server.pages = () => ({ entries: [{ id: 'bad' }], hasMore: false });
  await store.refresh(origin);
  assert.match(store.summary('all').error, /收录时间/);
  assert.equal(store.summary('all').total, 2);
});

test('authentication failures hide counts, account switches cannot mix histories', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  server.status = 401; await store.refresh(origin);
  assert.equal(store.summary('all').ready, false); assert.equal(store.summary('all').total, 0);
  server.status = 200; server.user = 'bob'; server.entries = []; await store.refresh(origin);
  assert.equal(store.summary('all').total, 0);
  server.user = 'alice'; server.entries = [row('a')]; await store.refresh(origin);
  assert.equal(store.summary('all').total, 1);
  server.hook = async url => { if (url.pathname.startsWith('/api/streams/')) server.user = 'bob'; };
  await store.refresh(origin);
  assert.equal(store.summary('all').ready, false); assert.match(store.summary('all').error, /账号已切换/);
});

test('first article can be recorded before initial full scan and failure never invents completion', async t => {
  const { server, store } = setup(t);
  server.entries = [row('early')];
  const token = await store.track(origin, 'early');
  store.complete(token); server.entries = [];
  await store.refresh(origin);
  assert.equal(store.summary('all').total, 1); assert.equal(store.summary('all').done, 1);
  assert.equal(await store.track(origin, 'missing'), null);
  assert.equal(store.summary('all').total, 1);
});

test('local completion during a delayed scan wins over its stale page', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  const token = await store.track(origin, 'a');
  server.hook = async url => { if (url.pathname.startsWith('/api/streams/')) store.complete(token); };
  await store.refresh(origin);
  assert.equal(store.summary('all').total, 1); assert.equal(store.summary('all').done, 1);
});

test('day and Monday boundaries recompute after midnight without a process restart', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  store.now = () => boundaries(now).tomorrow + 1000;
  assert.equal(store.summary().done, 0); assert.equal(store.summary().remaining, 100);
  assert.equal(store.summary('all').total, 1);
  assert.equal(store.summary('week').total, 1);
  const sunday = +new Date(2026, 10, 1, 23, 59);
  assert.equal(new Date(boundaries(sunday).week).getDay(), 1);
  assert.equal(boundaries(sunday).week, +new Date(2026, 9, 26));
  assert.equal(boundaries(+new Date(2026, 10, 2, 0, 1)).week, +new Date(2026, 10, 2));
});

test('corrupt stored history is preserved and never overwritten with a false zero', async t => {
  const { options } = setup(t);
  fs.writeFileSync(options.file, '{broken');
  const store = new ReadingProgress(options); await store.refresh(origin);
  assert.equal(store.summary('all').ready, false); assert.match(store.summary('all').error, /记录无法读取/);
  assert.equal(fs.readFileSync(options.file, 'utf8'), '{broken');
});

test('all includes older articles and retains completed progress across weeks and restarts', async t => {
  const { server, store, options } = setup(t);
  server.entries = [row('old', boundaries(now).week - 1000), row('today')];
  await store.refresh(origin);
  const token = await store.track(origin, 'old'); store.complete(token);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').done, 1);
  assert.equal(store.summary('all').older, 0);
  assert.equal(store.summary().total, 100); assert.equal(store.summary().done, 1);
  const nextWeek = boundaries(now).week + 7 * 86400000 + 12 * 3600000;
  store.now = () => nextWeek;
  server.entries = [row('today')]; await store.refresh(origin);
  assert.equal(store.summary('week').total, 0);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').remaining, 1);
  const reopened = new ReadingProgress({ ...options, now: () => nextWeek });
  await reopened.refresh(origin);
  assert.equal(reopened.summary('all').total, 2); assert.equal(reopened.summary('all').done, 1);
});

test('1344-item daily snapshot is reused for repeated startup syncs and across restarts', async t => {
  const { store, server, options } = setup(t);
  let clock = now; store.now = () => clock;
  const all = Array.from({ length: 1344 }, (_, i) => ({ ...row(`item-${i}`), timestamp: String(10000 - i) }));
  server.pages = cursor => {
    const start = cursor === null ? 0 : 10001 - Number(cursor);
    return { entries: all.slice(start, start + 100), hasMore: start + 100 < all.length };
  };
  await store.sync(origin);
  assert.equal(server.calls.filter(p => p.startsWith('/api/streams/')).length, 14);
  for (let i = 0; i < 287; i++) { clock += 5 * 60000; await store.sync(origin); }
  const restarted = new ReadingProgress({ ...options, now: () => clock });
  await restarted.sync(origin);
  assert.equal(restarted.summary('all').total, 1344);
  assert.equal(server.calls.filter(p => p.startsWith('/api/streams/')).length, 14);
  clock += 5 * 60000; await restarted.sync(origin);
  assert.equal(server.calls.filter(p => p.startsWith('/api/streams/')).length, 28);
});

test('manual scan cooldown and the 100-page daily budget survive restarts, failed partial scans retain counts', async t => {
  const { store, server, options } = setup(t);
  let clock = now; store.now = () => clock;
  server.entries = [row('a')]; await store.sync(origin);
  const count = () => server.calls.filter(p => p.startsWith('/api/streams/')).length;
  await Promise.all(Array.from({ length: 20 }, () => store.sync(origin, { manual: true })));
  assert.equal(count(), 1); assert.match(store.summary('all').error, /冷却/);
  const reopened = new ReadingProgress({ ...options, now: () => clock });
  await reopened.sync(origin, { manual: true }); assert.equal(count(), 1);
  server.pages = cursor => ({ entries: [{ ...row('partial'), timestamp: String(cursor === null ? 10000 : Number(cursor) - 1) }], hasMore: true });
  clock += 31 * 60000;
  await reopened.sync(origin, { manual: true });
  assert.equal(count(), 100); assert.match(reopened.summary('all').error, /100 次/);
  assert.equal(reopened.summary('all').total, 1);
  clock += 31 * 60000;
  const again = new ReadingProgress({ ...options, now: () => clock });
  await again.sync(origin, { manual: true }); assert.equal(count(), 100);
  clock += 86400000; server.pages = null;
  await again.sync(origin, { manual: true }); assert.equal(count(), 101);
});

test('429 stops statistics requests including tracking, honors longer Retry-After, and persists across restart', async t => {
  const { store, server, options } = setup(t);
  let clock = now; store.now = () => clock;
  server.entries = [row('a')]; await store.sync(origin);
  server.hook = url => { if (url.pathname.startsWith('/api/streams/')) server.status = 429; };
  server.retryAfter = '172800'; clock += 31 * 60000;
  await store.sync(origin, { manual: true });
  assert.match(store.summary('all').error, /限流/); assert.equal(store.summary('all').total, 1);
  const count = server.calls.length;
  assert.equal(await store.track(origin, 'a'), null);
  const restarted = new ReadingProgress({ ...options, now: () => clock });
  await restarted.sync(origin, { manual: true });
  assert.equal(server.calls.length, count);
  clock += 86400000; await restarted.sync(origin, { manual: true });
  assert.equal(server.calls.length, count);
  server.status = 200; server.hook = null; clock += 86400001;
  await restarted.sync(origin, { manual: true });
  assert.equal(restarted.summary('all').ready, true); assert.equal(restarted.summary('all').error, '');
});

test('confirmed single-item tag changes update local counts without listing the stream', async t => {
  const { store, server } = setup(t);
  server.entries = [row('a')]; await store.sync(origin);
  const count = server.calls.filter(p => p.startsWith('/api/streams/')).length;
  server.entries[0].tagIds = [];
  await store.reconcile(origin, 'a'); assert.equal(store.summary('all').done, 1);
  server.entries.push(row('new')); await store.reconcile(origin, 'new');
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').remaining, 1);
  server.entries[0].tagIds = ['later']; await store.reconcile(origin, 'a');
  assert.equal(store.summary('all').done, 0);
  server.status = 503; await store.reconcile(origin, 'new');
  assert.equal(store.summary('all').total, 2);
  assert.equal(server.calls.filter(p => p.startsWith('/api/streams/')).length, count);
});

test('100 confirmed completions reach the daily goal, including old articles; duplicates, rereads and midnight are handled locally', async t => {
  const { store, server, options } = setup(t);
  server.entries = Array.from({ length: 101 }, (_, i) => row(`old-${i}`, today - 10 * 86400000));
  await store.sync(origin);
  const requests = () => server.calls.filter(p => p.startsWith('/api/streams/')).length;
  const before = requests();
  let first;
  for (let i = 0; i < 100; i++) {
    const token = await store.track(origin, `old-${i}`);
    store.complete(token); store.complete(token);
    if (i === 0) first = token;
  }
  assert.equal(store.summary().done, 100); assert.equal(store.summary().total, 100);
  assert.equal(store.summary().reached, true); assert.equal(store.summary().remaining, 0);
  const extra = await store.track(origin, 'old-100'); store.complete(extra);
  assert.equal(store.summary().done, 101); assert.equal(store.summary().remaining, 0);
  const replay = await store.track(origin, 'old-0'); store.complete(replay);
  assert.equal(store.summary().done, 101);
  assert.equal(store.summary('all').done, 101);
  const reopened = new ReadingProgress(options); await reopened.sync(origin);
  assert.equal(reopened.summary().done, 101);
  assert.equal(requests(), before);
  store.now = () => boundaries(now).tomorrow + 1;
  assert.equal(store.summary().done, 0); store.complete(first);
  assert.equal(store.summary().done, 0, 'A stale completion token must not count on a new day');
});

test('daily and weekly modes persist independently; automatic week uses saved articles rather than daily target times seven', async t => {
  const { store, server, options } = setup(t);
  server.entries = [row('new'), row('older', boundaries(now).week - 1000)]; await store.sync(origin);
  const requests = server.calls.length;
  store.setGoals({ today: { automatic: false, target: 150 } });
  assert.equal(store.summary('week').total, 1);
  assert.equal(store.summary('week').automatic, true);
  store.setGoals({ week: { automatic: false, target: 320 } });
  assert.equal(server.calls.length, requests);
  const token = await store.track(origin, 'older'); store.complete(token);
  assert.equal(store.summary().done, 1);
  assert.equal(store.summary('week').done, 1); assert.equal(store.summary('week').total, 320);
  const reopened = new ReadingProgress(options); await reopened.sync(origin);
  assert.equal(reopened.summary().total, 150); assert.equal(reopened.summary('week').total, 320);
  store.setGoals({ week: { automatic: true, target: 320 } });
  assert.equal(store.summary('week').total, 1); assert.equal(store.summary('week').done, 0);
  store.setGoals({ today: { automatic: true, target: 150 } });
  assert.equal(store.summary().total, 1);
  for (const target of [0, -1, 1.5, 10001, '100', NaN]) assert.throws(() => store.setGoals({ today: { automatic: false, target } }));
  assert.throws(() => store.setGoals({ all: { automatic: false, target: 10 } }));
  const before = server.calls.length;
  store.setGoals({ week: { automatic: false, target: 222 } }); assert.equal(server.calls.length, before);
});

test('legacy completions and other-device removals retain all progress without inventing a completion date', async t => {
  const { store, server, options } = setup(t);
  server.entries = [row('legacy'), row('remote')]; await store.sync(origin);
  const account = store.data.accounts[store.active]; account.entries[0].done = true;
  store.persist(store.data);
  const reopened = new ReadingProgress(options); await reopened.sync(origin);
  assert.equal(reopened.summary().done, 0);
  server.entries = []; await reopened.refresh(origin);
  assert.equal(reopened.summary('all').done, 2); assert.equal(reopened.summary().done, 0);
});

test('manual weekly goal rolls over on Monday while the daily goal resets at local midnight', async t => {
  const { store, server } = setup(t);
  server.entries = [row('a')]; await store.sync(origin);
  store.setGoals({ week: { automatic: false, target: 2 } });
  const token = await store.track(origin, 'a'); store.complete(token);
  assert.equal(store.summary('week').done, 1);
  store.now = () => boundaries(now).tomorrow + 1000;
  assert.equal(store.summary().done, 0); assert.equal(store.summary('week').done, 1);
  store.now = () => boundaries(now).week + 7 * 86400000 + 1000;
  assert.equal(store.summary('week').done, 0); assert.equal(store.summary('week').total, 2);
});

test('target settings and completion dates remain isolated by verified account', async t => {
  const { store, server } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  store.setGoals({ today: { automatic: false, target: 42 } });
  const token = await store.track(origin, 'a'); store.complete(token);
  server.user = 'bob'; await store.refresh(origin);
  assert.equal(store.summary().total, 100); assert.equal(store.summary().done, 0);
  server.user = 'alice'; await store.refresh(origin);
  assert.equal(store.summary().total, 42); assert.equal(store.summary().done, 1);
});

test('unified goal form validates both targets before writing either and preserves unrelated settings', async t => {
  const { store, server, options } = setup(t);
  server.entries = [row('a')]; await store.sync(origin);
  const before = fs.readFileSync(options.file, 'utf8'), calls = server.calls.length;
  assert.throws(() => store.setGoals({ today: { automatic: false, target: 50 }, week: { automatic: false, target: 0 } }));
  assert.equal(fs.readFileSync(options.file, 'utf8'), before);
  store.setGoals({ today: { automatic: false, target: 50 }, week: { automatic: true, target: 200 } });
  assert.equal(store.summary().total, 50); assert.equal(store.summary('week').automatic, true);
  assert.equal(store.data.limits.pages, 1); assert.equal(server.calls.length, calls);
});
