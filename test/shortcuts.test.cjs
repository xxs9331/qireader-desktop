const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Shortcuts, bindings, defaults } = require('../shortcuts.cjs');
const vm = require('node:vm');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-shortcuts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shortcuts.json');
  return { file, store: new Shortcuts(file) };
}
test('shortcut defaults, disabled bindings and canonical duplicate validation', () => {
  assert.deepEqual(defaults, { previous: '', next: 'Space', 'cubox-save': 'S' });
  assert.deepEqual(bindings({ previous: 'Alt+Ctrl+arrowleft', next: 'Space', 'cubox-save': 's' }), { previous: 'Ctrl+Alt+ArrowLeft', next: 'Space', 'cubox-save': 'S' });
  assert.deepEqual(bindings({ previous: '', next: '', 'cubox-save': '' }), { previous: '', next: '', 'cubox-save': '' });
  for (const value of [null, {}, { ...defaults, next: 2 }, { ...defaults, previous: 's' }, { ...defaults, next: 'Ctrl+Ctrl+S' }, { ...defaults, next: 'Control' }, { ...defaults, next: 'Ctrl+0' }, { ...defaults, next: 'Meta+0' }, { ...defaults, next: 'x'.repeat(81) }]) assert.throws(() => bindings(value));
});
test('shortcut changes persist, copies are isolated and invalid settings preserve the saved values', t => {
  const { file, store } = fixture(t);
  const custom = { previous: 'Alt+ArrowLeft', next: 'N', 'cubox-save': 'Ctrl+S' };
  store.configure(custom);
  assert.deepEqual(new Shortcuts(file).summary().bindings, custom);
  const snapshot = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.configure({ ...custom, next: 'Ctrl+S' }), /重复/);
  assert.equal(fs.readFileSync(file, 'utf8'), snapshot);
  store.summary().bindings.next = 'X';
  assert.equal(store.bindings.next, 'N');
  store.file = path.join(path.dirname(file), 'missing', 'shortcuts.json');
  assert.throws(() => store.configure(defaults), /原设置保留/);
  assert.deepEqual(store.bindings, custom);
});
test('corrupt shortcut files remain intact and disable actions until a valid save', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{broken');
  const store = new Shortcuts(file);
  assert.deepEqual(store.bindings, { previous: '', next: '', 'cubox-save': '' });
  assert.ok(store.error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  store.configure(defaults);
  assert.equal(store.error, '');
  assert.deepEqual(new Shortcuts(file).bindings, defaults);
});
test('both isolated preload handlers honor bindings and reject typing, IME, repeats and synthetic key events', () => {
  for (const file of ['reader-preload.cjs', 'shell-preload.cjs']) {
    const listeners = {}, calls = [];
    let handler;
    class Element { matches() { return this.editable; } }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      require: () => ({ ipcRenderer: { on: (name, fn) => { listeners[name] = fn; }, send: (...args) => calls.push(args) }, contextBridge: { exposeInMainWorld() {} } }),
      process: { isMainFrame: true, argv: [] }, location: { pathname: '/shell.html' }, Element,
      window: { addEventListener: (_name, fn) => { handler = fn; } }
    });
    listeners['desktop:bindings']({}, defaults);
    const press = changes => {
      const event = { isTrusted: true, key: ' ', code: 'Space', composedPath: () => [], preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...changes };
      handler(event); return event;
    };
    assert.equal(press({}).prevented, true);
    assert.equal(calls.at(-1)[1], 'next');
    assert.equal(press({ code: '' }).prevented, true);
    calls.pop();
    press({ key: 's', code: 'KeyS' }); assert.equal(calls.at(-1)[1], 'cubox-save');
    const typed = new Element(); typed.editable = true;
    for (const changes of [{ repeat: true }, { isComposing: true }, { isTrusted: false }, { ctrlKey: true }, { shiftKey: true }, { composedPath: () => [typed] }, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }]) assert.equal(press(changes).prevented, undefined);
    assert.equal(calls.length, 2);
    listeners['desktop:bindings']({}, { previous: 'Alt+ArrowLeft', next: 'N', 'cubox-save': '' });
    press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }); assert.equal(calls.at(-1)[1], 'previous');
    press({ key: 'n', code: 'KeyN' }); assert.equal(calls.at(-1)[1], 'next');
    assert.equal(press({}).prevented, undefined);
    assert.equal(press({ key: 's', code: 'KeyS' }).prevented, undefined);
    assert.equal(calls.length, 4);
  }
});
