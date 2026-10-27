const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { NetworkProxy, settings, proxyConfig } = require('../network-proxy.cjs');
const input = { mode: 'custom', address: 'http://127.0.0.1:7890', scope: 'selected', domains: 'v2ex.com\n*.v2ex.com' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = Array.from({ length: 2 }, () => ({
    configs: [], closed: 0, fail: false,
    webRequest: { onBeforeRequest(_filter, handler) { this.handler = handler; } },
    async setProxy(config) { this.configs.push(config); if (this.fail) { this.fail = false; throw Error('failure'); } },
    async closeAllConnections() { this.closed++; }
  }));
  const file = path.join(dir, 'proxy-settings.json');
  return { sessions, file, service: new NetworkProxy({ file, sessions }) };
}
test('proxy input validates protocols, ports, domain boundaries and rejects credentials or executable PAC input', () => {
  assert.deepEqual(settings(input).domains, ['v2ex.com']);
  assert.equal(settings({ ...input, address: 'socks5://[::1]:1080' }).address, 'socks5://[::1]:1080');
  assert.equal(settings({ ...input, address: 'HTTP://LOCALHOST:80/' }).address, 'http://localhost:80');
  for (const address of ['http://u:p@host:7890', 'http://host', 'ftp://host:21', 'file:///tmp/pac', 'http://host:0', 'http://host:65536', 'http://host:7890/path', 'http://host:7890?x=1', 'http://host:7890;direct://']) {
    assert.throws(() => settings({ ...input, address }));
  }
  for (const domains of ['*', 'https://v2ex.com', 'v2ex.com/path', 'host;DIRECT', 'evil\";return\"DIRECT', '-bad.test', 'v2ex..com', 'user@v2ex.com', '']) {
    assert.throws(() => settings({ ...input, domains }));
  }
});
test('PAC sends only exact domains and subdomains to the proxy, never substring lookalikes; all/system/direct are explicit', () => {
  for (const [address, expected] of [['http://127.0.0.1:7890', 'PROXY 127.0.0.1:7890'], ['https://host.test:443', 'HTTPS host.test:443'], ['socks5://127.0.0.1:1080', 'SOCKS5 127.0.0.1:1080']]) {
    const config = proxyConfig(settings({ ...input, address }));
    const context = vm.createContext({});
    vm.runInContext(Buffer.from(config.pacScript.split(',')[1], 'base64').toString(), context);
    for (const host of ['v2ex.com', 'www.v2ex.com', 'WWW.V2EX.COM', 'v2ex.com.']) assert.equal(context.FindProxyForURL('https://' + host, host), expected);
    for (const host of ['v2ex.com.evil.test', 'notv2ex.com', 'www.qireader.com']) assert.equal(context.FindProxyForURL('https://' + host, host), 'DIRECT');
  }
  assert.deepEqual(proxyConfig(settings({ ...input, scope: 'all' })), { mode: 'fixed_servers', proxyRules: input.address });
  assert.deepEqual(proxyConfig({ mode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(proxyConfig({ mode: 'system' }), { mode: 'system' });
});
test('both sessions are configured before network opens; configuration persists across restart without touching cookies', async t => {
  const { sessions, service, file } = fixture(t);
  let blocked;
  sessions[0].webRequest.handler({}, value => { blocked = value.cancel; }); assert.equal(blocked, true);
  await service.ready; assert.equal(service.active, true);
  await service.configure(input);
  assert.ok(sessions.every(ses => ses.closed === 2 && ses.configs.at(-1).mode === 'pac_script'));
  sessions[0].webRequest.handler({}, value => { blocked = value.cancel; }); assert.equal(blocked, false);
  const restored = new NetworkProxy({ file, sessions }); await restored.ready;
  assert.equal(restored.summary().mode, 'custom'); assert.deepEqual(restored.summary().domains, ['v2ex.com']);
  assert.equal(restored.active, true);
});
test('partial apply or file-write failures roll back both sessions; broken stored config blocks startup network until repaired', async t => {
  const { sessions, service, file } = fixture(t); await service.ready;
  sessions[1].fail = true;
  await assert.rejects(service.configure(input), /恢复原设置/);
  assert.equal(service.summary().mode, 'system');
  assert.ok(sessions.every(ses => ses.configs.at(-1).mode === 'system'));
  fs.mkdirSync(file + '.tmp');
  await assert.rejects(service.configure(input), /恢复原设置/);
  fs.rmdirSync(file + '.tmp');
  fs.writeFileSync(file, '{broken');
  const restored = new NetworkProxy({ file, sessions }); await restored.ready;
  assert.equal(restored.active, false);
  let blocked; sessions[0].webRequest.handler({}, value => { blocked = value.cancel; }); assert.equal(blocked, true);
  await restored.configure({ mode: 'direct', address: '', scope: 'selected', domains: '' });
  assert.equal(restored.active, true);
});

test('a failed rollback blocks further requests instead of silently using a partly applied proxy', async t => {
  const { service, sessions } = fixture(t); await service.ready;
  sessions[0].fail = true; sessions[1].fail = true;
  await assert.rejects(service.configure(input), /网络已暂停/);
  let blocked; sessions[0].webRequest.handler({}, value => { blocked = value.cancel; }); assert.equal(blocked, true);
  assert.equal(service.active, false);
  await service.configure({ mode: 'direct', address: '', scope: 'selected', domains: '' });
  assert.equal(service.active, true);
});

test('automatic routing tries only eligible direct connection failures and saves only after success', async t => {
  const { service, sessions, file } = fixture(t); await service.ready;
  assert.throws(() => settings({ ...input, autoLearn: 'yes' }));
  await service.configure({ ...input, domains: '', autoLearn: true });
  const failure = { code: 'ERR_CONNECTION_REFUSED' };
  const before = sessions[0].closed;
  let called = 0;
  assert.equal(await service.tryProxy('https://auto.test/article', failure, async () => {
    called++;
    assert.deepEqual(service.summary().domains, [], 'A trial must not yet be a saved rule');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).domains, []);
    await assert.rejects(service.configure(input), /尝试连接/);
    assert.equal(await service.tryProxy('https://another.test', failure, async () => true), false, 'No overlapping trials');
    return true;
  }), true);
  assert.equal(called, 1); assert.deepEqual(service.summary().domains, ['auto.test']);
  assert.equal(sessions[0].closed, before, 'Learning must not interrupt unrelated connections');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).domains, ['auto.test']);
  const restarted = new NetworkProxy({ sessions, file }); await restarted.ready;
  assert.equal(restarted.summary().autoLearn, true); assert.deepEqual(restarted.summary().domains, ['auto.test']);
  const unexpected = async () => { throw Error('Must not retry'); };
  for (const url of ['https://auto.test', 'https://sub.auto.test', 'https://127.0.0.1', 'http://localhost',
    'http://printer.local', 'http://foo.localhost', 'http://[::ffff:127.0.0.1]', 'https://u:p@new.test', 'file:///tmp/page']) {
    assert.equal(await service.tryProxy(url, failure, unexpected), false);
  }
  for (const code of ['ERR_ABORTED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_FAILED', 'ERR_PROXY_CONNECTION_FAILED', 'HTTP_403', 'HTTP_429']) {
    assert.equal(await service.tryProxy('https://other.test', { code }, unexpected), false);
  }
  await service.configure({ ...input, autoLearn: false });
  assert.equal(await service.tryProxy('https://other.test', failure, unexpected), false);
  await service.configure({ ...input, autoLearn: true, mode: 'direct' });
  assert.equal(await service.tryProxy('https://other.test', failure, unexpected), false);
});

test('failed proxy loads and failed persistence discard trial rules; failed restoration blocks network', async t => {
  const { service, sessions, file } = fixture(t); await service.ready;
  await service.configure({ ...input, autoLearn: true });
  const failure = { code: 'ERR_NAME_NOT_RESOLVED' };
  assert.equal(await service.tryProxy('https://fails.test', failure, async () => false), false);
  assert.deepEqual(service.summary().domains, ['v2ex.com']);
  const context = vm.createContext({});
  vm.runInContext(Buffer.from(sessions[0].configs.at(-1).pacScript.split(',')[1], 'base64').toString(), context);
  assert.equal(context.FindProxyForURL('https://fails.test', 'fails.test'), 'DIRECT');
  fs.mkdirSync(file + '.tmp');
  assert.equal(await service.tryProxy('https://save-fails.test', failure, async () => true), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).domains, ['v2ex.com']);
  assert.match(service.error, /保存/);
  fs.rmdirSync(file + '.tmp');
  assert.equal(await service.tryProxy('https://restore-fails.test', failure, async () => { sessions[0].fail = true; return false; }), false);
  assert.equal(service.active, false);
  let blocked; sessions[0].webRequest.handler({}, value => { blocked = value.cancel; }); assert.equal(blocked, true);
});
