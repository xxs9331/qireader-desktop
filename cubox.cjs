const fs = require('node:fs');
const { webURL } = require('./policy.cjs');

function apiURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !['cubox.pro', 'cubox.cc'].includes(url.host) ||
        url.username || url.password || url.search || url.hash || !/^\/c\/api\/save\/[A-Za-z0-9_-]{6,512}\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch { return null; }
}
function settings(input, previous) {
  if (!input || typeof input.link !== 'string' || typeof input.folder !== 'string' || typeof input.tags !== 'string') throw new Error('请检查 Cubox 设置');
  const link = input.link.trim() ? apiURL(input.link) : previous?.link;
  if (!link) throw new Error('请粘贴完整的 Cubox API 链接（cubox.pro 或 cubox.cc）');
  const folder = input.folder.trim();
  const tags = [...new Set(input.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
  if (folder.length > 128 || input.tags.length > 2048 || tags.length > 20 || tags.some(tag => tag.length > 64)) throw new Error('收藏夹或标签过长，请缩短后重试');
  return { link, folder, tags };
}

class Cubox {
  constructor({ file, storage, fetch }) {
    this.file = file; this.storage = storage; this.fetch = fetch;
    this.config = null; this.error = ''; this.busy = false; this.saved = new Set(); this.controller = null;
    this.ready = this.load();
  }
  async requireEncryption() {
    try {
      if ((process.platform === 'linux' && this.storage.getSelectedStorageBackend() === 'basic_text') ||
          !await this.storage.isAsyncEncryptionAvailable()) throw new Error('Unavailable');
    } catch { throw new Error('系统安全存储不可用，无法安全保存 API 链接'); }
  }
  async load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || typeof data.encrypted !== 'string' || data.encrypted.length > 32768) throw new Error('Invalid settings');
      await this.requireEncryption();
      const { result } = await this.storage.decryptStringAsync(Buffer.from(data.encrypted, 'base64'));
      const value = JSON.parse(result);
      if (!Array.isArray(value.tags)) throw new Error('Invalid settings');
      this.config = settings({ link: value.link, folder: value.folder, tags: value.tags.join(',') });
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = '无法读取已保存的 Cubox 配置，请重新设置';
    }
  }
  summary(url = '') {
    return {
      configured: Boolean(this.config), server: this.config ? new URL(this.config.link).hostname : '',
      folder: this.config?.folder || '', tags: this.config?.tags || [],
      busy: this.busy, submitted: this.saved.has(url), error: this.error
    };
  }
  async configure(input) {
    await this.ready;
    if (this.busy) throw new Error('正在提交，请稍后修改设置');
    const value = settings(input, this.config);
    this.busy = true;
    try {
      await this.requireEncryption();
      let encrypted;
      try { encrypted = await this.storage.encryptStringAsync(JSON.stringify(value)); }
      catch { throw new Error('API 链接加密失败，未保存设置'); }
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') }), { mode: 0o600 });
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch { throw new Error('Cubox 设置保存失败，请重试'); }
      this.config = value; this.error = ''; this.saved.clear();
    } finally { this.busy = false; }
  }
  async clear() {
    await this.ready;
    if (this.busy) throw new Error('正在提交，请稍后修改设置');
    try { fs.unlinkSync(this.file); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法清除本机配置，请重试'); }
    this.config = null; this.error = ''; this.saved.clear();
  }
  async collect(url, title) {
    await this.ready;
    if (!this.config) throw new Error('请先设置 Cubox API 链接');
    url = webURL(url);
    if (!url) throw new Error('当前没有可收藏的网页');
    if (this.busy) throw new Error('正在提交，请稍候');
    if (this.saved.has(url)) return;
    this.busy = true;
    const config = this.config;
    const controller = new AbortController(); this.controller = controller;
    try {
      const body = { type: 'url', content: url };
      if (typeof title === 'string' && title.trim()) body.title = title.trim().slice(0, 512);
      if (config.folder) body.folder = config.folder;
      if (config.tags.length) body.tags = config.tags;
      let response;
      try {
        response = await this.fetch(config.link, {
          method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
        });
      } catch { throw new Error('提交结果未确认：网络异常或超时，请先到 Cubox 核对后再重试'); }
      if (response.status === 401 || response.status === 403) throw new Error('Cubox API 链接失效或无权限，请检查设置');
      if (response.status === 429) throw new Error('Cubox 调用次数受限，请稍后重试');
      if (!response.ok) throw new Error(`Cubox 未确认收藏（HTTP ${response.status}），请核对后重试`);
      let result;
      try { result = await response.json(); }
      catch { throw new Error('Cubox 返回格式异常，提交结果未确认，请核对后重试'); }
      if (!result || ![200, '200'].includes(result.code)) {
        const code = /^\d{1,6}$/.test(String(result?.code)) ? `（代码 ${result.code}）` : '';
        throw new Error(`Cubox 未确认收藏${code}，请检查 API 配置、额度并核对收藏结果`);
      }
      this.saved.add(url);
    } finally { this.busy = false; this.controller = null; }
  }
  cancel() { this.controller?.abort(); }
}
module.exports = { Cubox, apiURL };
