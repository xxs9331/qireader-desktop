const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, Menu, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { READER_ORIGINS, webURL, readerURL } = require('./policy.cjs');
const { ReadingProgress } = require('./reading-progress.cjs');
const { Cubox } = require('./cubox.cjs');
const settingsPath = path.join(__dirname, 'settings.html');
const settingsURL = pathToFileURL(settingsPath).href;

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
    title: 'QiReader Desktop 0.9.1', backgroundColor: '#ffffff'
  });
  const shellView = new WebContentsView({ webPreferences: { ...remotePreferences, backgroundThrottling: false, preload: path.join(__dirname, 'shell-preload.cjs') } });
  const shellContents = shellView.webContents;
  win.contentView.addChildView(shellView);
  const reader = new WebContentsView({ webPreferences: {
    ...remotePreferences, session: browserSession, preload: path.join(__dirname, 'reader-preload.cjs')
  } });
  const preloaded = new Map();
  let originalPage = createOriginalPage();
  let original = originalPage.view;
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
  let selectedURL = '';
  let prefetchAnchor = '', prefetchRoute = '', prefetchTargets = [];
  const state = { error: '', url: '', listHidden: false, listWidth, listSide, readerZoom: 100, originalZoom: 100, canPrevious: false, canNext: false, progressPeriod: 'today' };
  const progress = new ReadingProgress({
    file: path.join(app.getPath('userData'), 'reading-progress.json'),
    fetch: (url, options) => browserSession.fetch(url, options), onChange: publish
  });
  const pendingCompletions = new Map();
  const cubox = new Cubox({ file: path.join(app.getPath('userData'), 'cubox-settings.json'), storage: safeStorage,
    fetch: (url, options) => session.fromPartition('cubox-api').fetch(url, options) });
  let settingsWindow = null, collecting = false;
  cubox.ready.then(publish);
  function openSettings() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({ parent: win, modal: true, width: 560, height: 760, minWidth: 480, minHeight: 480,
      title: '设置', autoHideMenuBar: true,
      webPreferences: { ...remotePreferences, preload: path.join(__dirname, 'shell-preload.cjs') } });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    settingsWindow.on('closed', () => { settingsWindow = null; });
    settingsWindow.loadFile(settingsPath);
  }
  ipcMain.handle('desktop:request', async (event, message) => {
    const contents = settingsWindow?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== settingsURL) return { ok: false, error: '不允许此操作' };
    try {
      await cubox.ready;
      if (message?.action === 'goals-configure') progress.setGoals(message.value);
      else if (message?.action === 'cubox-configure') await cubox.configure(message.value);
      else if (message?.action === 'cubox-clear') await cubox.clear();
      else if (message?.action === 'cubox-open-web') {
        await shell.openExternal(message.value === 'cc' ? 'https://help.cubox.cc/save/api/' : 'https://help.cubox.pro/save/89d3/');
      } else if (message?.action !== 'settings-info') return { ok: false, error: '未知操作' };
      publish();
      return { ok: true, info: cubox.summary(), goals: { today: progress.summary('today'), week: progress.summary('week') } };
    } catch (error) { return { ok: false, error: message?.action === 'cubox-open-web' ? '无法打开浏览器' : error.message }; }
  });
  const changedEntries = new Set();
  let refreshTimer;
  function refreshProgress(manual = false) {
    const url = reader.webContents.getURL();
    if (!readerURL(url)) return;
    void progress.sync(new URL(url).origin, { manual: manual === true });
  }
  const progressTimer = setInterval(publish, 60000);
  reader.webContents.on('did-finish-load', refreshProgress);
  reader.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { prefetchAnchor = ''; prefetchTargets = []; clearPreloaded(); }
  });

  function publish() {
    if (!win.isDestroyed()) {
      shellContents.send('shell:state', { ...state, progress: progress.summary(state.progressPeriod),
        cubox: { ...cubox.summary(original.webContents.getURL()), busy: collecting || cubox.busy,
          available: Boolean(selectedURL && originalPage.ready && !originalPage.failed && originalPage.status < 400 && !original.webContents.isLoadingMainFrame() && webURL(original.webContents.getURL())) } });
      navigationContents.send('shell:state', { canPrevious: state.canPrevious, canNext: state.canNext });
    }
  }
  function layout() {
    const [width, height] = win.getContentSize();
    if (width <= 0 || height <= 0) return;
    shellView.setBounds({ x: 0, y: 0, width, height });
    listWidth = Math.max(180, Math.min(width - 360, listWidth));
    const split = listHidden ? 0 : listWidth + 6;
    const right = listSide === 'right';
    reader.setBounds({ x: listHidden ? (right ? width : -listWidth) : (right ? width - listWidth : 0), y: 44, width: listWidth, height: Math.max(0, height - 44) });
    original.setVisible(Boolean(selectedURL));
    original.setBounds({ x: right ? 0 : split, y: 44, width: width - split, height: Math.max(0, height - 44) });
    for (const page of preloaded.values()) page.view.setBounds(original.getBounds());
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
  function load(contents, url, pane, quiet = false) {
    return contents.loadURL(url).then(() => true).catch(error => {
      if (error.code === 'ERR_ABORTED' || win.isDestroyed()) return false;
      if (!quiet) { state.error = `加载失败：${error.code || error.message}`; publish(); }
      return false;
    });
  }
  function createOriginalPage() {
    const page = {
      view: new WebContentsView({ webPreferences: { ...remotePreferences, session: browserSession } }),
      url: '', status: 0, ready: false, failed: false, generation: 0, loading: null
    };
    observeRemote('original', page.view, page);
    return page;
  }
  function disposePage(page) {
    page.generation++;
    if (!win.isDestroyed()) win.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }
  function clearPreloaded() {
    for (const page of preloaded.values()) disposePage(page);
    preloaded.clear();
  }
  function reconcilePreloads() {
    if (win.isDestroyed() || prefetchAnchor !== selectedURL ||
        !readerURL(reader.webContents.getURL()) || new URL(reader.webContents.getURL()).pathname !== prefetchRoute) return;
    const targets = new Set(prefetchTargets.filter(url => url !== selectedURL));
    for (const [url, page] of preloaded) {
      if (!targets.has(url)) { preloaded.delete(url); disposePage(page); }
    }
    if (!originalPage.ready || popups.size) return;
    for (const url of targets) {
      if (preloaded.has(url)) continue;
      const page = createOriginalPage();
      page.view.setBounds(original.getBounds()); page.view.setVisible(false);
      page.view.webContents.setAudioMuted(true);
      preloaded.set(url, page); win.contentView.addChildView(page.view);
      loadPage(page, url, true);
    }
  }
  function loadPage(page, url, quiet = false) {
    const generation = ++page.generation;
    page.url = url; page.ready = false; page.failed = false; page.status = 0;
    page.loading = load(page.view.webContents, url, 'original', quiet).then(ok => {
      if (generation !== page.generation || win.isDestroyed()) return false;
      page.ready = ok && page.status < 400; page.failed = !page.ready;
      if (page === originalPage && page.ready) reconcilePreloads();
      return page.ready;
    });
    return page.loading;
  }
  function openOriginal(value) {
    const url = webURL(value);
    if (!url) return;
    let cached = preloaded.get(url);
    if (cached) {
      preloaded.delete(url);
      if (cached.failed || cached.view.webContents.isDestroyed()) { disposePage(cached); cached = null; }
    }
    if (cached) {
      const previous = originalPage;
      originalPage = cached; original = cached.view;
      original.webContents.setAudioMuted(false);
      original.webContents.setZoomFactor(state.originalZoom / 100);
      disposePage(previous);
    }
    selectedURL = url;
    state.url = cached?.ready ? original.webContents.getURL() : url;
    state.error = '';
    layout();
    const page = originalPage;
    const loading = cached ? cached.loading : loadPage(page, url);
    reconcilePreloads();
    return loading.then(ok => ok && originalPage === page && selectedURL === url);
  }
  function secureRemote(contents, foreground = () => true) {
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
      if (!foreground()) return { action: 'deny' };
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
      clearPreloaded();
      secureRemote(popup.webContents);
      popup.on('closed', () => { popups.delete(popup); reconcilePreloads(); });
    });
  }
  function setZoom(contents, change) {
    const percent = change === 0 ? 100 : Math.round(contents.getZoomFactor() * 100) + change;
    contents.setZoomFactor(Math.min(200, Math.max(50, percent)) / 100);
    if (contents === reader.webContents) state.readerZoom = Math.round(contents.getZoomFactor() * 100);
    if (contents === original.webContents) state.originalZoom = Math.round(contents.getZoomFactor() * 100);
    publish();
  }
  function observeRemote(pane, view, page) {
    const contents = view.webContents;
    const foreground = () => pane === 'reader' || page === originalPage;
    secureRemote(contents, foreground);
    contents.on('dom-ready', () => {
      contents.setZoomFactor(state[`${pane}Zoom`] / 100);
    });
    contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (page && isMainFrame && !inPlace) page.status = 0;
    });
    contents.on('did-navigate', (_event, url, status) => {
      if (page) { page.status = status; page.failed = status >= 400; }
      if (!foreground()) return;
      if (pane === 'original') state.url = url;
      if (status >= 400) state.error = `网页加载失败（HTTP ${status}）`;
      publish();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (pane === 'original' && foreground() && isMainFrame) { state.url = url; publish(); }
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (page && isMainFrame && code !== -3) page.failed = true;
      if (foreground() && isMainFrame && code !== -3) { state.error = `加载失败：${description}`; publish(); }
    });
    contents.on('did-stop-loading', () => { if (foreground()) publish(); });
    contents.on('render-process-gone', () => {
      if (page) { page.failed = true; page.ready = false; }
      if (foreground()) { state.error = '页面进程已退出，请重新打开'; publish(); }
    });
  }
  observeRemote('reader', reader);

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
    if (action === 'settings') openSettings();
    if (action === 'cubox-save' && !collecting) {
      await cubox.ready;
      if (!cubox.summary().configured) { openSettings(); return; }
      if (collecting || !selectedURL || !originalPage.ready || originalPage.failed || originalPage.status >= 400 || original.webContents.isLoadingMainFrame()) return;
      collecting = true; state.error = ''; publish();
      try { await cubox.collect(original.webContents.getURL(), original.webContents.getTitle()); }
      catch (error) { state.error = error.message; }
      finally { collecting = false; publish(); }
    }
    if (action === 'zoom' && message.value && ['reader', 'original'].includes(value.pane) && [-10, 0, 10].includes(value.change)) {
      setZoom(value.pane === 'reader' ? reader.webContents : original.webContents, value.change);
    }
    if (action === 'width' && Number.isFinite(value)) { listWidth = value; layout(); }
    if (action === 'toggle-list') { listHidden = !listHidden; layout(); }
    if (action === 'list-side') { listSide = listSide === 'left' ? 'right' : 'left'; layout(); }
    if (action === 'progress-period') { state.progressPeriod = { today: 'week', week: 'all', all: 'today' }[state.progressPeriod]; publish(); }
    if (action === 'progress-refresh') refreshProgress(true);
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
    if (action === 'original-reload' && selectedURL) {
      clearPreloaded(); loadPage(originalPage, webURL(original.webContents.getURL()) || selectedURL);
    }
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
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url) ||
        !message || message.route !== new URL(event.senderFrame.url).pathname) return;
    state.canPrevious = message.previous === true;
    state.canNext = message.next === true;
    prefetchAnchor = webURL(message.current) || '';
    prefetchRoute = message.route;
    prefetchTargets = Array.isArray(message.upcoming) ? message.upcoming.slice(0, 2).map(webURL).filter(Boolean) : [];
    if (!prefetchAnchor) clearPreloaded();
    else reconcilePreloads();
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
  function progressChanged(event, message) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url)) return;
    if (message?.session === true) { changedEntries.clear(); refreshProgress(); return; }
    if (typeof message?.id !== 'string' || !message.id || message.id.length > 512) return;
    changedEntries.add(message.id);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const origin = new URL(reader.webContents.getURL()).origin;
      const ids = [...changedEntries]; changedEntries.clear();
      for (const id of ids) {
        if (win.isDestroyed() || new URL(reader.webContents.getURL()).origin !== origin) break;
        await progress.reconcile(origin, id);
      }
    }, 1000);
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
    cubox.cancel();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    ipcMain.removeHandler('desktop:request');
    clearInterval(progressTimer); clearTimeout(refreshTimer);
    ipcMain.removeListener('reader:article', article);
    ipcMain.removeHandler('reader:list-article');
    ipcMain.removeListener('reader:error', readerError);
    ipcMain.removeListener('reader:navigation', navigationState);
    ipcMain.removeListener('reader:completed', completed);
    ipcMain.removeListener('reader:progress-changed', progressChanged);
    ipcMain.removeListener('shell:command', command);
    for (const popup of popups) popup.destroy();
    clearPreloaded();
    reader.webContents.close();
    original.webContents.close();
    shellContents.close();
    navigationContents.close();
  });
  shellContents.loadFile(shellPath);
  navigationContents.loadFile(navigationPath);
  layout();
  load(reader.webContents, `${READER_ORIGINS[0]}/tags/!readlater`, 'reader');
  return { win, shellContents, navigationContents, navigation, reader, get original() { return original; }, preloaded, browserSession, progress };
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
