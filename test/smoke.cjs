const { app, session, ipcMain, desktopCapturer, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWindow } = require('../main.cjs');

app.setPath('userData', process.env.QIREADER_TEST_PROFILE);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(75); }
  throw new Error(message);
}
const readerHTML = `<!doctype html><meta charset="utf-8"><title>QiReader 测试页面</title>
<style>body{font:18px sans-serif;padding:28px;color:#303444}button{padding:16px;margin:8px}article{padding:24px;background:#f5f3fa}</style>
<h1>稍后阅读 · 模拟页面</h1><p>这里测试文章切换，不连接真实账号。</p>
<div data-focus-container="entryList">
<div data-is-entry="a" tabindex="0" onclick="selectArticle('a')" onpointerdown="window.nativeTap=true"><a data-is-entry-title href="https://www.zhihu.com/question/a">文章 A</a><button onclick="event.stopPropagation();window.actionClicked=true">收藏</button></div>
<div data-is-entry="b" tabindex="0" onclick="selectArticle('b')"><a data-is-entry-title href="https://www.zhihu.com/question/b">文章 B</a></div>
</div>
<div data-focus-container="articleView"></div>
<script>
window.removeCalls = [];
window.addRow = id => {
  const row = document.createElement('div');row.tabIndex=0;row.setAttribute('data-is-entry',id);
  row.innerHTML='<a data-is-entry-title href="https://www.zhihu.com/question/'+id+'">文章 '+id+'</a>';
  document.querySelector('[data-focus-container="entryList"]').append(row);return row;
};
document.addEventListener('keydown', async event => {
  const row=event.target.closest('[data-is-entry]');
  if(event.key!=='y'||!row)return;
  const id=row.getAttribute('data-is-entry');window.removeCalls.push(id);
  const parent=row.parentElement;row.remove();
  const response=await fetch('/api/entries/saved/'+id+'/tags/later',{method:'DELETE'});
  if(!response.ok)parent.append(row);
});
window.selectArticle = (id, delay = 0) => {
  history.pushState({}, '', '/tags/!readlater/entries/' + id);
  setTimeout(() => document.querySelector('[data-focus-container="articleView"]').innerHTML =
    '<article data-article-url="https://www.zhihu.com/question/' + id + '"><h1>文章 ' + id + '</h1><p>QiReader 原生正文区域暂时保留。</p></article>', delay);
};
</script>`;

