const fs = require('node:fs');
const { webURL, readerURL } = require('./policy.cjs');
const defaults = { side: 'left', width: 280, hidden: false, readerZoom: 100, period: 'today', resume: true, progressStyle: 'lamps' };
const zoom = value => Number.isInteger(value) && value >= 50 && value <= 200;
const position = value => Number.isFinite(value) && value >= 0 && value <= 1e8;
function layout(value) {
  value = { ...value, progressStyle: value?.progressStyle ?? defaults.progressStyle };
  if (!value || !['left', 'right'].includes(value.side) ||
      !Number.isInteger(value.width) || value.width < 180 || value.width > 6000 || typeof value.hidden !== 'boolean' ||
      !zoom(value.readerZoom) || !['today', 'week', 'all'].includes(value.period) || typeof value.resume !== 'boolean' || !['bar', 'lamps'].includes(value.progressStyle)) throw Error('阅读布局设置无效');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]]));
}
function listURL(value) {
  const url = readerURL(value) && new URL(value);
  return url && /^\/(tags|feeds)(\/|$)/.test(url.pathname) && !url.pathname.includes('/entries/') ? url.origin + url.pathname : '';
}
class ReadingScene {
  constructor(file) {
    this.file = file; this.error = ''; this.blocked = false;
    this.data = { version: 1, layout: { ...defaults }, sites: [], pages: [], last: '', reader: '' };
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw Error('Scene too large');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.sites) || data.sites.length > 100 ||
          !data.sites.every(site => webURL(site.origin) && new URL(site.origin).origin === site.origin && zoom(site.zoom)) ||
          !Array.isArray(data.pages) || data.pages.length > 100 ||
          !data.pages.every(page => webURL(page.url) === page.url && position(page.x) && position(page.y)) ||
          typeof data.last !== 'string' || data.last && !data.pages.some(page => page.url === data.last) ||
          typeof data.reader !== 'string' || data.reader && listURL(data.reader) !== data.reader) throw Error('Invalid scene');
      this.data = { ...data, layout: layout(data.layout) };
    } catch (error) {
      if (error.code !== 'ENOENT') { this.blocked = true; this.error = '阅读现场无法读取，原文件已保留；保存阅读设置可重新建立记录'; }
    }
  }
  summary() { return { ...this.data.layout, error: this.error }; }
  write(data) {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  schedule() {
    if (this.blocked || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000); this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.blocked) return false;
    try { this.write(this.data); this.error = ''; return true; }
    catch { this.error = '阅读现场保存失败，本次窗口内继续保留；请检查磁盘空间'; return false; }
  }
  configure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(key in defaults))) throw Error('阅读现场设置无效');
    const next = { ...this.data, layout: layout({ ...this.data.layout, ...value }) };
    try { this.write(next); } catch { throw Error('阅读布局保存失败，原设置保留'); }
    this.data = next; this.blocked = false; this.error = '';
  }
  update(value) { this.data.layout = layout({ ...this.data.layout, ...value }); this.schedule(); }
  setReader(value) { const url = listURL(value); if (url && url !== this.data.reader) { this.data.reader = url; this.schedule(); } }
  zoom(value) { const url = webURL(value); return url ? this.data.sites.find(site => site.origin === new URL(url).origin)?.zoom || 100 : 100; }
  setZoom(value, percent) {
    const url = webURL(value);
    if (!url || !zoom(percent)) return;
    const origin = new URL(url).origin;
    this.data.sites = [...this.data.sites.filter(site => site.origin !== origin), { origin, zoom: percent }].slice(-100);
    this.schedule();
  }
  visit(value) {
    const url = webURL(value); if (!url) return;
    const saved = this.data.pages.find(page => page.url === url) || { url, x: 0, y: 0 };
    this.data.pages = [...this.data.pages.filter(page => page.url !== url), saved].slice(-100);
    this.data.last = url; this.schedule();
  }
  position(value) { const url = webURL(value); const saved = this.data.pages.find(page => page.url === url); return saved ? { x: saved.x, y: saved.y } : { x: 0, y: 0 }; }
  remember(value, x, y) {
    const url = webURL(value), page = this.data.pages.find(page => page.url === url);
    if (!page || !position(x) || !position(y)) return;
    page.x = Math.round(x); page.y = Math.round(y); this.schedule();
  }
}
module.exports = { ReadingScene, defaults, listURL };
