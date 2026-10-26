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
  const server = { user: 'alice', entries: [], status: 200, pages: null, hook: null };
  const options = {
    file: path.join(directory, 'progress.json'), now: () => now,
    fetch: async (address, options) => {
      const url = new URL(address);
      assert.equal(url.origin, origin); assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-api-version'], '21.0.0');
      if (server.hook) await server.hook(url);
      if (server.status !== 200) return new Response('{}', { status: server.status });
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

test('today/week count only saved cohort; server read flag is not completion; old pending separate', async t => {
  const { server, store } = setup(t);
  server.entries = [row('today'), row('monday', boundaries(now).week + 1000), row('older', boundaries(now).week - 1000), row('future', boundaries(now).tomorrow + 1000)];
  await store.refresh(origin);
  assert.equal(store.summary().total, 1);
  assert.equal(store.summary().done, 0);
  assert.equal(store.summary().older, 2);
  assert.equal(store.summary('week').total, 2);
  assert.equal(store.summary('week').older, 1);
});

test('confirmed completion persists across restarts, retains denominator, and supports re-add', async t => {
  const { server, store, options } = setup(t);
  server.entries = [row('a'), row('b')];
  await store.refresh(origin);
  const token = await store.track(origin, 'a');
  store.complete(token); store.complete(token);
  assert.equal(store.summary().total, 2); assert.equal(store.summary().done, 1);
  server.entries = [row('b')];
  const reopened = new ReadingProgress(options);
  assert.equal(reopened.summary().ready, false); // Verify the logged-in account before revealing stored counts.
  await reopened.refresh(origin);
  assert.equal(reopened.summary().total, 2); assert.equal(reopened.summary().done, 1);
  server.entries.push(row('a'));
  await reopened.refresh(origin);
  assert.equal(reopened.summary().total, 2); assert.equal(reopened.summary().done, 0);
});

test('full snapshot detects another device removing an article without losing total', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a'), row('b')]; await store.refresh(origin);
  server.entries = [row('b')]; await store.refresh(origin);
  assert.equal(store.summary().remaining, 1); assert.equal(store.summary().total, 2);
  server.entries.push(row('c')); await store.refresh(origin);
  assert.equal(store.summary().total, 3); assert.equal(store.summary().done, 1);
});

test('opaque cursor deduplication and all-page completion; partial failures preserve last counts', async t => {
  const { server, store } = setup(t);
  server.pages = cursor => cursor === null ? { entries: [row('a')], hasMore: true } :
    { entries: [row('a'), row('b')], hasMore: false };
  await store.refresh(origin);
  assert.equal(store.summary().total, 2);
  server.pages = () => ({ entries: [row('c')], hasMore: true });
  await store.refresh(origin);
  assert.match(store.summary().error, /分页未前进/);
  assert.equal(store.summary().total, 2); assert.equal(store.summary().done, 0);
  server.pages = () => ({ entries: [{ id: 'bad' }], hasMore: false });
  await store.refresh(origin);
  assert.match(store.summary().error, /收录时间/);
  assert.equal(store.summary().total, 2);
});

test('authentication failures hide counts, account switches cannot mix histories', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  server.status = 401; await store.refresh(origin);
  assert.equal(store.summary().ready, false); assert.equal(store.summary().total, 0);
  server.status = 200; server.user = 'bob'; server.entries = []; await store.refresh(origin);
  assert.equal(store.summary().total, 0);
  server.user = 'alice'; server.entries = [row('a')]; await store.refresh(origin);
  assert.equal(store.summary().total, 1);
  server.hook = async url => { if (url.pathname.startsWith('/api/streams/')) server.user = 'bob'; };
  await store.refresh(origin);
  assert.equal(store.summary().ready, false); assert.match(store.summary().error, /账号已切换/);
});

test('first article can be recorded before initial full scan and failure never invents completion', async t => {
  const { server, store } = setup(t);
  server.entries = [row('early')];
  const token = await store.track(origin, 'early');
  store.complete(token); server.entries = [];
  await store.refresh(origin);
  assert.equal(store.summary().total, 1); assert.equal(store.summary().done, 1);
  assert.equal(await store.track(origin, 'missing'), null);
  assert.equal(store.summary().total, 1);
});

test('local completion during a delayed scan wins over its stale page', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  const token = await store.track(origin, 'a');
  server.hook = async url => { if (url.pathname.startsWith('/api/streams/')) store.complete(token); };
  await store.refresh(origin);
  assert.equal(store.summary().total, 1); assert.equal(store.summary().done, 1);
});

test('day and Monday boundaries recompute after midnight without a process restart', async t => {
  const { server, store } = setup(t);
  server.entries = [row('a')]; await store.refresh(origin);
  store.now = () => boundaries(now).tomorrow + 1000;
  assert.equal(store.summary().total, 0); assert.equal(store.summary().older, 1);
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
  assert.equal(store.summary().ready, false); assert.match(store.summary().error, /记录无法读取/);
  assert.equal(fs.readFileSync(options.file, 'utf8'), '{broken');
});

test('all includes older articles and retains completed progress across weeks and restarts', async t => {
  const { server, store, options } = setup(t);
  server.entries = [row('old', boundaries(now).week - 1000), row('today')];
  await store.refresh(origin);
  const token = await store.track(origin, 'old'); store.complete(token);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').done, 1);
  assert.equal(store.summary('all').older, 0);
  assert.equal(store.summary().total, 1); assert.equal(store.summary().done, 0);
  const nextWeek = boundaries(now).week + 7 * 86400000 + 12 * 3600000;
  store.now = () => nextWeek;
  server.entries = [row('today')]; await store.refresh(origin);
  assert.equal(store.summary('week').total, 0);
  assert.equal(store.summary('all').total, 2); assert.equal(store.summary('all').remaining, 1);
  const reopened = new ReadingProgress({ ...options, now: () => nextWeek });
  await reopened.refresh(origin);
  assert.equal(reopened.summary('all').total, 2); assert.equal(reopened.summary('all').done, 1);
});