(async () => {
  await app.whenReady();
  const browserSession = session.fromPartition('persist:qireader-desktop');
  const confirmedRemovals = [];
  const originalRequests = new Map();
  let releaseThird;
  const thirdResponse = new Promise(resolve => { releaseThird = resolve; });
  const capturedToday = new Date(); capturedToday.setHours(0, 0, 0, 0);
  const statsEntries = ['a', 'b', 'c', 'success', 'success-two', 'reject', 'network-fail', 'not-found', 'recycled'].map(id =>
    ({ id, crawledAt: +capturedToday + 1000, timestamp: '9007199254740993999', tagIds: ['later'], status: 1 }));
  statsEntries.push({ id: 'older', crawledAt: +capturedToday - 86400000, timestamp: '9007199254740993998', tagIds: ['later'], status: 1 });
  let statsStatus = 200, streamRequests = 0, nativePages = 0, nativePageStatus = 200;
  let holdTracking = false, releaseTracking, releaseImage;
  let holdRemoval = false, releaseRemoval;
  const removalResponse = new Promise(resolve => { releaseRemoval = resolve; });
  const trackingResponse = new Promise(resolve => { releaseTracking = resolve; });
  const imageResponse = new Promise(resolve => { releaseImage = resolve; });
  await browserSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'www.qireader.com' && url.pathname === '/api/streams/test-pagination') {
      nativePages++;
      await pause(200);
      return Response.json({ entries: ['page-one', 'page-two', 'page-three'] }, { status: nativePageStatus });
    }
    if (request.method === 'DELETE') {
      const id = url.pathname.split('/').at(-3);
      if (['success', 'success-two'].includes(id) && holdRemoval) await removalResponse;
      await pause(500);
      if(id === 'reject') return new Response('{}', {status:503});
      confirmedRemovals.push(id);
      return new Response('{}', {status:200});
    }
    if (url.hostname === 'www.qireader.com' && url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/streams/')) streamRequests++;
      if (statsStatus !== 200) return Response.json({}, { status: statsStatus });
      let result;
      if (url.pathname === '/api/session/user') result = { id: 'smoke-account' };
      else if (url.pathname === '/api/tags') {
        if (holdTracking) await trackingResponse;
        result = { tags: [{ id: 'later', label: '!readlater' }] };
      }
      else if (url.pathname.startsWith('/api/entry/')) result = statsEntries.find(entry => entry.id === decodeURIComponent(url.pathname.split('/').at(-1)));
      else if (url.pathname === '/api/streams/tag-later') result = {
        entries: statsEntries.filter(entry => !confirmedRemovals.includes(entry.id) &&
          !(process.env.QIREADER_TEST_PHASE === 'restart' && ['success', 'success-two'].includes(entry.id))), hasMore: false
      };
      else throw new Error(`Unexpected stats endpoint: ${url.pathname}`);
      return Response.json({ result });
    }
    if (url.hostname === 'www.qireader.com') return new Response(readerHTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    originalRequests.set(url.pathname, (originalRequests.get(url.pathname) || 0) + 1);
    if (url.pathname === '/slow-image') { await imageResponse; return new Response('', { headers: { 'content-type': 'image/png' } }); }
    if (url.pathname === '/question/pre-three') await thirdResponse;
    if (url.pathname === '/failure' || url.pathname === '/question/network-fail') return Response.error();
    if (['/question/not-found','/question/pre-fail'].includes(url.pathname)) return new Response('Not found', {status:404});
    if (url.pathname === '/question/recycled') await pause(400);
    return new Response(`<!doctype html><meta charset="utf-8"><title>原文测试</title><style>body{font:20px sans-serif;padding:40px;line-height:1.8}</style><h1>原文 ${url.pathname}</h1><p>独立网页视图 · 模拟知乎原文</p>${url.pathname === '/question/success' ? '<img src="/slow-image">' : ''}<textarea placeholder="评论输入框"></textarea>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const desktop = createWindow();
  let clock = +capturedToday + 12 * 3600000;
  desktop.progress.now = () => clock;
  const { win, shellContents, navigationContents, navigation, reader, preloaded } = desktop;
  const rc = reader.webContents;
  const oc = () => desktop.original.webContents;
  async function restoreTestWindow() {
    win.restore(); win.show(); win.setSize(1500, 960); win.focus();
    await until(() => win.getContentSize().every(size => size > 0), 'Test window did not restore');
    await until(() => shellContents.executeJavaScript('innerWidth').then(width => width === win.getContentSize()[0]), 'Toolbar viewport did not follow the restored window');
  }
  async function openTestSettings() {
    await shellContents.executeJavaScript('document.getElementById("settings").click()');
    await until(() => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith('/settings.html')), 'Unified settings did not open');
    const settings = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
    await until(() => settings.webContents.executeJavaScript('Boolean(window.desktop) && document.getElementById("today-target").value !== ""'), 'Unified settings did not initialize');
    return settings;
  }
  async function pressKey(contents, keyCode, modifiers = []) {
    const owner = BrowserWindow.fromWebContents(contents) || win;
    owner.focus(); contents.focus();
    await until(async () => owner.isFocused() && contents.isFocused() && await contents.executeJavaScript('document.hasFocus()'), 'Keyboard test target did not receive focus');
    await until(() => contents.executeJavaScript('document.visibilityState === "visible"'), 'Keyboard target remained a hidden document');
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  async function pressFocusedKey(keyCode, modifiers = []) {
    await until(() => webContents.getFocusedWebContents() === oc() && oc().executeJavaScript('document.hasFocus()'), 'Reading did not acquire focus without a click');
    const contents = webContents.getFocusedWebContents();
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  async function switchBackToReader() {
    const other = new BrowserWindow({ width: 400, height: 200 });
    await other.loadURL('data:text/html,<title>Focus test</title>Another window');
    other.focus();
    await until(() => other.isFocused() && !win.isFocused(), 'Test did not leave the reader window');
    win.focus();
    await until(() => win.isFocused(), 'Test did not return to the reader window');
    other.close();
  }
  await until(() => !rc.isLoading() && rc.getURL().includes('qireader.com'), 'QiReader fixture failed to load');
  await until(() => shellContents.executeJavaScript('Boolean(window.desktop)'), 'Shell preload missing');
  await until(() => navigationContents.executeJavaScript('Boolean(window.desktop)'), 'Floating navigation preload missing');
  assert.equal(navigation.getVisible(), false);

  if (process.env.QIREADER_TEST_PHASE === 'restart') {
    if (process.platform === 'win32') {
      const settings = await openTestSettings();
      const result = await settings.webContents.executeJavaScript('desktop.request("settings-info")');
      assert.deepEqual(result.shortcuts.bindings, { previous: 'Alt+ArrowLeft', next: 'N', 'cubox-save': 'S' });
      assert.equal(result.info.configured, true);
      assert.ok(!JSON.stringify(result).includes('fake_secret'));
      assert.equal((await settings.webContents.executeJavaScript('desktop.request("cubox-clear")')).ok, true);
      settings.close();
      console.log('PASS: Windows encrypted Cubox configuration survives restart and clears locally');
    }
    await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 2 / 2") && document.getElementById("progress-count").textContent.includes("已达标")'), 'Daily target or completion dates lost across restart');
    assert.equal(desktop.progress.summary('week').automatic, true);
    assert.equal(desktop.progress.summary('week').target, 7);
    assert.equal(await rc.executeJavaScript('localStorage.getItem("test-login")'), 'retained');
    const cookies = await browserSession.cookies.get({ url: 'https://www.zhihu.com', name: 'test-session' });
    assert.equal(cookies[0]?.value, 'retained');
    assert.equal(streamRequests, 0, 'Restart must reuse the daily snapshot without scanning');
    assert.equal(desktop.networkProxy.summary().mode, 'direct');
    const v2cookies = await browserSession.cookies.get({ url: 'https://www.v2ex.com', name: 'test-session' });
    assert.equal(v2cookies[0]?.value, 'retained');
    console.log('PASS: login storage and persistent cookies survive process restart');
    win.close();
    await until(() => win.isDestroyed(), 'Restart window did not close after storage flush');
    app.quit();
    return;
  }

  if (process.env.QIREADER_TEST_PHASE === 'budget') {
    await require('./proxy-fixture.cjs')(desktop, input => desktop.networkProxy.configure(input));
    win.close(); await until(() => win.isDestroyed(), 'Budget test window did not close');
    app.quit(); return;
  }

  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 0 / 100")'), 'Default daily goal missing');
  assert.equal(await shellContents.executeJavaScript('document.querySelectorAll("#settings").length === 1 && !document.getElementById("progress-goal") && !document.getElementById("goal-editor")'), true);
  let goalSettings = await openTestSettings();
  assert.equal(await goalSettings.webContents.executeJavaScript('Boolean(document.getElementById("goals") && document.getElementById("api-link"))'), true);
  async function editGoal(period, automatic, target) {
    await goalSettings.webContents.executeJavaScript(`document.getElementById('${period}-auto').checked=${automatic};document.getElementById('${period}-auto').dispatchEvent(new Event('change'));document.getElementById('${period}-target').value=${target};document.getElementById('goals').requestSubmit()`);
    await until(() => desktop.progress.summary(period).automatic === automatic && desktop.progress.summary(period).target === target, 'Goal did not save');
    await until(() => goalSettings.webContents.executeJavaScript('document.getElementById("goals-result").textContent.includes("已保存") && !document.getElementById("save-goals").disabled'), 'Goal save result missing');
  }
  await editGoal('today', true, 100);
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("0 / 9")'), 'Automatic daily cohort missing');
  await editGoal('today', false, 2);
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("0 / 2")'), 'Manual daily goal missing');
  await goalSettings.webContents.executeJavaScript(`document.getElementById('today-target').value=999`);
  goalSettings.close(); goalSettings = await openTestSettings();
  assert.equal(await goalSettings.webContents.executeJavaScript('document.getElementById("today-target").value'), '2');
  assert.equal(desktop.progress.summary().total, 2);
  assert.equal((await navigationContents.executeJavaScript('desktop.request("goals-configure", {today:{automatic:false,target:999}})')).ok, false);
  assert.equal(desktop.progress.summary().total, 2);
  await shellContents.executeJavaScript('document.getElementById("progress-period").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "本周"'), 'Week switch missing');
  const automaticWeekTotal = desktop.progress.summary('week').total;
  await editGoal('week', false, 7);
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("0 / 7")'), 'Manual weekly goal missing');
  await editGoal('week', true, 7);
  assert.equal(desktop.progress.summary('week').total, automaticWeekTotal);
  assert.equal(desktop.progress.summary('week').automatic, true);
  assert.equal(streamRequests, 1, 'Goal edits must not request QiReader lists');
  const runProxyChecks = require('./proxy-fixture.cjs');
  assert.equal((await shellContents.executeJavaScript('desktop.request("proxy-configure", {mode:"direct",address:"",scope:"selected",domains:""})')).ok, false);
  let firstProxy = true;
  await runProxyChecks(desktop, async input => {
    if (firstProxy || (input.autoLearn && input.domains === '')) {
      firstProxy = false;
      await goalSettings.webContents.executeJavaScript(`document.getElementById('proxy-mode').value='custom';document.getElementById('proxy-mode').dispatchEvent(new Event('change'));document.getElementById('proxy-address').value=${JSON.stringify(input.address)};document.getElementById('proxy-domains').value=${JSON.stringify(input.domains)};document.getElementById('proxy-auto').checked=${input.autoLearn === true};document.getElementById('proxy-auto').dispatchEvent(new Event('change'));document.getElementById('proxy-result').textContent='';document.getElementById('proxy').requestSubmit()`);
      await until(() => goalSettings.webContents.executeJavaScript('document.getElementById("proxy-result").textContent.includes("已应用")'), 'Proxy form did not apply');
    } else {
      const result = await goalSettings.webContents.executeJavaScript(`desktop.request('proxy-configure', ${JSON.stringify(input)})`);
      assert.equal(result.ok, true, result.error);
    }
    await until(() => !rc.isLoading() && rc.getURL().includes('qireader.com'), 'Reader did not recover after proxy change');
    await until(() => !desktop.progress.syncing, 'Statistics identity check did not settle after proxy change');
  });
  assert.equal(streamRequests, 1, 'Proxy changes must not trigger full statistics scans');
  const settingsArtifact = path.join(__dirname, '..', 'artifacts', `settings-${process.platform}.png`);
  fs.mkdirSync(path.dirname(settingsArtifact), { recursive: true });
  await pause(100);
  try { fs.writeFileSync(settingsArtifact, (await goalSettings.webContents.capturePage()).toPNG()); }
  catch (error) { console.log(`SKIP: optional settings screenshot unavailable (${error.message})`); }
  goalSettings.close();
  await shellContents.executeJavaScript('document.getElementById("progress-period").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "全部" && document.getElementById("progress-count").textContent.includes("0 / 10")'), 'All progress missing');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").max'), 10);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("progress-older").hidden'), true);
  await shellContents.executeJavaScript('document.getElementById("progress-period").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "今日"'), 'Today switch missing');
  win.setSize(960, 600);
  await pause(150);
  assert.equal(await shellContents.executeJavaScript(`(() => {
    const center=document.querySelector('.toolbar-center').getBoundingClientRect();
    const left=document.querySelector('.toolbar-left').getBoundingClientRect();
    const right=document.querySelector('.toolbar-right').getBoundingClientRect();
    return Math.abs(center.left+center.width/2-innerWidth/2)<1 && left.right<=center.left && center.right<=right.left && document.querySelector('header').offsetHeight===44;
  })()`), true);
  win.setSize(1500, 960);
  const beforeFocus = streamRequests;
  for (let i = 0; i < 20; i++) win.emit('focus');
  await shellContents.executeJavaScript('desktop.command("progress-refresh")');
  await until(() => !desktop.progress.syncing && desktop.progress.error.includes('冷却'), 'Manual cooldown did not settle');
  assert.equal(streamRequests, beforeFocus, 'Focus or rapid manual refresh scanned the stream');
  clock += 31 * 60000;
  statsStatus = 503;
  await shellContents.executeJavaScript('document.getElementById("progress-count").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("reading-status").classList.contains("stale")'), 'Failed sync did not show stale state');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("0 / 2")'), true);
  statsStatus = 200;
  await shellContents.executeJavaScript('desktop.command("progress-refresh")');
  await until(() => shellContents.executeJavaScript('!document.getElementById("reading-status").classList.contains("stale") && !document.getElementById("progress-count").disabled'), 'Progress retry failed');
  console.log('PASS: today/week stats, centering, focus/manual request throttling, failed sync preserves counts and retry recovers');

  await rc.executeJavaScript(`history.replaceState({},'', '/tags/reading')`);
  assert.equal(await rc.executeJavaScript('typeof require + "/" + typeof desktop + "/" + typeof process'), 'undefined/undefined/undefined');
  win.focus(); rc.focus();
  await until(() => win.isFocused() && rc.isFocused(), 'List-selection test did not start in the active reader window');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry-title]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));document.querySelector('[data-is-entry-title]').click()`);
  await until(() => oc().getURL().endsWith('/question/a') && !oc().isLoading(), 'List title did not open original');
  assert.ok(desktop.original.getBounds().x > 0);
  assert.equal(reader.getBounds().x, 0);
  assert.equal(navigation.getVisible(), false);
  assert.ok(rc.getURL().endsWith('/tags/reading'));
  assert.equal(await rc.executeJavaScript('Boolean(window.nativeTap)'), false);
  assert.equal(await rc.executeJavaScript('document.querySelector("article") === null'), true);
  await until(() => webContents.getFocusedWebContents() === oc() && oc().executeJavaScript('document.hasFocus()'), 'First list selection left keyboard focus outside the article');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="a"] button').click()`);
  assert.equal(await rc.executeJavaScript('window.actionClicked'), true);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next button unavailable');
  await pressFocusedKey('Space');
  await until(() => oc().getURL().endsWith('/question/b') && !oc().isLoading(), 'Next button did not open next article');
  await pressFocusedKey('S');
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('/settings.html')), 'S after next needed an extra article click');
  const focusSettings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html'));
  await until(() => focusSettings.isFocused(), 'Settings lost focus to reading');
  focusSettings.close();
  await until(() => webContents.getFocusedWebContents() === oc() && oc().executeJavaScript('document.hasFocus()'), 'Closing settings did not restore article focus');
  assert.equal(reader.getBounds().x, 0);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled && document.getElementById("next").disabled'), 'Navigation boundary incorrect');
  shellContents.focus();
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/a') && !oc().isLoading(), 'Previous button did not open previous article');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next did not recover');
  await pressFocusedKey('Space');
  await until(() => oc().getURL().endsWith('/question/b'), 'Space after button navigation needed a click');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/a') && navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Focus test did not restore the original queue');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/b') && !oc().isLoading(), 'Next while hidden failed');
  assert.ok(reader.getBounds().x < 0);
  assert.equal(navigation.getVisible(), true);
  assert.equal(desktop.original.getBounds().width, win.getContentSize()[0]);
  await rc.executeJavaScript('addRow("c")');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Newly rendered article not appended');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/c') && !oc().isLoading(), 'Next did not reach appended article');
  assert.ok(reader.getBounds().x < 0);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Previous unavailable after append');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/b') && !oc().isLoading(), 'Previous after append failed');
  assert.equal(navigation.getVisible(), false);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Navigation did not settle');
  console.log('PASS: previous/next buttons, newly rendered rows, visible/hidden list state preserved');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="b"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  await until(() => oc().getURL().endsWith('/question/b') && !oc().isLoading(), 'Keyboard list selection failed');
  assert.ok(rc.getURL().endsWith('/tags/reading'));
  assert.deepEqual(await rc.executeJavaScript('window.removeCalls'), []);
  console.log('PASS: title and keyboard selection retain the list; native tap blocked; row action preserved');

  shellContents.focus();
  await switchBackToReader();
  await pressFocusedKey('Space');
  await until(() => oc().getURL().endsWith('/question/c'), 'Window activation did not restore reading shortcuts');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/b'), 'Activation test did not restore the article');
  await rc.executeJavaScript('const search=document.createElement("input");search.id="focus-search";document.body.append(search);search.focus()');
  rc.focus();
  await switchBackToReader();
  await pause(100);
  assert.equal(await rc.executeJavaScript('document.hasFocus() && document.activeElement.id === "focus-search"'), true, 'Activation stole focus from the list search');
  rc.sendInputEvent({ type: 'keyDown', keyCode: 'S' }); rc.sendInputEvent({ type: 'keyUp', keyCode: 'S' });
  await pause(100);
  assert.equal(BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('/settings.html')), false);
  await rc.executeJavaScript('document.getElementById("focus-search").remove()');
  console.log('PASS: first selection, button navigation, window activation and settings return work without refocusing; list search retains input focus');

  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Default shortcut test has no ready successor');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="b"] a').blur()`);
  await oc().executeJavaScript('document.querySelector("textarea").focus()');
  await pressKey(oc(), 'Space'); await pressKey(oc(), 'S');
  await pause(100);
  assert.ok(oc().getURL().endsWith('/question/b'), 'Typing triggered navigation');
  assert.equal(BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith('/settings.html')), false, 'Typing triggered collection settings');
  await oc().executeJavaScript('document.activeElement.blur();document.body.tabIndex=-1;document.body.focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true}))');
  await pause(100); assert.ok(oc().getURL().endsWith('/question/b'), 'Synthetic shortcut escaped the website');
  await pressFocusedKey('Space');
  await until(() => oc().getURL().endsWith('/question/c'), 'Space in original did not select the ready successor');
  await until(() => oc().executeJavaScript('document.hasFocus()'), 'Shortcut navigation lost focus after promoting the next article');
  await pressKey(oc(), 'Left', ['alt']);
  await pause(100); assert.ok(oc().getURL().endsWith('/question/c'), 'Previous must be unbound by default');
  const keyboardSettings = await openTestSettings();
  assert.equal((await keyboardSettings.webContents.executeJavaScript('desktop.request("settings-info")')).shortcuts.bindings.next, 'Space');
  await keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcut-next").focus()');
  await pressKey(keyboardSettings.webContents, 'N');
  assert.equal(await keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcut-next").value'), 'N');
  await keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcut-previous").focus()');
  await pressKey(keyboardSettings.webContents, 'Left', ['alt']);
  assert.equal(await keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcut-previous").value'), 'Alt+ArrowLeft');
  await keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcuts").requestSubmit()');
  await until(() => keyboardSettings.webContents.executeJavaScript('document.getElementById("shortcuts-result").textContent.includes("已保存")'), 'Custom keyboard form did not save');
  keyboardSettings.close();
  await pressKey(oc(), 'Left', ['alt']);
  await until(() => oc().getURL().endsWith('/question/b'), 'Custom previous shortcut did not apply');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Custom next has no ready successor');
  await pressKey(oc(), 'Space'); await pause(100);
  assert.ok(oc().getURL().endsWith('/question/b'), 'Old Space binding remained after customization');
  await pressKey(shellContents, 'N');
  await until(() => oc().getURL().endsWith('/question/c'), 'Custom shortcut in toolbar did not navigate');
  const restoreKeyboard = await openTestSettings();
  await restoreKeyboard.webContents.executeJavaScript(`desktop.request('shortcuts-configure',{previous:'',next:'Space','cubox-save':'S'})`);
  restoreKeyboard.close();
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Keyboard selection did not settle');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/b'), 'Shortcut test did not restore article');
  console.log('PASS: native Space ready-next, unbound previous, typed/synthetic keys ignored, recorded custom keys apply in original and toolbar');

  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Virtual list test started before previous selection settled');
  await rc.executeJavaScript(`(()=>{
    const listRoot=document.querySelector('[data-focus-container="entryList"]');
    listRoot.style.cssText='height:100px;overflow-y:auto';
    listRoot.querySelectorAll('[data-is-entry]').forEach(row=>row.style.minHeight='100px');
    listRoot.addEventListener('scroll',()=>{addRow('virtual-one');addRow('virtual-two')},{once:true});
    document.querySelector('[data-is-entry="c"] a').click();
  })()`);
  await until(() => preloaded.has('https://www.zhihu.com/question/virtual-one'), 'Virtual list was not advanced before requesting another page');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Virtual selection did not settle');
  assert.equal(nativePages, 0);
  assert.ok(reader.getBounds().x < 0);
  await rc.executeJavaScript(`(()=>{
    const listRoot=document.querySelector('[data-focus-container="entryList"]');listRoot.style.cssText='';
    listRoot.querySelectorAll('[data-is-entry]').forEach(row=>row.style.minHeight='');
    document.querySelectorAll('[data-is-entry^="virtual-"]').forEach(row=>row.remove());
    document.querySelector('[data-is-entry="b"] a').click();
  })()`);
  await rc.executeJavaScript(`
    const more = document.createElement('button');more.id='native-more';more.textContent='显示更多';
    more.onclick=async()=>{more.disabled=true;const response=await fetch('/api/streams/test-pagination');
      if(response.ok)(await response.json()).entries.forEach(addRow);more.disabled=false;};
    document.querySelector('[data-focus-container="entryList"]').append(more);
  `);
  await until(() => rc.executeJavaScript('Boolean(document.querySelector(\'[data-is-entry="page-three"]\'))'), 'Native next page was not requested near queue end');
  assert.equal(nativePages, 1);
  assert.ok(reader.getBounds().x < 0);
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/c') && !oc().isLoading(), 'Current tail was skipped during replenishment');
  await until(() => preloaded.get('https://www.zhihu.com/question/page-one')?.ready && navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Appended page was not ready for reading');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/page-one') && !oc().isLoading(), 'Hidden list could not navigate into loaded page');
  await pause(2200);
  assert.equal(nativePages, 1, 'Enough queued articles must not request another page');
  nativePageStatus = 429;
  await rc.executeJavaScript('document.querySelector(\'[data-is-entry="page-three"] a\').click()');
  await until(() => nativePages === 2, 'Queue tail did not request another page');
  await pause(2400);
  assert.equal(nativePages, 2, 'HTTP 429 must not trigger automatic retries');
  await rc.executeJavaScript(`document.getElementById('native-more').remove();document.querySelectorAll('[data-is-entry^="page-"]').forEach(row=>row.remove())`);
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  console.log('PASS: near-tail native pagination while hidden, ordered next/prefetch, no unnecessary requests or rate-limit retry loop');

  await rc.executeJavaScript(`['pre-one','pre-two','pre-three','pre-four','pre-fail'].forEach(addRow);document.querySelector('[data-is-entry="pre-one"] a').click()`);
  const warmURL = id => `https://www.zhihu.com/question/${id}`;
  await until(() => preloaded.get(warmURL('pre-two'))?.ready && preloaded.has(warmURL('pre-three')), 'Two following articles were not preloaded');
  assert.deepEqual([...preloaded.keys()], [warmURL('pre-two'), warmURL('pre-three')]);
  assert.equal(originalRequests.get('/question/pre-four') || 0, 0);
  const warmSecond = preloaded.get(warmURL('pre-two')).view.webContents;
  const warmThird = preloaded.get(warmURL('pre-three')).view.webContents;
  assert.equal(warmSecond.isAudioMuted(), true);
  assert.equal(warmSecond.getBackgroundThrottling(), true);
  assert.equal(win.contentView.children.some(view => view.webContents === warmSecond), false, 'Background article was attached to the keyboard-active window');
  assert.equal(await warmSecond.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  const popupCount = BrowserWindow.getAllWindows().length;
  await warmSecond.executeJavaScript('void window.open("about:blank", "background-login")');
  await pause(100);
  assert.equal(BrowserWindow.getAllWindows().length, popupCount);
  await warmSecond.executeJavaScript('window.preloadedMarker = 42');
  ipcMain.emit('reader:navigation', { sender: warmSecond, senderFrame: warmSecond.mainFrame }, { route: '/tags/reading', current: warmURL('pre-one'), upcoming: ['file:///etc/passwd'] });
  assert.equal(preloaded.size, 2);
  const secondRequests = originalRequests.get('/question/pre-two');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Preloaded next unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc() === warmSecond && !oc().isLoading(), 'Ready page was not promoted');
  assert.equal(await oc().executeJavaScript('window.preloadedMarker'), 42);
  assert.equal(originalRequests.get('/question/pre-two'), secondRequests);
  assert.equal(oc().isAudioMuted(), false);
  assert.equal(oc().getBackgroundThrottling(), false);
  assert.equal(win.contentView.children.includes(desktop.original), true);
  await until(() => preloaded.has(warmURL('pre-four')), 'Prefetch window did not advance');
  assert.equal(originalRequests.get('/question/pre-fail') || 0, 0);
  await until(() => preloaded.get(warmURL('pre-four'))?.ready && navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Ready alternative unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/pre-four') && !oc().isLoading(), 'Slow article was not moved behind the ready alternative');
  assert.equal(preloaded.get(warmURL('pre-three')).view.webContents, warmThird);
  assert.equal(warmThird.isDestroyed(), false);
  releaseThird();
  await until(() => preloaded.get(warmURL('pre-three'))?.ready && originalRequests.get('/question/pre-fail') === 1 && !preloaded.has(warmURL('pre-fail')), 'Deferred completion or failed-view release missing');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Deferred ready article unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc() === warmThird && !oc().isLoading(), 'Deferred article was not reused after it became ready');
  assert.equal(originalRequests.get('/question/pre-three'), 1);
  assert.ok(preloaded.size <= 2);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("error").hidden'), true);
  assert.deepEqual(confirmedRemovals, []);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").value'), 0);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Foreground failure test not ready');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="pre-fail"] a').click()`);
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("HTTP 404")'), 'Failed preload was not retried in foreground');
  assert.equal(oc(), warmThird, 'Failed preparation must keep the readable foreground article');
  assert.equal(originalRequests.get('/question/pre-fail'), 2);
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="pre-one"] a').click()`);
  await until(() => preloaded.size === 2 && [...preloaded.values()].every(page => page.ready), 'Preload recovery failed');
  const stalePages = [...preloaded.values()].map(page => page.view.webContents);
  await rc.executeJavaScript(`history.pushState({},'', '/tags/other')`);
  await until(() => preloaded.size === 0 && stalePages.every(contents => contents.isDestroyed()), 'Changed list retained old preloads');
  await rc.executeJavaScript(`history.pushState({},'', '/tags/reading');document.querySelectorAll('[data-is-entry^="pre-"]').forEach(row=>row.remove())`);
  console.log('PASS: two-page bound, ready-first reorder and deferred reuse, muted sandbox, failed-view release/retry, stale-list cleanup; no early completion');

  await rc.executeJavaScript('selectArticle("a")');
  await until(() => oc().getURL().endsWith('/question/a') && !oc().isLoading(), 'First article did not open');
  assert.equal(await oc().executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  console.log('PASS: first article opens; remote pages have no Node or shell bridge');

  const oldArticle = oc();
  await rc.executeJavaScript('selectArticle("b", 700)');
  await pause(450);
  assert.ok(oc().getURL().endsWith('/question/a'));
  await until(() => oc().getURL().endsWith('/question/b') && !oc().isLoading(), 'Delayed SPA article did not open');
  assert.equal(oldArticle.isDestroyed(), true);
  assert.ok(rc.getURL().endsWith('/entries/b'));
  console.log('PASS: delayed SPA rendering opens the correct article without navigating the list');

  ipcMain.emit('reader:article', { sender: oc(), senderFrame: oc().mainFrame }, { route: '/tags/!readlater/entries/b', url: 'https://evil.test/' });
  ipcMain.emit('reader:article', { sender: rc, senderFrame: rc.mainFrame }, { route: '/tags/!readlater/entries/old', url: 'https://evil.test/' });
  ipcMain.emit('reader:article', { sender: rc, senderFrame: rc.mainFrame }, { route: '/tags/!readlater/entries/b', url: 'file:///etc/passwd' });
  await pause(150);
  assert.ok(oc().getURL().endsWith('/question/b'));
  console.log('PASS: wrong sender, stale route, and non-web URLs are rejected');

  await shellContents.executeJavaScript('desktop.command("zoom", {pane:"original",change:10})');
  await until(() => Math.round(oc().getZoomFactor() * 100) === 110, 'Original zoom button failed');
  assert.equal(Math.round(rc.getZoomFactor() * 100), 100);
  rc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
  await until(() => Math.round(rc.getZoomFactor() * 100) === 110, 'Reader keyboard zoom failed');
  rc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
  await until(() => Math.round(rc.getZoomFactor() * 100) === 100, 'Zoom reset failed');
  await shellContents.executeJavaScript('desktop.command("zoom", {pane:"original",change:0})');
  console.log('PASS: independent toolbar/keyboard zoom and reset');

  await restoreTestWindow();
  await shellContents.executeJavaScript('desktop.command("width", 180)');
  await until(() => reader.getBounds().width === 180, 'Narrow list width did not apply');
  assert.ok(reader.getBounds().width < desktop.original.getBounds().width);
  assert.equal(reader.getBounds().width, 180);
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => desktop.original.getBounds().width === win.getContentSize()[0], 'List collapse did not apply');
  assert.equal(desktop.original.getBounds().width, win.getContentSize()[0]);
  assert.equal(desktop.original.getBounds().x, 0);
  await shellContents.executeJavaScript('desktop.command("toggle-list"); desktop.command("width", 280)');
  await until(() => reader.getBounds().x === 0 && reader.getBounds().width === 280, 'List restore did not apply');
  await restoreTestWindow();
  shellContents.focus();
  await until(() => win.isFocused() && shellContents.isFocused(), 'Drag test window did not receive focus');
  shellContents.sendInputEvent({type:'mouseMove',x:283,y:220,modifiers:[]});
  shellContents.sendInputEvent({type:'mouseDown',x:283,y:220,button:'left',clickCount:1});
  await until(() => shellContents.executeJavaScript('document.body.classList.contains("previewing")'), 'Drag preview did not start');
  shellContents.sendInputEvent({type:'mouseMove',x:203,y:220,modifiers:['leftButtonDown']});
  await until(() => reader.getBounds().width === 200, 'Mouse move did not resize list');
  shellContents.sendInputEvent({type:'mouseUp',x:203,y:220,button:'left',clickCount:1});
  shellContents.sendInputEvent({type:'mouseMove',x:20,y:20,modifiers:[]});
  await until(() => reader.getBounds().width === 200, 'Mouse drag did not resize list');
  await until(() => shellContents.executeJavaScript('!document.body.classList.contains("previewing")'), 'Drag did not release');
  console.log('PASS: 180px list, full-width collapse, real pointer drag with preview');

  assert.equal(await shellContents.executeJavaScript('Boolean(document.getElementById("home") || document.getElementById("previous") || document.getElementById("next"))'),false);
  const floatingBounds = navigation.getBounds();
  assert.equal(floatingBounds.x,12);
  assert.equal(floatingBounds.y + floatingBounds.height,win.getContentSize()[1] - 16);
  await navigationContents.executeJavaScript('desktop.command("toggle-list")');
  await pause(100);
  assert.equal(reader.getBounds().x,0); // Floating page can only send navigation actions.
  await shellContents.executeJavaScript('document.getElementById("list-side").click()');
  await until(() => reader.getBounds().x === win.getContentSize()[0] - 200, 'List did not move right');
  assert.equal(desktop.original.getBounds().x,0);
  const startRight = win.getContentSize()[0] - 203;
  try {
    await until(() => shellContents.executeJavaScript(`Math.abs(document.getElementById('splitter').getBoundingClientRect().x - ${startRight - 3}) < 1`), 'Right splitter did not finish layout');
  } catch (error) {
    console.error('Right splitter diagnostic', reader.getBounds(), win.getContentSize(), shellContents.getZoomFactor(), await shellContents.executeJavaScript(`({innerWidth,body:document.body.className,box:document.getElementById('splitter').getBoundingClientRect().toJSON(),width:getComputedStyle(document.documentElement).getPropertyValue('--list-width')})`));
    throw error;
  }
  shellContents.focus();
  await until(() => win.isFocused() && shellContents.isFocused(), 'Right drag test window did not receive focus');
  shellContents.sendInputEvent({type:'mouseMove',x:startRight,y:220,modifiers:[]});
  shellContents.sendInputEvent({type:'mouseDown',x:startRight,y:220,button:'left',clickCount:1});
  await until(() => shellContents.executeJavaScript('document.body.classList.contains("previewing")'), 'Right drag preview missing');
  shellContents.sendInputEvent({type:'mouseMove',x:startRight-80,y:220,modifiers:['leftButtonDown']});
  await until(() => reader.getBounds().width === 280, 'Right list drag direction incorrect');
  shellContents.sendInputEvent({type:'mouseUp',x:startRight-80,y:220,button:'left',clickCount:1});
  shellContents.sendInputEvent({type:'mouseMove',x:20,y:20,modifiers:[]});
  await until(() => shellContents.executeJavaScript('!document.body.classList.contains("previewing")'), 'Right drag did not release');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => reader.getBounds().x === win.getContentSize()[0], 'Right list did not hide');
  assert.equal(navigation.getVisible(), true);
  assert.equal(desktop.original.getBounds().width,win.getContentSize()[0]);
  await shellContents.executeJavaScript('document.getElementById("list-side").click()');
  await until(() => reader.getBounds().x < 0, 'Hidden list side switch unexpectedly expanded list');
  assert.equal(navigation.getVisible(), true);
  assert.equal(desktop.original.getBounds().width,win.getContentSize()[0]);
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => reader.getBounds().x === 0, 'Left list did not restore');
  assert.equal(navigation.getVisible(), false);
  console.log('PASS: floating navigation bounds and IPC scope, no home button, left/right drag and manual visibility');

  const created = new Promise(resolve => oc().once('did-create-window', resolve));
  await oc().executeJavaScript('void window.open("https://www.zhihu.com/signin", "login")');
  const popup = await created;
  await until(() => !popup.webContents.isLoading(), 'Popup did not load');
  assert.equal(popup.webContents.session, browserSession);
  assert.equal(await popup.webContents.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  await until(() => popup.isFocused(), 'Login popup did not retain focus');
  popup.close();
  await until(() => webContents.getFocusedWebContents() === oc() && oc().executeJavaScript('document.hasFocus()'), 'Closing login did not restore article focus');
  const blankCreated = new Promise(resolve => oc().once('did-create-window', resolve));
  await oc().executeJavaScript('void window.open("about:blank", "oauth")');
  const blank = await blankCreated;
  await blank.webContents.loadURL('https://www.zhihu.com/signin');
  assert.equal(await blank.webContents.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  blank.close();
  console.log('PASS: sandboxed login popups');

  await oc().loadURL('https://www.zhihu.com/failure').catch(() => {});
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("加载失败")'), 'Failure not visible');
  await rc.executeJavaScript('selectArticle("a")');
  await until(() => oc().getURL().endsWith('/question/a') && !oc().isLoading(), 'Next article did not recover after network failure');
  console.log('PASS: failed loads are visible and subsequent articles recover');

  holdTracking = true; holdRemoval = true;
  await rc.executeJavaScript(`history.pushState({},'', '/tags/!readlater');document.querySelector('[data-focus-container="articleView"]').replaceChildren();const first=addRow('success');addRow('success-two');first.querySelector('a').click()`);
  await until(() => oc().getURL().endsWith('/question/success') && preloaded.get('https://www.zhihu.com/question/success-two')?.ready, 'Visible original or ready successor missing');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Pending server confirmation blocked ready-next navigation');
  assert.equal(confirmedRemovals.includes('success'), false);
  assert.equal(desktop.progress.summary().done, 0, 'Unconfirmed removal must not earn completion');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc().getURL().endsWith('/question/success-two') && navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Pending confirmation blocked reading the ready successor');
  assert.deepEqual(confirmedRemovals, []);
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/success') && navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Replaying an article with pending removal failed');
  assert.equal(await rc.executeJavaScript('window.removeCalls.filter(id=>id==="success").length'), 1, 'Pending removal must not be toggled twice');
  holdRemoval = false; releaseRemoval();
  await until(() => confirmedRemovals.includes('success'), 'Successful original was not removed through native action');
  assert.equal(oc().isLoading(), true, 'Fixture must still be waiting for the image');
  assert.equal(desktop.progress.summary().done, 0, 'Blocked statistics must not invent completion');
  assert.equal(await rc.executeJavaScript(`document.querySelector('[data-is-entry="success"]')===null`), true);
  holdTracking = false; releaseTracking();
  await until(() => desktop.progress.summary().done === 2, 'Deferred statistics did not record both confirmed removals');
  releaseImage();
  await until(() => !oc().isLoading(), 'Released image did not settle');
  console.log('PASS: ready navigation while removal/image/statistics are pending, replay does not duplicate removal, only server-confirmed progress counts');
  await until(() => preloaded.get('https://www.zhihu.com/question/success-two')?.ready, 'Read Later next page was not prefetched');
  assert.equal(await rc.executeJavaScript('window.removeCalls.filter(id=>id==="success-two").length'), 1);
  const laterPreload = preloaded.get('https://www.zhihu.com/question/success-two').view.webContents;
  assert.equal(await rc.executeJavaScript(`document.querySelector('[data-is-entry="success"]')===null`), true);
  assert.ok(rc.getURL().endsWith('/tags/!readlater'));
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next after removal unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc() === laterPreload, 'Ready next replay did not use its prepared page');
  assert.equal(oc(), laterPreload);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Previous after removal unavailable');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc().getURL().endsWith('/question/success') && !oc().isLoading(), 'Removed previous article could not be revisited');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Previous replay did not settle');
  assert.equal(await rc.executeJavaScript('window.removeCalls.filter(id=>id==="success").length'),1);
  statsStatus = 503;
  await rc.executeJavaScript(`addRow('reject').querySelector('a').click()`);
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("未获服务器确认")'), 'Rejected removal not reported');
  await until(() => rc.executeJavaScript(`Boolean(document.querySelector('[data-is-entry="reject"]'))`), 'Rejected row did not roll back');
  statsStatus = 200;
  for(const id of ['network-fail','not-found']) {
    await rc.executeJavaScript(`addRow(${JSON.stringify(id)}).querySelector('a').click()`);
    await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("加载失败")'), 'Original failure missing');
    await pause(150);
    assert.equal(await rc.executeJavaScript(`window.removeCalls.includes(${JSON.stringify(id)})`), false);
  }
  assert.deepEqual(confirmedRemovals, ['success','success-two']);
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 2 / 2") && document.getElementById("progress-count").textContent.includes("已达标")'), 'Confirmed removals did not reach the daily goal');
  ipcMain.emit('reader:completed', { sender: oc(), senderFrame: oc().mainFrame }, 'reject');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").value'), 2);
  assert.equal(streamRequests, 2, 'Article changes, popups and reloads must not add full scans');
  await rc.executeJavaScript(`const recycled=addRow('recycled');recycled.querySelector('a').click();recycled.setAttribute('data-is-entry','different-item')`);
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("已离开视图")'), 'Recycled row not detected');
  assert.equal(await rc.executeJavaScript('window.removeCalls.includes("different-item")'),false);
  console.log('PASS: native auto-removal only after load; server rejection rolls back; network/HTTP failures retain items');

  await rc.executeJavaScript('localStorage.setItem("test-login", "retained")');
  await browserSession.cookies.set({ url: 'https://www.zhihu.com', name: 'test-session', value: 'retained', expirationDate: Date.now() / 1000 + 86400 });
  const artifactDir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  await rc.executeJavaScript(`history.pushState({},'', '/tags/reading');document.querySelector('[data-focus-container="articleView"]').replaceChildren();document.querySelector('[data-is-entry-title]').click()`);
  await until(() => oc().getURL().endsWith('/question/a') && !oc().isLoading(), 'List did not remain usable after returning from article mode');
  await pause(300);
  assert.equal((await shellContents.executeJavaScript('desktop.request("settings-info")')).ok, false);
  assert.equal((await navigationContents.executeJavaScript('desktop.request("cubox-clear")')).ok, false);
  await shellContents.executeJavaScript('document.getElementById("cubox-save").click()');
  await until(() => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith('/settings.html')), 'First collect did not open settings');
  const settings = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
  await until(() => settings.webContents.executeJavaScript('Boolean(window.desktop)'), 'Settings preload missing');
  await settings.webContents.executeJavaScript(`document.getElementById('api-link').value='https://cubox.pro/c/api/save/fake_secret_123';document.getElementById('folder').value='测试';document.getElementById('settings').requestSubmit()`);
  if (process.platform === 'win32') {
    await until(() => settings.webContents.executeJavaScript('document.getElementById("result").textContent.includes("设置已保存")'), 'Windows secure settings did not save');
    assert.equal(desktop.progress.summary().total, 2, 'Cubox changes overwrote reading targets');
    assert.ok(!fs.readFileSync(path.join(app.getPath('userData'), 'cubox-settings.json'), 'utf8').includes('fake_secret'));
    const calls = [];
    await session.fromPartition('cubox-api').protocol.handle('https', async request => {
      calls.push({ body: await request.json(), cookie: request.headers.get('cookie') });
      await pause(200);
      return Response.json({ code: 200 });
    });
    assert.equal(calls.length, 0);
    settings.close();
    await oc().executeJavaScript('document.activeElement.blur();document.body.tabIndex=-1;document.body.focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:"s",code:"KeyS",bubbles:true,cancelable:true}))');
    await pause(100); assert.equal(calls.length, 0, 'Synthetic page key must not submit to Cubox');
    await pressKey(oc(), 'S');
    await until(() => shellContents.executeJavaScript('document.getElementById("cubox-save").textContent.includes("已提交")'), 'Collect did not confirm submission');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.content, oc().getURL());
    assert.equal(calls[0].body.title, oc().getTitle());
    assert.equal(calls[0].body.folder, '测试');
    assert.equal(calls[0].cookie, null);
    await pressKey(oc(), 'S');
    await pause(100); assert.equal(calls.length, 1);
    console.log('PASS: Cubox settings encrypted; isolated explicit current-article POST; duplicate blocked; IPC restricted');
  } else {
    await until(() => settings.webContents.executeJavaScript('document.getElementById("result").textContent.length > 0'), 'Settings result missing');
    settings.close();
    console.log('PASS: Cubox settings UI and IPC isolation (Windows covers OS encryption and submission)');
  }
  await shellContents.executeJavaScript('desktop.command("width", 280)');
  await until(() => reader.getBounds().width === 280, 'Final list width did not settle');
  assert.equal(await shellContents.executeJavaScript('document.querySelector("header").getBoundingClientRect().height'),44);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("error").hidden'),true);
  fs.writeFileSync(path.join(artifactDir, `toolbar-goal-${process.platform}.png`), (await shellContents.capturePage({x:0,y:0,width:win.getContentSize()[0],height:44}, {stayAwake:true})).toPNG());
  await shellContents.executeJavaScript('desktop.command("progress-period"); desktop.command("progress-period")');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "全部" && document.getElementById("progress-count").textContent.includes("已完成 2 / 10")'), 'All progress did not retain completed articles');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").max'), 10);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").value'), 2);
  fs.writeFileSync(path.join(artifactDir, `toolbar-${process.platform}.png`), (await shellContents.capturePage({x:0,y:0,width:win.getContentSize()[0],height:44}, {stayAwake:true})).toPNG());
  if (process.platform === 'win32') {
    const widthBeforeMinimize = reader.getBounds().width;
    win.minimize(); await pause(100);
    await restoreTestWindow();
    assert.equal(reader.getBounds().width, widthBeforeMinimize, 'Minimizing reset list width');
    await pause(700);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1500, height: 960 } });
    const ownWindow = sources.find(source => source.id === win.getMediaSourceId());
    assert.ok(ownWindow && !ownWindow.thumbnail.isEmpty(), 'Own window screenshot missing');
    fs.writeFileSync(path.join(artifactDir, 'smoke-win32.png'), ownWindow.thumbnail.toPNG());
    await restoreTestWindow();
    await shellContents.executeJavaScript('document.getElementById("list-side").click()');
    try {
      await until(() => reader.getBounds().x === win.getContentSize()[0] - 280, 'Final right layout missing');
    } catch (error) {
      console.error('Final layout diagnostic', reader.getBounds(), win.getContentSize(), await shellContents.executeJavaScript(`({body:document.body.className,side:document.getElementById('list-side').textContent,hidden:document.getElementById('splitter').hidden,width:getComputedStyle(document.documentElement).getPropertyValue('--list-width')})`));
      throw error;
    }
    await pause(300);
    const rightSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1500, height: 960 } });
    const rightWindow = rightSources.find(source => source.id === win.getMediaSourceId());
    assert.ok(rightWindow && !rightWindow.thumbnail.isEmpty());
    fs.writeFileSync(path.join(artifactDir, 'smoke-win32-right.png'), rightWindow.thumbnail.toPNG());
  }
  const articleContents = [oc(), ...[...preloaded.values()].map(page => page.view.webContents)];
  const persistedKeyboard = await openTestSettings();
  assert.equal((await persistedKeyboard.webContents.executeJavaScript(`desktop.request('shortcuts-configure',{previous:'Alt+ArrowLeft',next:'N','cubox-save':'S'})`)).ok, true);
  persistedKeyboard.close();
  win.close();
  await until(() => rc.isDestroyed() && articleContents.every(contents => contents.isDestroyed()) && navigationContents.isDestroyed(), 'Views leaked after window close');
  console.log('PASS: window close releases both remote views');
  app.quit();
})().catch(error => { console.error(error); app.exit(1); });
