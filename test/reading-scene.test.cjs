const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadingScene, defaults, listURL } = require('../reading-scene.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-scene-'));
  const file = path.join(dir, 'reading-scene.json');
  const scene = new ReadingScene(file);
  t.after(() => { clearTimeout(scene.timer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { scene, file };
}
test('reading scene persists layout, per-site zoom and article positions independently', t => {
  const { scene, file } = fixture(t);
  assert.deepEqual(scene.summary(), { ...defaults, error: '' });
  scene.configure({ resume: true });
  scene.update({ side: 'right', width: 240, hidden: true, readerZoom: 90, period: 'week' });
  scene.setReader('https://www.qireader.com/tags/reading?tracking=ignored');
  scene.setZoom('https://example.com/a', 120);
  scene.visit('https://example.com/a'); scene.remember('https://example.com/a', 0, 640);
  scene.visit('https://example.com/b'); scene.remember('https://example.com/b', 0, 900);
  assert.equal(scene.flush(), true);
  const restored = new ReadingScene(file);
  assert.equal(restored.summary().hidden, true);
  assert.equal(restored.summary().readerZoom, 90); assert.equal(restored.summary().period, 'week');
  assert.equal(restored.data.reader, 'https://www.qireader.com/tags/reading');
  assert.equal(restored.data.last, 'https://example.com/b');
  assert.deepEqual(restored.position('https://example.com/a'), { x: 0, y: 640 });
  assert.equal(restored.zoom('https://example.com/c'), 120);
  assert.equal(restored.zoom('https://other.example/c'), 100);
  restored.configure({ resume: false }); assert.equal(new ReadingScene(file).summary().resume, false);
});
test('invalid scene settings cannot change saved layout; failed writes preserve active settings', t => {
  const { scene, file } = fixture(t);
  scene.configure({ resume: false });
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of [{ mode: 'overlay' }, { width: 179 }, { width: Infinity }, { resume: 'yes' }, { readerZoom: 500 }]) assert.throws(() => scene.configure(invalid));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  scene.file = path.join(path.dirname(file), 'missing', 'scene.json');
  assert.throws(() => scene.configure({ resume: true }), /原设置保留/);
  assert.equal(scene.summary().resume, false);
  assert.equal(scene.flush(), false); assert.ok(scene.error);
});
test('corrupt reading scenes stay untouched until an explicit valid settings save', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{bad');
  const broken = new ReadingScene(file);
  broken.visit('https://example.com/a'); broken.update({ width: 300 });
  assert.equal(broken.flush(), false); assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  assert.ok(broken.error);
  broken.configure({ resume: false });
  assert.equal(broken.error, ''); assert.equal(new ReadingScene(file).summary().resume, false);
});
test('legacy drawer scenes fall back to split without losing reading history or preferences', t => {
  const { scene, file } = fixture(t);
  scene.update({ side: 'right', width: 240, hidden: true, readerZoom: 90, period: 'week' });
  scene.visit('https://example.com/article/123.html'); scene.remember(scene.data.last, 0, 640);
  scene.setZoom(scene.data.last, 120); scene.setReader('https://www.qireader.com/tags/!readlater');
  const legacy = { ...scene.data, layout: { ...scene.data.layout, mode: 'drawer' } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const restored = new ReadingScene(file);
  assert.equal(restored.error, ''); assert.equal('mode' in restored.summary(), false);
  assert.equal(restored.summary().side, 'right'); assert.equal(restored.summary().width, 240);
  assert.equal(restored.summary().hidden, true); assert.equal(restored.summary().readerZoom, 90);
  assert.equal(restored.summary().period, 'week'); assert.equal(restored.zoom(legacy.last), 120);
  assert.equal(restored.data.reader, legacy.reader); assert.equal(restored.data.last, legacy.last);
  assert.deepEqual(restored.position(legacy.last), { x: 0, y: 640 });
  assert.throws(() => restored.configure({ mode: 'drawer' }));
  restored.flush(); assert.equal('mode' in JSON.parse(fs.readFileSync(file, 'utf8')).layout, false);
});
test('lamp style migrates old settings, can switch back to the original bar, and persists', t => {
  const { scene, file } = fixture(t);
  const old = structuredClone(scene.data); delete old.layout.progressStyle;
  fs.writeFileSync(file, JSON.stringify(old));
  const migrated = new ReadingScene(file);
  assert.equal(migrated.summary().progressStyle, 'lamps'); assert.equal(migrated.error, '');
  migrated.configure({ progressStyle: 'bar' });
  assert.equal(new ReadingScene(file).summary().progressStyle, 'bar');
  assert.throws(() => migrated.configure({ progressStyle: 'invalid' }));
  assert.equal(new ReadingScene(file).summary().progressStyle, 'bar');
});
test('scene history is bounded; credentials, non-web URLs, unknown pages and invalid scroll positions are rejected', t => {
  const { scene } = fixture(t);
  for (const invalid of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com/a']) scene.visit(invalid);
  assert.equal(scene.data.pages.length, 0);
  for (let i = 0; i < 105; i++) { scene.visit(`https://site${i}.example/a`); scene.setZoom(`https://site${i}.example/a`, 110); }
  assert.equal(scene.data.pages.length, 100); assert.equal(scene.data.sites.length, 100);
  assert.equal(scene.data.pages.some(page => page.url === 'https://site0.example/a'), false);
  const url = scene.data.last;
  for (const y of [-1, Infinity, NaN, 1e9, '10']) scene.remember(url, 0, y);
  assert.deepEqual(scene.position(url), { x: 0, y: 0 });
  scene.remember('https://unknown.example/', 0, 640); assert.equal(scene.data.pages.length, 100);
  assert.equal(listURL('https://www.qireader.com.evil/tags/reading'), '');
  assert.equal(listURL('https://www.qireader.com/tags/reading/entries/a'), '');
  assert.equal(listURL('https://www.qireader.com/login'), '');
  scene.flush();
});
