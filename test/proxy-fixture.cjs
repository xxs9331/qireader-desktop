const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { session } = require('electron');

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const until = async (check, message, attempts = 120) => {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(message);
};
module.exports = async function proxyChecks(desktop, configure) {
  const { browserSession } = desktop, cuboxSession = session.fromPartition('cubox-api');
  const loggedBefore = fs.existsSync(desktop.networkProxy.logFile) ? fs.readFileSync(desktop.networkProxy.logFile, 'utf8').trim().split('\n').length : 0;
  const readLogs = () => fs.readFileSync(desktop.networkProxy.logFile, 'utf8').trim().split('\n').slice(loggedBefore).map(JSON.parse);
  const forwarded = [], tunnels = [], socksHosts = [], sockets = new Set();
  const directPaths = new Map();
  let directRequests = 0;
  let releaseTrial;
  const trialResponse = new Promise(resolve => { releaseTrial = resolve; });
  const direct = http.createServer((request, response) => {
    directRequests++; if (request.url === '/not-found') response.statusCode = 404;
    directPaths.set(request.url, (directPaths.get(request.url) || 0) + 1);
    if (['/stall', '/slow-document', '/minute'].includes(request.url)) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><html><body><h1>Incomplete document');
      if (request.url === '/slow-document') setTimeout(() => response.end('</h1></body></html>'), 3200);
      return;
    }
    response.end('direct');
  });
  const proxy = http.createServer(async (request, response) => {
    forwarded.push(request.url);
    if (request.url.endsWith('/minute')) return;
    if (request.url.endsWith('/learn')) await trialResponse;
    if (request.url.endsWith('/stall')) await new Promise(resolve => setTimeout(resolve, 2500));
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
    const directFailures = () => readLogs()
      .filter(entry => entry.host === 'auto.test' && entry.event === 'load-failed' && entry.route === 'direct').length;
    await choose('smart-auto', `http://auto.test:${unusedPort}/learn`);
    await until(() => forwarded.some(url => url.endsWith('/learn')), 'Direct failure did not retry the configured proxy');
    assert.equal(directFailures(), 1);
    assert.deepEqual(desktop.networkProxy.summary().domains, [], 'A pending proxy load must not create a saved rule');
    releaseTrial();
    await until(() => desktop.networkProxy.summary().domains.includes('auto.test') && desktop.original.webContents.getURL().endsWith('/learn') && !desktop.original.webContents.isLoading(), 'Successful proxy load was not remembered');
    assert.equal(await desktop.original.webContents.executeJavaScript('document.body.textContent'), 'proxied');
    assert.match(await browserSession.resolveProxy('http://auto.test/article'), /PROXY /);
    assert.equal(await browserSession.resolveProxy('https://other.test/article'), 'DIRECT');
    const beforeReload = forwarded.length;
    await desktop.shellContents.executeJavaScript('desktop.command("original-reload")');
    await until(() => forwarded.length > beforeReload && !desktop.original.webContents.isLoading(), 'Remembered rule did not route the next visit through the proxy');
    assert.equal(directFailures(), 1, 'Known domain should not fail direct again');
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Article selection did not finish');
    await choose('smart-reject', `http://failed.test:${unusedPort}/reject`);
    await until(async () => !desktop.networkProxy.learning && await desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("HTTP 503")'), 'Failed proxy response or routing rollback did not finish');
    assert.deepEqual(desktop.networkProxy.summary().domains, ['auto.test'], 'HTTP failure via proxy must not be learned');
    assert.equal(await browserSession.resolveProxy('http://failed.test/article'), 'DIRECT');
    const before404 = forwarded.length;
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Failed selection did not finish');
    await choose('smart-not-found', `http://http404.test:${directPort}/not-found`);
    await until(() => desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("HTTP 404")'), 'Direct HTTP error not reported');
    assert.equal(forwarded.length, before404, 'HTTP errors must not trigger proxy retry');
    assert.deepEqual(desktop.networkProxy.summary().domains, ['auto.test']);
    console.log('PASS: real article direct failure retries once via proxy, learns only after 200, remembered next visit, failed proxy rolls back, HTTP errors stay direct');
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'HTTP error selection did not finish');
    const started = Date.now();
    await choose('smart-stall', `http://stall.test:${directPort}/stall`);
    await until(() => desktop.networkProxy.summary().domains.includes('stall.test') && desktop.original.webContents.getURL().endsWith('/stall') && !desktop.original.webContents.isLoading(), 'Stalled preparation did not retry after 5 seconds', 240);
    assert.ok(Date.now() - started >= 7400, 'Preparation must allow the full five-second direct attempt');
    assert.equal(forwarded.filter(url => url.endsWith('/stall')).length, 1, 'Stalled document should retry only once');
    assert.equal(await desktop.original.webContents.executeJavaScript('document.body.textContent'), 'proxied');
    const log = readLogs();
    const attempt = log.find(entry => entry.host === 'stall.test' && entry.event === 'load-start' && entry.route === 'direct');
    const trial = log.find(entry => entry.host === 'stall.test' && entry.event === 'proxy-trial');
    const delay = Date.parse(trial.time) - Date.parse(attempt.time);
    assert.ok(delay >= 4900 && delay < 6500, `Direct fallback should start at about 5 seconds, actual ${delay}ms`);
    for (const event of ['response', 'document-timeout', 'proxy-trial', 'document-ready', 'proxy-success', 'rule-saved']) {
      assert.ok(log.some(entry => entry.host === 'stall.test' && entry.event === event), 'Missing diagnostic event: ' + event);
    }
    assert.ok(log.some(entry => entry.host === 'stall.test' && entry.event === 'response' && entry.status === 200 && entry.route === 'direct'));
    assert.ok(log.some(entry => entry.host === 'stall.test' && entry.event === 'document-timeout' && entry.route === 'direct'));
    assert.ok(log.some(entry => entry.host === 'stall.test' && entry.event === 'prepare-slow' && entry.elapsedMs >= 1900));
    console.log('PASS: hidden preparation marks slow at 2 seconds, switches at 5 seconds, learns only after ready, complete redacted log chain');

    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Stall selection did not settle');
    await choose('warm-anchor', `http://warm.test:${directPort}/anchor`);
    await until(() => desktop.original.webContents.getURL().endsWith('/anchor') && !desktop.original.webContents.isLoading(), 'Warm anchor did not open');
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Warm anchor selection did not settle');
    const slowURL = `http://background.test:${directPort}/slow-document`;
    const stalledURL = `http://background-stall.test:${directPort}/stall`;
    const stallsBefore = directPaths.get('/stall') || 0, forwardedBefore = forwarded.length;
    await rc.executeJavaScript(`
      addRow('background-slow').querySelector('a').href=${JSON.stringify(slowURL)};
      addRow('background-stall').querySelector('a').href=${JSON.stringify(stalledURL)};
    `);
    await until(() => desktop.preloaded.has(slowURL) && desktop.preloaded.has(stalledURL), 'Slow background pages were not prefetched');
    const slowPage = desktop.preloaded.get(slowURL), stalledPage = desktop.preloaded.get(stalledURL);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(slowPage.failed, false, 'Background document was cancelled by the foreground two-second limit');
    assert.equal(stalledPage.failed, false, 'Incomplete background document was prematurely cancelled');
    assert.equal(forwarded.length, forwardedBefore, 'Background work must not trigger proxy retries');
    await until(() => slowPage.ready, 'A 3.2-second background document did not finish');
    await rc.executeJavaScript('document.querySelector(\'[data-is-entry="background-slow"] a\').click()');
    await until(() => desktop.original === slowPage.view && desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Completed slow preload was not reused');
    assert.equal(directPaths.get('/slow-document'), 1, 'Selecting a completed slow preload must not reload it');

    assert.equal(await desktop.navigationContents.executeJavaScript('document.getElementById("next").disabled'), true, 'Pending article must not be available in the foreground');
    assert.equal(desktop.original, slowPage.view);
    await until(() => desktop.networkProxy.summary().domains.includes('background-stall.test') && stalledPage.ready, 'Background preparation did not finish through proxy', 200);
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Ready article did not enable next');
    await desktop.navigationContents.executeJavaScript('document.getElementById("next").click()');
    await until(() => desktop.original === stalledPage.view, 'Ready prepared page was not promoted');
    assert.equal(directPaths.get('/stall'), stallsBefore + 1, 'Preparation must keep the existing direct request');
    assert.equal(forwarded.length, forwardedBefore + 1, 'Background preparation should retry the proxy exactly once');
    const backgroundLog = readLogs();
    const timeout = backgroundLog.find(entry => entry.host === 'background-stall.test' && entry.event === 'document-timeout');
    const backgroundWait = Date.parse(timeout.time) - stalledPage.startedAt;
    assert.ok(backgroundWait >= 4900 && backgroundWait < 6500, `Background proxy threshold must be five seconds, actual ${backgroundWait}ms`);
    assert.equal(backgroundLog.filter(entry => entry.host === 'background-stall.test' && entry.event === 'load-start' && entry.route === 'direct').length, 1);
    console.log('PASS: background survives 2 seconds, completed preload reuses one request, pending pages stay hidden until proxy preparation finishes');

    if (process.env.QIREADER_TEST_PHASE === 'budget') {
    await until(() => desktop.navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Ready selection did not settle');
    const foreground = desktop.original;
    const minuteURL = `http://minute.test:${directPort}/minute`, secondMinuteURL = `http://minute-second.test:${directPort}/minute`;
    await choose('minute-budget', minuteURL);
    await until(() => desktop.preloaded.has(minuteURL), 'Minute preparation did not start');
    const minutePage = desktop.preloaded.get(minuteURL);
    const minuteContents = minutePage.view.webContents;
    await rc.executeJavaScript(`addRow('minute-second').querySelector('a').href=${JSON.stringify(secondMinuteURL)}`);
    await until(() => desktop.preloaded.has(secondMinuteURL), 'Second bounded preparation did not start');
    const secondMinute = desktop.preloaded.get(secondMinuteURL);
    const secondMinuteContents = secondMinute.view.webContents;
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(desktop.original, foreground, 'Stalled preparation must not replace the readable article');
    assert.ok(desktop.preloaded.size <= 2);
    await until(() => minuteContents.isDestroyed() && secondMinuteContents.isDestroyed(), 'One-minute budget did not stop and release pending/queued attempts', 1300);
    assert.ok(Date.now() - minutePage.startedAt >= 59000 && Date.now() - minutePage.startedAt < 65000);
    await until(() => !desktop.networkProxy.learning, 'Expired proxy trial did not restore routing');
    assert.equal(desktop.original, foreground);
    assert.equal(desktop.networkProxy.summary().domains.some(host => host.startsWith('minute')), false, 'Expired trial must never save a domain');
    assert.ok(forwarded.filter(url => url.endsWith('/minute')).length <= 2, 'Each article may try the proxy only once');
    const trials = readLogs()
      .filter(entry => entry.host.startsWith('minute') && entry.event === 'proxy-trial');
    if (trials.length === 2) assert.ok(Date.parse(trials[1].time) - Date.parse(trials[0].time) >= 54000, 'Proxy trials must not overlap');
    console.log('PASS: real 60-second total budget includes serialized proxy wait; both slots released, current article retained, no failed rules saved');
    }
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
