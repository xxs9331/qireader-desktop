const fs = require('node:fs');
const { readerURL } = require('./policy.cjs');
const DAY = 86400000;
const SCAN_COOLDOWN = 30 * 60000;
const DAILY_PAGE_LIMIT = 100;

function boundaries(now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  return { today: +today, week: +week, tomorrow: +tomorrow };
}
function validEntry(entry) {
  return entry && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 512 &&
    Number.isSafeInteger(entry.crawledAt) && entry.crawledAt > 0;
}
function validGoal(goal) {
  return goal && typeof goal.automatic === 'boolean' && Number.isInteger(goal.target) && goal.target >= 1 && goal.target <= 10000;
}

class ReadingProgress {
  constructor({ file, fetch, onChange = () => {}, now = Date.now }) {
    this.file = file; this.fetch = fetch; this.onChange = onChange; this.now = now;
    this.data = { version: 1, accounts: {} }; this.active = null;
    this.loading = false; this.error = ''; this.revision = 0; this.changes = new Map();
    this.syncing = false;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts) ||
          !Object.values(data.accounts).every(account => Number.isFinite(account.startedAt) && Number.isFinite(account.updatedAt) &&
            (!account.goals || ['today', 'week'].every(period => !account.goals[period] || validGoal(account.goals[period]))) &&
            Array.isArray(account.entries) && account.entries.every(entry => validEntry(entry) && typeof entry.done === 'boolean' &&
              (entry.completedAt === undefined || (Number.isSafeInteger(entry.completedAt) && entry.completedAt > 0))))) {
        throw new Error('invalid progress file');
      }
      this.data = data;
      const limits = data.limits;
      if (limits && !['day', 'pages', 'nextScanAt', 'blockedUntil'].every(key => Number.isSafeInteger(limits[key]) && limits[key] >= 0)) {
        throw new Error('invalid request limits');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageError = '本地统计记录无法读取，原记录已保留';
    }
  }
  async get(origin, pathname, parameters = {}) {
    if (!readerURL(origin) || new URL(origin).origin !== origin) throw new Error('统计站点无效');
    const limits = this.data.limits || { day: 0, pages: 0, nextScanAt: 0, blockedUntil: 0 };
    if (limits.blockedUntil > this.now()) throw new Error(`统计请求已暂停至 ${new Date(limits.blockedUntil).toLocaleString()}；保留本地记录`);
    if (pathname.startsWith('/api/streams/')) {
      const day = boundaries(this.now()).today, pages = limits.day === day ? limits.pages : 0;
      if (pages >= DAILY_PAGE_LIMIT) throw new Error('今日统计列表请求已达本机保护上限（100 次），请明天同步；保留上次结果');
      this.persist({ ...this.data, limits: { ...limits, day, pages: pages + 1 } });
    }
    const url = new URL(pathname, origin); url.search = new URLSearchParams(parameters).toString();
    let response;
    try {
      response = await this.fetch(url.href, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json', 'x-api-version': '21.0.0' }, signal: AbortSignal.timeout(15000)
      });
    } catch { throw new Error('统计连接失败，请稍后重试'); }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const until = retry && /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry);
      const blockedUntil = Math.max(this.now() + DAY, Number.isFinite(until) ? until : 0);
      this.persist({ ...this.data, limits: { ...(this.data.limits || limits), blockedUntil } });
      throw new Error(`QiReader 请求限流，统计已暂停至 ${new Date(blockedUntil).toLocaleString()}；不会自动重试`);
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('请登录 QiReader 后同步统计'); error.auth = true; throw error;
    }
    if (!response.ok) throw new Error(`统计同步失败（HTTP ${response.status}）`);
    let body;
    try { body = await response.json(); } catch { throw new Error('统计接口格式变化，未更新计数'); }
    if (!body || !body.result || typeof body.result !== 'object') throw new Error('统计接口格式变化，未更新计数');
    return body.result;
  }
  async user(origin) {
    const user = await this.get(origin, '/api/session/user');
    if (typeof user.id !== 'string' || !user.id || user.id.length > 512) throw new Error('无法识别统计账号');
    return user.id;
  }
  async context(origin) {
    const user = await this.user(origin);
    const key = `${origin}|${user}`;
    this.active = key; this.onChange();
    const result = await this.get(origin, '/api/tags');
    if (!Array.isArray(result.tags)) throw new Error('稍后阅读标签格式变化');
    const tag = result.tags.find(tag => tag?.label === '!readlater');
    if (typeof tag?.id !== 'string' || !tag.id) throw new Error('未找到稍后阅读标签');
    return { origin, user, key, tag: tag.id };
  }
  save(key, entries, synced = false) {
    if (this.storageError) throw new Error(this.storageError);
    const previous = this.data.accounts[key];
    const completions = new Map((previous?.entries || []).map(entry => [entry.id, entry.completedAt]));
    const account = {
      ...previous,
      startedAt: previous?.startedAt || this.now(), updatedAt: synced ? this.now() : previous?.updatedAt || 0,
      entries: entries.map(entry => {
        const completedAt = entry.completedAt ?? completions.get(entry.id);
        return completedAt ? { ...entry, completedAt } : entry;
      })
    };
    this.persist({ ...this.data, accounts: { ...this.data.accounts, [key]: account } });
    this.onChange();
  }
  persist(data) {
    if (this.storageError) throw new Error(this.storageError);
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { throw new Error('统计记录保存失败，未更新计数'); }
    this.data = data;
  }
  fail(error) {
    if (error.auth) this.active = null;
    this.error = error.message; this.onChange();
  }
  setGoals(goals) {
    if (!goals || !Object.keys(goals).length || !Object.entries(goals).every(([period, goal]) =>
      ['today', 'week'].includes(period) && validGoal(goal))) throw new Error('目标须为 1–10000 的整数');
    const account = this.data.accounts[this.active];
    if (!account) throw new Error('请登录并等待统计初始化后设置目标');
    this.persist({ ...this.data, accounts: { ...this.data.accounts, [this.active]: {
      ...account, goals: { ...account.goals, ...Object.fromEntries(Object.entries(goals).map(([period, goal]) =>
        [period, { automatic: goal.automatic, target: goal.target }])) }
    } } });
    this.onChange();
  }
  async sync(origin, { manual = false } = {}) {
    if (this.syncing || this.loading) return;
    this.syncing = true; this.onChange();
    try {
      if (this.storageError) throw new Error(this.storageError);
      const user = await this.user(origin);
      this.active = `${origin}|${user}`;
      const updated = this.data.accounts[this.active]?.updatedAt;
      // shortcut: daily startup scan; use manual sync for changes made on other devices.
      if (!manual && updated && this.now() - updated < DAY) { this.error = ''; return; }
      const next = this.data.limits?.nextScanAt || 0;
      if (this.now() < next) {
        this.error = `全量统计同步冷却中，可于 ${new Date(next).toLocaleTimeString()} 后重试；保留本地记录`;
        return;
      }
      this.persist({ ...this.data, limits: { day: 0, pages: 0, blockedUntil: 0, ...this.data.limits, nextScanAt: this.now() + SCAN_COOLDOWN } });
      await this.refresh(origin);
    } catch (error) { this.fail(error); }
    finally { this.syncing = false; this.onChange(); }
  }
  async refresh(origin) {
    if (this.loading) return;
    this.loading = true; this.error = ''; this.onChange();
    const revision = this.revision, deadline = this.now() + 180000;
    try {
      if (this.storageError) throw new Error(this.storageError);
      const context = await this.context(origin);
      const entries = new Map(); let cursor;
      while (true) {
        if (this.now() >= deadline) throw new Error('统计分页超时，保留上次结果');
        const id = `tag-${context.tag}`;
        const page = await this.get(origin, `/api/streams/${encodeURIComponent(id)}`, {
          id, articleOrder: '0', unreadOnly: 'false', count: '100', ...(cursor === undefined ? {} : { olderThan: cursor })
        });
        if (!Array.isArray(page.entries) || typeof page.hasMore !== 'boolean') throw new Error('列表格式变化，保留上次结果');
        for (const entry of page.entries) {
          if (!validEntry(entry)) throw new Error('文章缺少收录时间，保留上次结果');
          entries.set(entry.id, { id: entry.id, crawledAt: entry.crawledAt, done: false });
        }
        if (!page.hasMore) break;
        const last = page.entries.at(-1)?.timestamp;
        if ((typeof last !== 'string' && !Number.isSafeInteger(last)) || !/^\d{1,40}$/.test(String(last)) ||
            (cursor !== undefined && BigInt(last) >= BigInt(cursor))) throw new Error('统计分页未前进，保留上次结果');
        cursor = String(last);
      }
      if (await this.user(origin) !== context.user) { this.active = null; throw new Error('账号已切换，请重新同步统计'); }
      for (const entry of this.data.accounts[context.key]?.entries || []) {
        if (!entries.has(entry.id)) entries.set(entry.id, { ...entry, done: true });
      }
      // Local confirmations newer than the scan must survive an older server page.
      for (const change of this.changes.values()) {
        if (change.key === context.key && change.revision > revision) entries.set(change.entry.id, change.entry);
      }
      this.save(context.key, [...entries.values()], true);
      this.changes.clear();
    } catch (error) { this.fail(error); }
    finally { this.loading = false; this.onChange(); }
  }
  async track(origin, id) {
    try {
      const context = await this.context(origin);
      let entry = this.data.accounts[context.key]?.entries.find(entry => entry.id === id);
      if (!entry) {
        entry = await this.get(origin, `/api/entry/${encodeURIComponent(id)}`, { entryId: id, streamId: `tag-${context.tag}` });
        if (!validEntry(entry) || entry.id !== id || !Array.isArray(entry.tagIds) || !entry.tagIds.includes(context.tag)) {
          throw new Error('未能记录这篇稍后阅读文章');
        }
      }
      if (await this.user(origin) !== context.user) { this.active = null; throw new Error('账号已切换，请重新选择文章'); }
      const record = { id, crawledAt: entry.crawledAt, done: false };
      this.record(context.key, record);
      return { key: context.key, origin, id, startedAt: this.now() };
    } catch (error) { this.fail(error); return null; }
  }
  async reconcile(origin, id) {
    try {
      const context = await this.context(origin);
      const entry = await this.get(origin, `/api/entry/${encodeURIComponent(id)}`, { entryId: id, streamId: `tag-${context.tag}` });
      if (!validEntry(entry) || entry.id !== id || !Array.isArray(entry.tagIds)) throw new Error('未能核对稍后阅读变更，保留本地记录');
      if (await this.user(origin) !== context.user) { this.active = null; throw new Error('账号已切换，请重新同步统计'); }
      const done = !entry.tagIds.includes(context.tag);
      const previous = this.data.accounts[context.key]?.entries.find(item => item.id === id);
      if (!done || previous) this.record(context.key, { id, crawledAt: entry.crawledAt, done,
        ...(done && !previous?.done ? { completedAt: this.now() } : {}) });
    } catch (error) { this.fail(error); }
  }
  record(key, entry) {
    const entries = (this.data.accounts[key]?.entries || []).filter(item => item.id !== entry.id);
    this.save(key, [...entries, entry]);
    this.changes.set(`${key}|${entry.id}`, { key, entry, revision: ++this.revision });
  }
  complete(token) {
    const entry = this.data.accounts[token.key]?.entries.find(entry => entry.id === token.id);
    if (!entry) return;
    const completedAt = entry.completedAt >= token.startedAt ? entry.completedAt : this.now();
    try { this.record(token.key, { ...entry, done: true, completedAt }); }
    catch (error) { this.fail(error); }
  }
  summary(period = 'today') {
    const account = this.data.accounts[this.active];
    const limits = boundaries(this.now()), from = period === 'week' ? limits.week : limits.today;
    const entries = account?.entries || [];
    const goal = account?.goals?.[period] || { automatic: period !== 'today', target: 100 };
    const automatic = period === 'all' || goal.automatic;
    const current = period === 'all' ? entries : entries.filter(entry => {
      const date = automatic ? entry.crawledAt : entry.completedAt;
      return date >= from && date < limits.tomorrow;
    });
    const done = automatic ? current.filter(entry => entry.done).length : current.length;
    const total = automatic ? current.length : goal.target;
    return {
      ready: automatic ? Boolean(account?.updatedAt) : Boolean(account), loading: this.loading || this.syncing, error: this.error || this.storageError || '',
      automatic, target: goal.target, total, done, remaining: Math.max(0, total - done), reached: done >= total && total > 0,
      older: period === 'all' || !automatic ? 0 : entries.filter(entry => entry.crawledAt < from && !entry.done).length,
      startedAt: account?.startedAt || 0, updatedAt: account?.updatedAt || 0
    };
  }
}
module.exports = { ReadingProgress, boundaries };
