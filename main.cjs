const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { READER_ORIGINS, webURL, readerURL } = require('./policy.cjs');
const { ReadingProgress } = require('./reading-progress.cjs');

const shellPath = path.join(__dirname, 'shell.html');
const shellURL = pathToFileURL(shellPath).href;
const navigationPath = path.join(__dirname, 'navigation.html');
const navigationURL = pathToFileURL(navigationPath).href;
const remotePreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

function createWindow() {
  const browserSession = session.fromPartition('persist:qireader-desktop');
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const win = new BaseWindow({
    width: 1500, height: 960, minWidth: 960, minHeight: 600,
    title: 'QiReader Desktop 0.6.1', backgroundColor: '#ffffff'
  });
  const shellView = new WebContentsView({ webPreferences: { ...remotePreferences, preload: path.join(__dirname, 'shell-preload.cjs') } });
  const shellContents = shellView.webContents;
  win.contentView.addChildView(shellView);
  const reader = new WebContentsView({ webPreferences: {
    ...remotePreferences, session: browserSession, preload: path.join(__dirname, 'reader-preload.cjs')
  } });
  const original = new WebContentsView({ webPreferences: { ...remotePreferences, session: browserSession } });
  const navigation = new WebContentsView({ webPreferences: { ...remotePreferences, preload: path.join(__dirname, 'shell-preload.cjs') } });
  const navigationContents = navigation.webContents;
  navigation.setBackgroundColor('#00000000');
  navigation.setBorderRadius(20);
  const popups = new Set();
  win.contentView.addChildView(reader);
  win.contentView.addChildView(original);
  win.contentView.addChildView(navigation);
  let listWidth = 280;
  let listSide = 'left';
  let listHidden = false;
  let dragging = false;
  let dragRequest = 0;
  let originalStatus = 0;
  let selectedURL = '';
  const state = { error: '', url: '', listHidden: false, listWidth, listSide, readerZoom: 100, originalZoom: 100, canPrevious: false, canNext: false, progressPeriod: 'today' };
  const progress = new ReadingProgress({
    file: path.join(app.getPath('userData'), 'reading-progress.json'),
    fetch: (url, options) => browserSession.fetch(url, options), onChange: publish
  });
  const pendingCompletions = new Map();
  let lastProgressRefresh = 0, refreshTimer;
  function refreshProgress() {
    const url = reader.webContents.getURL();
    if (!readerURL(url)) return;
    lastProgressRefresh = Date.now();
    void progress.refresh(new URL(url).origin);
  }
  const progressTimer = setInterval(() => {
    publish();
    if (Date.now() - lastProgressRefresh >= 300000) refreshProgress();
  }, 60000);
  reader.webContents.on('did-finish-load', refreshProgress);
  win.on('focus', () => { if (Date.now() - lastProgressRefresh >= 30000) refreshProgress(); });

  function publish() {
    if (!win.isDestroyed()) {
      shellContents.send('shell:state', { ...state, progress: progress.summary(state.progressPeriod) });
      navigationContents.send('shell:state', { canPrevious: state.canPrevious, canNext: state.canNext });
    }
  }
  function layout() {
    const [width, height] = win.getContentSize();
    shellView.setBounds({ x: 0, y: 0, width, height });
    listWidth = Math.max(180, Math.min(width - 360, listWidth));
    const split = listHidden ? 0 : listWidth + 6;
    const right = listSide === 'right';
    reader.setBounds({ x: listHidden ? (right ? width : -listWidth) : (right ? width - listWidth : 0), y: 44, width: listWidth, height: Math.max(0, height - 44) });
    original.setVisible(Boolean(selectedURL));
    original.setBounds({ x: right ? 0 : split, y: 44, width: width - split, height: Math.max(0, height - 44) });
    navigation.setBounds({ x: 12, y: Math.max(44, height - 60), width: 104, height: 44 });
    navigation.setVisible(Boolean(selectedURL) && listHidden);
    if (dragging) win.contentView.addChildView(shellView);
    else {
      // Sibling views keep the drag overlay from obscuring pages after release.
      win.contentView.addChildView(reader);
      win.contentView.addChildView(original);
      win.contentView.addChildView(navigation);
    }
    state.listHidden = listHidden;
    state.listWidth = listWidth;
    state.listSide = listSide;
    state.dragging = dragging;
    publish();
  }
  function load(contents, url, pane) {
    return contents.loadURL(url).then(() => true).catch(error => {
      if (error.code === 'ERR_ABORTED' || win.isDestroyed()) return false;
      state.error = `加载失败：${error.code || error.message}`;
      publish();
      return false;
    });
  }
  function openOriginal(value) {
    const url = webURL(value);
    if (!url) return;
    selectedURL = url;
    state.url = url;
    state.error = '';
    layout();
    return load(original.webContents, url, 'original').then(ok => {
      const loaded = ok && selectedURL === url && originalStatus < 400;
      return loaded;
    });
  }
  function secureRemote(contents) {
    contents.on('zoom-changed', (_event, direction) => setZoom(contents, direction === 'in' ? 10 : -10));
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      let change;
      if (['+', '=', 'Add'].includes(input.key)) change = 10;
      if (['-', '_', 'Subtract'].includes(input.key)) change = -10;
      if (input.key === '0') change = 0;
      if (change === undefined) return;
      event.preventDefault();
      setZoom(contents, change);
    });
    for (const eventName of ['will-navigate', 'will-redirect']) {
      contents.on(eventName, (event, url) => {
        if (!webURL(url)) event.preventDefault();
        else if (contents === reader.webContents && webURL(url) === selectedURL) {
          event.preventDefault();
          openOriginal(url);
        }
      });
    }
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (!webURL(url) && url !== 'about:blank') return { action: 'deny' };
      if (contents === reader.webContents && webURL(url) === selectedURL) {
        openOriginal(url);
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 1000, height: 800, autoHideMenuBar: true,
        webPreferences: { ...remotePreferences, session: browserSession, preload: undefined }
      } };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      secureRemote(popup.webContents);
      popup.on('closed', () => popups.delete(popup));
    });
  }
  function setZoom(contents, change) {
    const percent = change === 0 ? 100 : Math.round(contents.getZoomFactor() * 100) + change;
    contents.setZoomFactor(Math.min(200, Math.max(50, percent)) / 100);
    if (contents === reader.webContents) state.readerZoom = Math.round(contents.getZoomFactor() * 100);
    if (contents === original.webContents) state.originalZoom = Math.round(contents.getZoomFactor() * 100);
    publish();
  }
  for (const [pane, view] of [['reader', reader], ['original', original]]) {
    const contents = view.webContents;
    secureRemote(contents);
    contents.on('dom-ready', () => {
      contents.setZoomFactor(state[`${pane}Zoom`] / 100);
    });
    contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (pane === 'original' && isMainFrame && !inPlace) originalStatus = 0;
    });
    contents.on('did-navigate', (_event, url, status) => {
      if (pane === 'original') { state.url = url; originalStatus = status; }
      if (status >= 400) state.error = `网页加载失败（HTTP ${status}）`;
      publish();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (pane === 'original' && isMainFrame) { state.url = url; publish(); }
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { state.error = `加载失败：${description}`; publish(); }
    });
    contents.on('render-process-gone', () => { state.error = '页面进程已退出，请重新打开'; publish(); });
  }

  function article(event, message) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame ||
        !readerURL(event.senderFrame.url) || !message || typeof message.route !== 'string') return;
    if (new URL(event.senderFrame.url).pathname !== message.route || !/\/entries\/[^/]+/.test(message.route)) return;
    if (webURL(message.url) !== selectedURL) openOriginal(message.url);
  }
  async function listArticle(event, message) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame ||
        !readerURL(event.senderFrame.url) || !message || typeof message.id !== 'string' || !message.id ||
        new URL(event.senderFrame.url).pathname !== message.route || !webURL(message.url)) return { ok: false };
    const later = message.trackCompletion === true && /^\/tags\/!readlater\/?$/.test(decodeURI(message.route));
    pendingCompletions.delete(message.id);
    const [loaded, token] = await Promise.all([
      openOriginal(message.url),
      later ? progress.track(new URL(event.senderFrame.url).origin, message.id) : null
    ]);
    if (later && !token) {
      state.error = '原文已打开，统计记录暂未同步；文章保留在稍后阅读，请稍后重试'; publish();
    }
    if (loaded && token) pendingCompletions.set(message.id, token);
    return { ok: Boolean(loaded && (!later || token)) };
  }
  async function command(event, message) {
    const fromShell = event.sender === shellContents && event.senderFrame === shellContents.mainFrame && event.senderFrame.url === shellURL;
    const fromNavigation = event.sender === navigationContents && event.senderFrame === navigationContents.mainFrame && event.senderFrame.url === navigationURL;
    if ((!fromShell && !fromNavigation) || !message) return;
    const { action, value } = message;
    if (fromNavigation && !['ready', 'previous', 'next'].includes(action)) return;
    if (action === 'ready') publish();
    if (action === 'zoom' && message.value && ['reader', 'original'].includes(value.pane) && [-10, 0, 10].includes(value.change)) {
      setZoom(value.pane === 'reader' ? reader.webContents : original.webContents, value.change);
    }
    if (action === 'width' && Number.isFinite(value)) { listWidth = value; layout(); }
    if (action === 'toggle-list') { listHidden = !listHidden; layout(); }
    if (action === 'list-side') { listSide = listSide === 'left' ? 'right' : 'left'; layout(); }
    if (action === 'progress-period') { state.progressPeriod = { today: 'week', week: 'all', all: 'today' }[state.progressPeriod]; publish(); }
    if (action === 'progress-refresh') refreshProgress();
    if (action === 'progress-older') {
      const url = reader.webContents.getURL();
      if (readerURL(url)) {
        listHidden = false; layout();
        load(reader.webContents, `${new URL(url).origin}/tags/!readlater`, 'reader');
      }
    }
    if (action === 'previous' && state.canPrevious) reader.webContents.send('reader:navigate', -1);
    if (action === 'next' && state.canNext) reader.webContents.send('reader:navigate', 1);
    if (action === 'drag') {
      const request = ++dragRequest;
      if (value === true && !listHidden) {
        const previews = await Promise.all([reader.webContents.capturePage(), original.webContents.capturePage()]).catch(() => null);
        if (request !== dragRequest || win.isDestroyed()) return;
        if (previews) shellContents.send('shell:preview', previews.map(preview => preview.toDataURL()));
        dragging = true;
      } else dragging = false;
      layout();
    }
    if (action === 'dismiss-error') { state.error = ''; publish(); }
    if (action === 'reader-back' && reader.webContents.navigationHistory.canGoBack()) reader.webContents.navigationHistory.goBack();
    if (action === 'reader-reload') reader.webContents.reload();
    if (action === 'original-back' && original.webContents.navigationHistory.canGoBack()) original.webContents.navigationHistory.goBack();
    if (action === 'original-reload' && selectedURL) load(original.webContents, webURL(original.webContents.getURL()) || selectedURL, 'original');
    if (action === 'external') {
      const url = webURL(state.url);
      if (url) {
        try { await shell.openExternal(url); }
        catch { state.error = '无法打开外部浏览器'; publish(); }
      }
    }
  }
  ipcMain.on('reader:article', article);
  ipcMain.handle('reader:list-article', listArticle);
  function readerError(event, message) {
    if (event.sender === reader.webContents && event.senderFrame === reader.webContents.mainFrame && readerURL(event.senderFrame.url) && typeof message === 'string') {
      state.error = message.slice(0, 180); publish();
    }
  }
  ipcMain.on('reader:error', readerError);
  function navigationState(event, message) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url) || !message) return;
    state.canPrevious = message.previous === true;
    state.canNext = message.next === true;
    publish();
  }
  ipcMain.on('reader:navigation', navigationState);
  function completed(event, id) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url)) return;
    const token = pendingCompletions.get(id);
    if (token && token.origin === new URL(event.senderFrame.url).origin) {
      pendingCompletions.delete(id); progress.complete(token);
    }
  }
  function progressChanged(event) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url)) return;
    clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshProgress, 1000);
  }
  ipcMain.on('reader:completed', completed);
  ipcMain.on('reader:progress-changed', progressChanged);
  ipcMain.on('shell:command', command);
  for (const contents of [shellContents, navigationContents]) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
  }
  win.on('resize', layout);
  win.on('blur', () => { dragRequest++; if (dragging) { dragging = false; layout(); } shellContents.send('shell:end-drag'); });
  win.on('closed', () => {
    clearInterval(progressTimer); clearTimeout(refreshTimer);
    ipcMain.removeListener('reader:article', article);
    ipcMain.removeHandler('reader:list-article');
    ipcMain.removeListener('reader:error', readerError);
    ipcMain.removeListener('reader:navigation', navigationState);
    ipcMain.removeListener('reader:completed', completed);
    ipcMain.removeListener('reader:progress-changed', progressChanged);
    ipcMain.removeListener('shell:command', command);
    for (const popup of popups) popup.destroy();
    reader.webContents.close();
    original.webContents.close();
    shellContents.close();
    navigationContents.close();
  });
  shellContents.loadFile(shellPath);
  navigationContents.loadFile(navigationPath);
  layout();
  load(reader.webContents, `${READER_ORIGINS[0]}/tags/!readlater`, 'reader');
  return { win, shellContents, navigationContents, navigation, reader, original, browserSession };
}

if (require.main === module) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', () => {
      const win = BaseWindow.getAllWindows()[0];
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
    app.whenReady().then(() => {
      Menu.setApplicationMenu(null);
      createWindow();
      app.on('activate', () => { if (!BaseWindow.getAllWindows().length) createWindow(); });
    }).catch(error => { dialog.showErrorBox('QiReader Desktop 启动失败', error.message); app.quit(); });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  }
}
module.exports = { createWindow };
