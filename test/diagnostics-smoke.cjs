const { app, session, shell, dialog, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWindow } = require('../main.cjs');
const profile = process.env.QIREADER_TEST_PROFILE ? path.join(process.env.QIREADER_TEST_PROFILE, 'diagnostics') : fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-debug-test-'));
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let n = 0; n < 150; n++) { if (await check()) return; await pause(50); }
  throw Error(label);
}
(async () => {
  await app.whenReady();
  const ses = session.fromPartition('persist:qireader-desktop');
  let challenge = true;
  ses.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.hostname.includes('qireader')) {
      if (url.pathname.startsWith('/api/')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
      return new Response('<!doctype html><title>Reader fixture</title><div data-is-entry="a" tabindex="0"><a data-is-entry-title href="https://www.huxiu.com/article/123.html">Article</a></div><div data-is-entry="b" tabindex="0"><a data-is-entry-title href="https://www.huxiu.com/article/404.html">Missing</a></div><input type="password" value="NEVER_LOG_THIS_PASSWORD"><div data-focus-container="articleView"></div>', { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.includes('404')) return new Response('<title>Missing</title><h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(challenge ? '<meta charset="utf-8"><title>安全验证 - 虎嗅</title><h1>请完成验证</h1><button>验证</button>' : '<meta charset="utf-8"><title>Readable article</title><h1>Article</h1><p>正文</p><button id="article-button">Action</button>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const desktop = createWindow(), rc = desktop.reader.webContents;
  const logs = () => [desktop.networkProxy.logFile + '.1', desktop.networkProxy.logFile].filter(file => fs.existsSync(file)).flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  await until(() => !rc.isLoading() && rc.getURL().includes('qireader'), 'reader did not load');
  await rc.executeJavaScript('document.querySelector("[data-is-entry=a] a").click()');
  await until(() => desktop.original.webContents.getURL().includes('/article/123.html'), 'verification not shown');
  await until(() => desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("完成网站验证")'), 'verification not explained');
  assert(logs().some(row => row.event === 'verification-required'));
  assert.equal(await rc.executeJavaScript('!!document.querySelector("[data-is-entry=a]")'), true);
  challenge = false;
  await rc.executeJavaScript('document.querySelector("[data-is-entry=a] a").click()');
  await until(() => desktop.original.webContents.executeJavaScript('document.title === "Readable article"'), 'verification recovery failed');
  const original = desktop.original.webContents;
  await original.executeJavaScript('document.getElementById("article-button").click()');
  await original.executeJavaScript('void window.open("https://www.huxiu.com/login", "login-test")');
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('/login')), 'login popup missing');
  const popup = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/login'));
  await until(() => !popup.webContents.isLoading(), 'popup not loaded');
  await popup.webContents.executeJavaScript('document.getElementById("article-button").click()');
  popup.destroy();
  await rc.executeJavaScript('document.querySelector("input").click()');
  await desktop.shellContents.executeJavaScript('document.getElementById("settings").click()');
  await until(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === '设置'), 'settings missing');
  const settings = BrowserWindow.getAllWindows().find(win => win.getTitle() === '设置');
  await until(() => !settings.webContents.isLoading(), 'settings did not load');
  const destination = path.join(profile, 'export.jsonl');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  await settings.webContents.executeJavaScript('document.getElementById("export-logs").click()');
  await until(() => fs.existsSync(destination), 'export missing');
  settings.destroy();
  await rc.executeJavaScript('document.querySelector("[data-is-entry=b] a").click()');
  await until(() => desktop.shellContents.executeJavaScript('document.getElementById("error").textContent.includes("404")'), '404 missing');
  let external;
  shell.openExternal = async url => { external = url; };
  await desktop.shellContents.executeJavaScript('document.getElementById("external").click()');
  await until(() => external, 'external action missing');
  assert.equal(external, 'https://www.huxiu.com/article/404.html', 'External must open the failed article, not the previous one');
  const records = logs();
  for (const pane of ['reader', 'original', 'shell', 'settings', 'popup']) assert(records.some(row => row.event === 'click' && row.pane === pane), 'missing click ' + pane);
  assert(records.every((row, index) => !index || row.sequence > records[index - 1].sequence), 'log sequence must preserve event order');
  assert(records.some(row => row.event === 'request-completed' && row.status === 404));
  assert.equal(JSON.stringify(records).includes('NEVER_LOG_THIS_PASSWORD'), false);
  assert(fs.readFileSync(destination, 'utf8').includes('verification-required'));
  console.log('PASS: desktop all-pane clicks, network errors, verification retained/displayed/recovered, failed URL external opening, private input exclusion and log export');
  desktop.win.destroy();
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
