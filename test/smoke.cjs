const { app, session, ipcMain, desktopCapturer } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWindow } = require('../main.cjs');

app.setPath('userData', process.env.QIREADER_TEST_PROFILE);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(75); }
  throw new Error(message);
}
const readerHTML = `<!doctype html><meta charset="utf-8"><title>QiReader 测试页面</title>
<style>body{font:18px sans-serif;padding:28px;color:#303444}button{padding:16px;margin:8px}article{padding:24px;background:#f5f3fa}</style>
<h1>稍后阅读 · 模拟页面</h1><p>这里测试文章切换，不连接真实账号。</p>
<div data-is-entry="a" tabindex="0" onclick="selectArticle('a')" onpointerdown="window.nativeTap=true"><a data-is-entry-title href="https://www.zhihu.com/question/a">文章 A</a><button onclick="event.stopPropagation();window.actionClicked=true">收藏</button></div>
<div data-is-entry="b" tabindex="0" onclick="selectArticle('b')"><a data-is-entry-title href="https://www.zhihu.com/question/b">文章 B</a></div>
<div data-focus-container="articleView"></div>
<script>
window.removeCalls = [];
window.addRow = id => {
  const row = document.createElement('div');row.tabIndex=0;row.setAttribute('data-is-entry',id);
  row.innerHTML='<a data-is-entry-title href="https://www.zhihu.com/question/'+id+'">文章 '+id+'</a>';
  document.body.append(row);return row;
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
  const capturedToday = new Date(); capturedToday.setHours(0, 0, 0, 0);
  const statsEntries = ['a', 'b', 'c', 'success', 'success-two', 'reject', 'network-fail', 'not-found', 'recycled'].map(id =>
    ({ id, crawledAt: +capturedToday + 1000, timestamp: '9007199254740993999', tagIds: ['later'], status: 1 }));
  statsEntries.push({ id: 'older', crawledAt: +capturedToday - 86400000, timestamp: '9007199254740993998', tagIds: ['later'], status: 1 });
  let statsStatus = 200;
  await browserSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (request.method === 'DELETE') {
      await pause(500);
      const id = url.pathname.split('/').at(-3);
      if(id === 'reject') return new Response('{}', {status:503});
      confirmedRemovals.push(id);
      return new Response('{}', {status:200});
    }
    if (url.hostname === 'www.qireader.com' && url.pathname.startsWith('/api/')) {
      if (statsStatus !== 200) return Response.json({}, { status: statsStatus });
      let result;
      if (url.pathname === '/api/session/user') result = { id: 'smoke-account' };
      else if (url.pathname === '/api/tags') result = { tags: [{ id: 'later', label: '!readlater' }] };
      else if (url.pathname.startsWith('/api/entry/')) result = statsEntries.find(entry => entry.id === decodeURIComponent(url.pathname.split('/').at(-1)));
      else if (url.pathname === '/api/streams/tag-later') result = {
        entries: statsEntries.filter(entry => !confirmedRemovals.includes(entry.id) &&
          !(process.env.QIREADER_TEST_PHASE === 'restart' && ['success', 'success-two'].includes(entry.id))), hasMore: false
      };
      else throw new Error(`Unexpected stats endpoint: ${url.pathname}`);
      return Response.json({ result });
    }
    if (url.hostname === 'www.qireader.com') return new Response(readerHTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/failure' || url.pathname === '/question/network-fail') return Response.error();
    if (url.pathname === '/question/not-found') return new Response('Not found', {status:404});
    if (url.pathname === '/question/recycled') await pause(400);
    return new Response(`<!doctype html><meta charset="utf-8"><title>原文测试</title><style>body{font:20px sans-serif;padding:40px;line-height:1.8}</style><h1>原文 ${url.pathname}</h1><p>独立网页视图 · 模拟知乎原文</p><textarea placeholder="评论输入框"></textarea>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const { win, shellContents, navigationContents, navigation, reader, original } = createWindow();
  const rc = reader.webContents;
  const oc = original.webContents;
  await until(() => !rc.isLoading() && rc.getURL().includes('qireader.com'), 'QiReader fixture failed to load');
  await until(() => shellContents.executeJavaScript('Boolean(window.desktop)'), 'Shell preload missing');
  await until(() => navigationContents.executeJavaScript('Boolean(window.desktop)'), 'Floating navigation preload missing');
  assert.equal(navigation.getVisible(), false);

  if (process.env.QIREADER_TEST_PHASE === 'restart') {
    await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 2 / 9")'), 'Reading progress lost across restart');
    assert.equal(await rc.executeJavaScript('localStorage.getItem("test-login")'), 'retained');
    const cookies = await browserSession.cookies.get({ url: 'https://www.zhihu.com', name: 'test-session' });
    assert.equal(cookies[0]?.value, 'retained');
    console.log('PASS: login storage and persistent cookies survive process restart');
    win.destroy();
    app.quit();
    return;
  }

  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 0 / 9")'), 'Initial saved-article progress missing');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("progress-older").textContent'), '往期 1');
  await shellContents.executeJavaScript('document.getElementById("progress-period").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "本周"'), 'Week switch missing');
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
  statsStatus = 503;
  await shellContents.executeJavaScript('document.getElementById("progress-count").click()');
  await until(() => shellContents.executeJavaScript('document.getElementById("reading-status").classList.contains("stale")'), 'Failed sync did not show stale state');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("0 / 9")'), true);
  statsStatus = 200;
  await shellContents.executeJavaScript('desktop.command("progress-refresh")');
  await until(() => shellContents.executeJavaScript('!document.getElementById("reading-status").classList.contains("stale") && !document.getElementById("progress-count").disabled'), 'Progress retry failed');
  console.log('PASS: today/week stats, narrow-window centering, failed sync preserves counts and retry recovers');

  await rc.executeJavaScript(`history.replaceState({},'', '/tags/reading')`);
  assert.equal(await rc.executeJavaScript('typeof require + "/" + typeof desktop + "/" + typeof process'), 'undefined/undefined/undefined');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry-title]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));document.querySelector('[data-is-entry-title]').click()`);
  await until(() => oc.getURL().endsWith('/question/a') && !oc.isLoading(), 'List title did not open original');
  assert.ok(original.getBounds().x > 0);
  assert.equal(reader.getBounds().x, 0);
  assert.equal(navigation.getVisible(), false);
  assert.ok(rc.getURL().endsWith('/tags/reading'));
  assert.equal(await rc.executeJavaScript('Boolean(window.nativeTap)'), false);
  assert.equal(await rc.executeJavaScript('document.querySelector("article") === null'), true);
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="a"] button').click()`);
  assert.equal(await rc.executeJavaScript('window.actionClicked'), true);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next button unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc.getURL().endsWith('/question/b') && !oc.isLoading(), 'Next button did not open next article');
  assert.equal(reader.getBounds().x, 0);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled && document.getElementById("next").disabled'), 'Navigation boundary incorrect');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc.getURL().endsWith('/question/a') && !oc.isLoading(), 'Previous button did not open previous article');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next did not recover');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc.getURL().endsWith('/question/b') && !oc.isLoading(), 'Next while hidden failed');
  assert.ok(reader.getBounds().x < 0);
  assert.equal(navigation.getVisible(), true);
  assert.equal(original.getBounds().width, win.getContentSize()[0]);
  await rc.executeJavaScript('addRow("c")');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Newly rendered article not appended');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => oc.getURL().endsWith('/question/c') && !oc.isLoading(), 'Next did not reach appended article');
  assert.ok(reader.getBounds().x < 0);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Previous unavailable after append');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc.getURL().endsWith('/question/b') && !oc.isLoading(), 'Previous after append failed');
  assert.equal(navigation.getVisible(), false);
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Navigation did not settle');
  console.log('PASS: previous/next buttons, newly rendered rows, visible/hidden list state preserved');
  await rc.executeJavaScript(`document.querySelector('[data-is-entry="b"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  await until(() => oc.getURL().endsWith('/question/b') && !oc.isLoading(), 'Keyboard list selection failed');
  assert.ok(rc.getURL().endsWith('/tags/reading'));
  assert.deepEqual(await rc.executeJavaScript('window.removeCalls'), []);
  console.log('PASS: title and keyboard selection retain the list; native tap blocked; row action preserved');
  await rc.executeJavaScript('selectArticle("a")');
  await until(() => oc.getURL().endsWith('/question/a') && !oc.isLoading(), 'First article did not open');
  assert.equal(await oc.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  console.log('PASS: first article opens; remote pages have no Node or shell bridge');

  const visited = [];
  oc.on('did-navigate', (_event, url) => visited.push(url));
  await rc.executeJavaScript('selectArticle("b", 700)');
  await pause(450);
  assert.ok(oc.getURL().endsWith('/question/a'));
  await until(() => oc.getURL().endsWith('/question/b') && !oc.isLoading(), 'Delayed SPA article did not open');
  assert.deepEqual(visited, ['https://www.zhihu.com/question/b']);
  assert.ok(rc.getURL().endsWith('/entries/b'));
  console.log('PASS: delayed SPA rendering opens the correct article without navigating the list');

  ipcMain.emit('reader:article', { sender: oc, senderFrame: oc.mainFrame }, { route: '/tags/!readlater/entries/b', url: 'https://evil.test/' });
  ipcMain.emit('reader:article', { sender: rc, senderFrame: rc.mainFrame }, { route: '/tags/!readlater/entries/old', url: 'https://evil.test/' });
  ipcMain.emit('reader:article', { sender: rc, senderFrame: rc.mainFrame }, { route: '/tags/!readlater/entries/b', url: 'file:///etc/passwd' });
  await pause(150);
  assert.ok(oc.getURL().endsWith('/question/b'));
  console.log('PASS: wrong sender, stale route, and non-web URLs are rejected');

  await shellContents.executeJavaScript('desktop.command("zoom", {pane:"original",change:10})');
  await until(() => Math.round(oc.getZoomFactor() * 100) === 110, 'Original zoom button failed');
  assert.equal(Math.round(rc.getZoomFactor() * 100), 100);
  rc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
  await until(() => Math.round(rc.getZoomFactor() * 100) === 110, 'Reader keyboard zoom failed');
  rc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
  await until(() => Math.round(rc.getZoomFactor() * 100) === 100, 'Zoom reset failed');
  await shellContents.executeJavaScript('desktop.command("zoom", {pane:"original",change:0})');
  console.log('PASS: independent toolbar/keyboard zoom and reset');

  await shellContents.executeJavaScript('desktop.command("width", 180)');
  await pause(100);
  assert.ok(reader.getBounds().width < original.getBounds().width);
  assert.equal(reader.getBounds().width, 180);
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await pause(100);
  assert.equal(original.getBounds().width, win.getContentSize()[0]);
  assert.equal(original.getBounds().x, 0);
  await shellContents.executeJavaScript('desktop.command("toggle-list"); desktop.command("width", 280)');
  await pause(100);
  win.focus();
  shellContents.sendInputEvent({type:'mouseDown',x:283,y:220,button:'left',clickCount:1});
  await until(() => shellContents.executeJavaScript('document.body.classList.contains("previewing")'), 'Drag preview did not start');
  shellContents.sendInputEvent({type:'mouseMove',x:203,y:220,modifiers:['leftButtonDown']});
  await until(() => reader.getBounds().width === 200, 'Mouse move did not resize list');
  shellContents.sendInputEvent({type:'mouseUp',x:203,y:220,button:'left',clickCount:1});
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
  assert.equal(original.getBounds().x,0);
  const startRight = win.getContentSize()[0] - 203;
  shellContents.sendInputEvent({type:'mouseDown',x:startRight,y:220,button:'left',clickCount:1});
  await until(() => shellContents.executeJavaScript('document.body.classList.contains("previewing")'), 'Right drag preview missing');
  shellContents.sendInputEvent({type:'mouseMove',x:startRight-80,y:220,modifiers:['leftButtonDown']});
  await until(() => reader.getBounds().width === 280, 'Right list drag direction incorrect');
  shellContents.sendInputEvent({type:'mouseUp',x:startRight-80,y:220,button:'left',clickCount:1});
  await until(() => shellContents.executeJavaScript('!document.body.classList.contains("previewing")'), 'Right drag did not release');
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => reader.getBounds().x === win.getContentSize()[0], 'Right list did not hide');
  assert.equal(navigation.getVisible(), true);
  assert.equal(original.getBounds().width,win.getContentSize()[0]);
  await shellContents.executeJavaScript('document.getElementById("list-side").click()');
  await until(() => reader.getBounds().x < 0, 'Hidden list side switch unexpectedly expanded list');
  assert.equal(navigation.getVisible(), true);
  assert.equal(original.getBounds().width,win.getContentSize()[0]);
  await shellContents.executeJavaScript('desktop.command("toggle-list")');
  await until(() => reader.getBounds().x === 0, 'Left list did not restore');
  assert.equal(navigation.getVisible(), false);
  console.log('PASS: floating navigation bounds and IPC scope, no home button, left/right drag and manual visibility');

  const created = new Promise(resolve => oc.once('did-create-window', resolve));
  await oc.executeJavaScript('void window.open("https://www.zhihu.com/signin", "login")');
  const popup = await created;
  await until(() => !popup.webContents.isLoading(), 'Popup did not load');
  assert.equal(popup.webContents.session, browserSession);
  assert.equal(await popup.webContents.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  popup.close();
  const blankCreated = new Promise(resolve => oc.once('did-create-window', resolve));
  await oc.executeJavaScript('void window.open("about:blank", "oauth")');
  const blank = await blankCreated;
  await blank.webContents.loadURL('https://www.zhihu.com/signin');
  assert.equal(await blank.webContents.executeJavaScript('typeof require + "/" + typeof desktop'), 'undefined/undefined');
  blank.close();
  console.log('PASS: sandboxed login popups');

  await oc.loadURL('https://www.zhihu.com/failure').catch(() => {});
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("加载失败")'), 'Failure not visible');
  await rc.executeJavaScript('selectArticle("a")');
  await until(() => oc.getURL().endsWith('/question/a') && !oc.isLoading(), 'Next article did not recover after network failure');
  console.log('PASS: failed loads are visible and subsequent articles recover');

  await rc.executeJavaScript(`history.pushState({},'', '/tags/!readlater');document.querySelector('[data-focus-container="articleView"]').replaceChildren();const first=addRow('success');addRow('success-two');first.querySelector('a').click()`);
  await until(() => confirmedRemovals.includes('success'), 'Successful original was not removed through native action');
  assert.equal(await rc.executeJavaScript(`document.querySelector('[data-is-entry="success"]')===null`), true);
  assert.ok(rc.getURL().endsWith('/tags/!readlater'));
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Next after removal unavailable');
  await navigationContents.executeJavaScript('document.getElementById("next").click()');
  await until(() => confirmedRemovals.includes('success-two'), 'Next did not remove successful next article');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("previous").disabled'), 'Previous after removal unavailable');
  await navigationContents.executeJavaScript('document.getElementById("previous").click()');
  await until(() => oc.getURL().endsWith('/question/success') && !oc.isLoading(), 'Removed previous article could not be revisited');
  await until(() => navigationContents.executeJavaScript('!document.getElementById("next").disabled'), 'Previous replay did not settle');
  assert.equal(await rc.executeJavaScript('window.removeCalls.filter(id=>id==="success").length'),1);
  await rc.executeJavaScript(`addRow('reject').querySelector('a').click()`);
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("未获服务器确认")'), 'Rejected removal not reported');
  await until(() => rc.executeJavaScript(`Boolean(document.querySelector('[data-is-entry="reject"]'))`), 'Rejected row did not roll back');
  for(const id of ['network-fail','not-found']) {
    await rc.executeJavaScript(`addRow(${JSON.stringify(id)}).querySelector('a').click()`);
    await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("加载失败")'), 'Original failure missing');
    await pause(150);
    assert.equal(await rc.executeJavaScript(`window.removeCalls.includes(${JSON.stringify(id)})`), false);
  }
  assert.deepEqual(confirmedRemovals, ['success','success-two']);
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-count").textContent.includes("已完成 2 / 9")'), 'Successful removal did not update progress');
  ipcMain.emit('reader:completed', { sender: oc, senderFrame: oc.mainFrame }, 'reject');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").value'), 2);
  await rc.executeJavaScript(`const recycled=addRow('recycled');recycled.querySelector('a').click();recycled.setAttribute('data-is-entry','different-item')`);
  await until(() => shellContents.executeJavaScript('document.getElementById("error").textContent.includes("已离开视图")'), 'Recycled row not detected');
  assert.equal(await rc.executeJavaScript('window.removeCalls.includes("different-item")'),false);
  console.log('PASS: native auto-removal only after load; server rejection rolls back; network/HTTP failures retain items');

  await rc.executeJavaScript('localStorage.setItem("test-login", "retained")');
  await browserSession.cookies.set({ url: 'https://www.zhihu.com', name: 'test-session', value: 'retained', expirationDate: Date.now() / 1000 + 86400 });
  browserSession.flushStorageData();
  await browserSession.cookies.flushStore();
  const artifactDir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  await rc.executeJavaScript(`history.pushState({},'', '/tags/reading');document.querySelector('[data-focus-container="articleView"]').replaceChildren();document.querySelector('[data-is-entry-title]').click()`);
  await until(() => oc.getURL().endsWith('/question/a') && !oc.isLoading(), 'List did not remain usable after returning from article mode');
  await pause(300);
  await shellContents.executeJavaScript('desktop.command("width", 280)');
  assert.equal(await shellContents.executeJavaScript('document.querySelector("header").getBoundingClientRect().height'),44);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("error").hidden'),true);
  await shellContents.executeJavaScript('desktop.command("progress-period"); desktop.command("progress-period")');
  await until(() => shellContents.executeJavaScript('document.getElementById("progress-period").textContent === "全部" && document.getElementById("progress-count").textContent.includes("已完成 2 / 10")'), 'All progress did not retain completed articles');
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").max'), 10);
  assert.equal(await shellContents.executeJavaScript('document.getElementById("reading-progress").value'), 2);
  fs.writeFileSync(path.join(artifactDir, `toolbar-${process.platform}.png`), (await shellContents.capturePage({x:0,y:0,width:win.getContentSize()[0],height:44}, {stayAwake:true})).toPNG());
  if (process.platform === 'win32') {
    win.show(); win.focus();
    await pause(700);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1500, height: 960 } });
    const ownWindow = sources.find(source => source.id === win.getMediaSourceId());
    assert.ok(ownWindow && !ownWindow.thumbnail.isEmpty(), 'Own window screenshot missing');
    fs.writeFileSync(path.join(artifactDir, 'smoke-win32.png'), ownWindow.thumbnail.toPNG());
    await shellContents.executeJavaScript('document.getElementById("list-side").click()');
    await until(() => reader.getBounds().x === win.getContentSize()[0] - 280, 'Final right layout missing');
    await pause(300);
    const rightSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1500, height: 960 } });
    const rightWindow = rightSources.find(source => source.id === win.getMediaSourceId());
    assert.ok(rightWindow && !rightWindow.thumbnail.isEmpty());
    fs.writeFileSync(path.join(artifactDir, 'smoke-win32-right.png'), rightWindow.thumbnail.toPNG());
  }
  win.destroy();
  await until(() => rc.isDestroyed() && oc.isDestroyed() && navigationContents.isDestroyed(), 'Views leaked after window close');
  console.log('PASS: window close releases both remote views');
  app.quit();
})().catch(error => { console.error(error); app.exit(1); });
