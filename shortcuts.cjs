const fs = require('node:fs');

const defaults = { previous: '', next: 'Space', 'cubox-save': 'S' };
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const keys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
function bindings(input) {
  const result = {}, used = new Set();
  for (const action of Object.keys(defaults)) {
    const value = input?.[action];
    if (typeof value !== 'string' || value.length > 80) throw Error('请检查快捷键设置');
    if (!value) { result[action] = ''; continue; }
    const parts = value.split('+'), last = parts.pop();
    const key = /^[a-z0-9]$/i.test(last) ? last.toUpperCase() : keys.find(name => name.toLowerCase() === last.toLowerCase());
    if (!key || parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length) throw Error('请使用字母、数字、空格、方向键、翻页键或 F1–F12，可搭配 Ctrl / Alt / Shift / Meta');
    const normalized = [...modifiers.filter(name => parts.includes(name)), key].join('+');
    if (['Ctrl+0', 'Meta+0'].includes(normalized)) throw Error('Ctrl/Meta + 0 已用于恢复字号，请选择其他快捷键');
    if (used.has(normalized)) throw Error('快捷键重复，请为每个操作设置不同按键');
    used.add(normalized); result[action] = normalized;
  }
  return result;
}
class Shortcuts {
  constructor(file) {
    this.file = file; this.bindings = { ...defaults }; this.error = '';
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1) throw Error('Invalid version');
      this.bindings = bindings(saved.bindings);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.bindings = { previous: '', next: '', 'cubox-save': '' };
        this.error = '快捷键配置无法读取，已暂停快捷键；请重新保存';
      }
    }
  }
  configure(input) {
    const value = bindings(input);
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, bindings: value }), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { throw Error('快捷键保存失败，原设置保留'); }
    this.bindings = value; this.error = '';
  }
  summary() { return { bindings: { ...this.bindings }, error: this.error }; }
}
module.exports = { Shortcuts, bindings, defaults };
