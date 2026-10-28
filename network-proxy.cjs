const fs = require('node:fs');
const path = require('node:path');
const { domainToASCII } = require('node:url');
const { isIP } = require('node:net');
const connectionErrors = new Set(['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_ADDRESS_UNREACHABLE',
  'ERR_FAILED', 'ERR_EMPTY_RESPONSE', 'ERR_CONNECTION_ABORTED', 'ERR_SSL_PROTOCOL_ERROR',
  'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_QUIC_PROTOCOL_ERROR', 'ERR_CONTENT_LENGTH_MISMATCH', 'ERR_INCOMPLETE_CHUNKED_ENCODING']);

function settings(value) {
  if (!value || !['system', 'direct', 'custom'].includes(value.mode) || !['selected', 'all'].includes(value.scope) ||
      typeof value.address !== 'string' || value.address.length > 2048 || typeof value.domains !== 'string' || value.domains.length > 8000 ||
      (value.autoLearn !== undefined && typeof value.autoLearn !== 'boolean')) {
    throw new Error('请检查代理设置');
  }
  let address = value.address.trim();
  if (address) {
    const match = address.match(/^(https?|socks5):\/\/(\[[^\]]+\]|[^/:?#@\\\s]+):(\d{1,5})\/?$/i);
    if (!match || +match[3] < 1 || +match[3] > 65535) throw new Error('代理地址须包含协议和端口，例如 http://127.0.0.1:7890；不支持账号密码');
    try { const url = new URL(address); address = `${url.protocol}//${url.hostname}:${Number(match[3])}`; }
    catch { throw new Error('代理地址无效'); }
  }
  const domains = [...new Set(value.domains.split(/[\s,，]+/).filter(Boolean).map(item => {
    const domain = domainToASCII(item.replace(/^\*\./, '').replace(/\.$/, '')).toLowerCase();
    if (!domain || domain.length > 253 || !domain.split('.').every(label =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || /[/:@?#\\]/.test(item)) {
      throw new Error('站点请填写域名，例如 v2ex.com，不要包含协议或路径');
    }
    return domain;
  }))];
  if (domains.length > 100) throw new Error('最多设置 100 个代理域名');
  if (value.mode === 'custom' && !address) throw new Error('请填写代理地址');
  if (value.mode === 'custom' && value.scope === 'selected' && !domains.length && !value.autoLearn) throw new Error('请填写需要代理的站点域名，或开启自动添加');
  return { mode: value.mode, address, scope: value.scope, domains, autoLearn: value.autoLearn === true };
}

function proxyConfig(value) {
  if (value.mode !== 'custom') return { mode: value.mode };
  if (value.scope === 'all') return { mode: 'fixed_servers', proxyRules: value.address };
  const url = new URL(value.address);
  const type = { 'http:': 'PROXY', 'https:': 'HTTPS', 'socks5:': 'SOCKS5' }[url.protocol];
  const port = value.address.slice(value.address.lastIndexOf(':') + 1);
  const route = `${type} ${url.hostname}:${port}`;
  const script = `function FindProxyForURL(url, host) {
    host = host.toLowerCase().replace(/\\.$/, '');
    var domains = ${JSON.stringify(value.domains)};
    for (var i = 0; i < domains.length; i++) {
      if (host === domains[i] || host.slice(-domains[i].length - 1) === '.' + domains[i]) return ${JSON.stringify(route)};
    }
    return 'DIRECT';
  }`;
  return { mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString('base64')}` };
}

class NetworkProxy {
  constructor({ file, sessions }) {
    this.file = file; this.sessions = sessions;
    this.logFile = path.join(path.dirname(file), 'network.log');
    this.config = { mode: 'system', address: '', scope: 'selected', domains: [], autoLearn: false };
    this.active = false; this.busy = false; this.learning = false; this.error = '';
    for (const ses of sessions) ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
      callback({ cancel: this.busy || !this.active });
    });
    this.ready = this.start();
  }
  async start() {
    try {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.domains)) throw new Error('Invalid proxy settings');
        this.config = settings({ ...data, domains: data.domains.join('\n') });
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('本机代理配置无法读取，请在设置中重新保存');
      }
      await this.apply(this.config); this.active = true;
    } catch (error) { this.error = error.message; }
  }
  async apply(value, closeConnections = true) {
    for (const ses of this.sessions) await ses.setProxy(proxyConfig(value));
    if (closeConnections) for (const ses of this.sessions) await ses.closeAllConnections();
  }
  save(value) {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...value }), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  log(event, url, details = {}) {
    try {
      const entry = { time: new Date().toISOString(), event, host: new URL(url).hostname };
      if (/^ERR_[A-Z0-9_]+$/.test(details.code)) entry.code = details.code;
      if (Number.isInteger(details.status)) entry.status = details.status;
      if (['direct', 'proxy', 'system'].includes(details.route)) entry.route = details.route;
      for (const key of ['page', 'attempt', 'elapsedMs']) if (Number.isSafeInteger(details[key]) && details[key] >= 0) entry[key] = details[key];
      if (['foreground', 'pool'].includes(details.stage)) entry.stage = details.stage;
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size >= 1024 * 1024) fs.renameSync(this.logFile, this.logFile + '.1');
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch { /* Logging must not interrupt reading. */ }
  }
  route(url) {
    if (this.config.mode !== 'custom') return this.config.mode;
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return this.config.scope === 'all' || this.config.domains.some(domain => host === domain || host.endsWith('.' + domain)) ? 'proxy' : 'direct';
  }
  retryHost(url) {
    const value = this.config;
    if (!this.active || this.busy || value.mode !== 'custom' || value.scope !== 'selected' ||
        !value.autoLearn || value.domains.length >= 100) return null;
    try {
      const target = new URL(url), host = target.hostname.toLowerCase().replace(/\.$/, '');
      if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && host.includes('.') &&
          !host.startsWith('[') && !isIP(host) && !host.endsWith('.localhost') && !host.endsWith('.local') && this.route(url) === 'direct') return host;
    } catch {}
    return null;
  }
  async tryProxy(url, error, retry) {
    await this.ready;
    const previous = this.config;
    const host = this.retryHost(url);
    if (this.learning || !host || !connectionErrors.has(error.code)) { this.log('proxy-skipped', url, { code: error.code }); return false; }
    let candidate;
    try {
      candidate = settings({ ...previous, domains: [...previous.domains, host].join('\n') });
    } catch { return false; }
    this.learning = true; this.error = '';
    this.log('proxy-trial', url, { code: error.code, route: 'proxy' });
    try {
      // Leave unrelated in-flight requests alone when trying a single failed host.
      await this.apply(candidate, false);
      if (!await retry()) { this.log('proxy-failed', url, { route: 'proxy' }); return false; }
      this.log('proxy-success', url, { route: 'proxy' });
      this.save(candidate); this.config = candidate; this.error = '';
      this.log('rule-saved', url, { route: 'proxy' });
      return true;
    } catch {
      this.log('proxy-apply-or-save-failed', url);
      this.error = '自动代理未能应用或保存，请在设置中手动添加域名';
      return false;
    } finally {
      if (this.config === previous) {
        try { await this.apply(previous, false); }
        catch { this.active = false; this.error = '代理恢复失败，网络已暂停；请重新保存有效设置'; this.log('proxy-rollback-failed', url); }
      }
      this.learning = false;
    }
  }
  summary() { return { ...this.config, domains: [...this.config.domains], active: this.active, busy: this.busy || this.learning, error: this.error }; }
  async configure(input) {
    await this.ready;
    if (this.busy || this.learning) throw new Error('代理设置正在应用或尝试连接，请稍候');
    const value = settings(input), previous = this.config, wasActive = this.active;
    this.busy = true;
    try {
      await this.apply(value);
      this.save(value);
      this.config = value; this.active = true; this.error = '';
    } catch {
      try { if (wasActive) { await this.apply(previous); this.active = true; } else this.active = false; }
      catch { this.active = false; }
      this.error = this.active ? '代理设置应用或保存失败，已恢复原设置' : '代理设置未能应用，网络已暂停；请重新保存有效设置';
      throw new Error(this.error);
    } finally { this.busy = false; }
  }
}
module.exports = { NetworkProxy, settings, proxyConfig };
