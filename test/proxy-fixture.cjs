const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { session } = require('electron');

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const until = async (check, message) => {
  for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(message);
};
module.exports = async function proxyChecks(desktop, configure) {
  const { browserSession } = desktop, cuboxSession = session.fromPartition('cubox-api');
  const forwarded = [], tunnels = [], socksHosts = [], sockets = new Set();
  let directRequests = 0;
  let releaseTrial;
  const trialResponse = new Promise(resolve => { releaseTrial = resolve; });
  const direct = http.createServer((request, response) => {
    directRequests++; if (request.url === '/not-found') response.statusCode = 404;
    response.end('direct');
  });
  const proxy = http.createServer(async (request, response) => {
    forwarded.push(request.url);
    if (request.url.endsWith('/learn')) await trialResponse;
    if (request.url.endsWith('/reject')) response.statusCode = 503;
    response.end('proxied');
  });
  proxy.on('connect', (request, socket) => {
    tunnels.push(request.url); socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  const socks = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0), stage = 0;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 0])); stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        if (buffer[3] !== 3) { socket.destroy(); return; }
        const length = 7 + buffer[4]; if (buffer.length < length) return;
        socksHosts.push(buffer.subarray(5, 5 + buffer[4]).toString());
        buffer = buffer.subarray(length); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 2;
      }
      if (stage === 2 && buffer.includes('\r\n\r\n')) {
        stage = 3; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsocks');
      }
    });
  });
  try {
    const directPort = await listen(direct), proxyPort = await listen(proxy), socksPort = await listen(socks);
    await browserSession.cookies.set({ url: 'https://www.v2ex.com', name: 'test-session', value: 'retained', expirationDate: Date.now() / 1000 + 86400 });
    const input = { mode: 'custom', address: `http://127.0.0.1:${proxyPort}`, scope: 'selected', domains: 'v2ex.com\nproxied.test' };
    await configure(input);
    for (const ses of [browserSession, cuboxSession]) {
      assert.match(await ses.resolveProxy('https://www.v2ex.com/article'), new RegExp(`PROXY 127\\.0\\.0\\.1:${proxyPort}`));
      assert.equal(await ses.resolveProxy('https://v2ex.com.evil.test/article'), 'DIRECT');
      assert.equal(await ses.resolveProxy('https://unlisted.test/article'), 'DIRECT');
      assert.equal(await (await ses.fetch('http://proxied.test/article', { cache: 'no-store', signal: AbortSignal.timeout(3000) })).text(), 'proxied');
    }
    assert.ok(forwarded.every(url => url === 'http://proxied.test/article'));
    await assert.rejects(cuboxSession.fetch('https://proxied.test/article', { signal: AbortSignal.timeout(3000) }));
    assert.ok(tunnels.includes('proxied.test:443'), 'HTTPS request did not use CONNECT');
    assert.equal(await (await browserSession.fetch(`http://127.0.0.1:${directPort}/`, { cache: 'no-store' })).text(), 'direct');
    assert.equal(directRequests, 1);
    const unused = net.createServer(), unusedPort = await listen(unused);
    await new Promise(resolve => unused.close(resolve));
    await configure({ ...input, domains: '', autoLearn: true });
    const rc = desktop.reader.webContents;
    const choose = async (id, url) => {
      await rc.executeJavaScript(`history.replaceState({},'', '/tags/reading');addRow(${JSON.stringify(id)});document.querySelector('[data-is-entry="${id}"] a').href=${JSON.stringify(url)};document.querySelector('[data-is-entry="${id}"] a').click()`);
    };
    let directFailures = 0;
    desktop.original.webContents.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
      if (mainFrame && code !== -3 && url.includes('auto.test:')) directFailures++;
    });
    await choose('smart-auto', `http://auto.test:${unusedPort}/learn`);
    await until(() => forwarded.some(url => url.endsWith('/learn')), 'Direct failure did not retry the configured proxy');
    assert.equal(directFailures, 1);
    assert.deepEqual(desktop.networkProxy.summary().domains, [], 'A pending proxy load must not create a saved rule');
    releaseTrial();
    await until(() => desktop.networkProxy.summary().domains.includes('auto.test') && !desktop.original.webContents.isLoading(), 'Successful proxy load was not remembered');
    assert.equal(await desktop.original.webContents.executeJavaScript('document.body.textContent'), 'proxied');
    assert.match(await browserSession.resolveProxy('http://auto.test/article'), /PROXY /);
    assert.equal(await browserSession.resolveProxy('https://other.test/article'), 'DIRECT');
    const beforeReload = forwarded.length;
    await desktop.shellContents.executeJavaScript('desktop.command("original-reload")');
    await until(() => forwarded.length > beforeReload && !desktop.original.webContents.isLoading(), 'Remembered rule did not route the next visit through the proxy');
    assert.equal(directFailures, 1, 'Known domain should not fail direct again');
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Article selection did not finish');
    await choose('smart-reject', `http://failed.test:${unusedPort}/reject`);
    await until(() => desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("HTTP 503")'), 'Failed proxy response not reported');
    assert.deepEqual(desktop.networkProxy.summary().domains, ['auto.test'], 'HTTP failure via proxy must not be learned');
    assert.equal(await browserSession.resolveProxy('http://failed.test/article'), 'DIRECT');
    const before404 = forwarded.length;
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Failed selection did not finish');
    await choose('smart-not-found', `http://http404.test:${directPort}/not-found`);
    await until(() => desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("HTTP 404")'), 'Direct HTTP error not reported');
    assert.equal(forwarded.length, before404, 'HTTP errors must not trigger proxy retry');
    assert.deepEqual(desktop.networkProxy.summary().domains, ['auto.test']);
    console.log('PASS: real article direct failure retries once via proxy, learns only after 200, remembered next visit, failed proxy rolls back, HTTP errors stay direct');
    await configure({ ...input, address: `socks5://127.0.0.1:${socksPort}` });
    assert.equal(await (await browserSession.fetch('http://proxied.test/socks', { cache: 'no-store', signal: AbortSignal.timeout(3000) })).text(), 'socks');
    assert.ok(socksHosts.includes('proxied.test'), 'SOCKS5 did not pass hostname to proxy');
    await configure({ ...input, scope: 'all' });
    assert.match(await browserSession.resolveProxy('https://unlisted.test/article'), /PROXY /);
    await configure({ ...input, mode: 'system' });
    assert.equal(desktop.networkProxy.summary().mode, 'system');
    await configure({ ...input, mode: 'direct' });
    assert.equal(await browserSession.resolveProxy('https://v2ex.com/article'), 'DIRECT');
    const cookies = await browserSession.cookies.get({ url: 'https://www.v2ex.com', name: 'test-session' });
    assert.equal(cookies[0]?.value, 'retained', 'Switching proxies cleared site login storage');
    console.log('PASS: selected-domain HTTP/HTTPS CONNECT and SOCKS5 routing, other sites direct, system/all/direct modes, both sessions and V2EX cookie retention');
  } finally {
    releaseTrial();
    for (const socket of sockets) socket.destroy();
    for (const server of [direct, proxy, socks]) { server.closeAllConnections?.(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
};
