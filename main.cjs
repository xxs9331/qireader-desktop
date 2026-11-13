const { app, BaseWindow, BrowserWindow, WebContentsView, webContents, ipcMain, session, shell, dialog, Menu, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { READER_ORIGINS, webURL, readerURL } = require('./policy.cjs');
const { ReadingProgress } = require('./reading-progress.cjs');
const { Cubox } = require('./cubox.cjs');
const { NetworkProxy } = require('./network-proxy.cjs');
const { Shortcuts } = require('./shortcuts.cjs');
const { ReadingScene } = require('./reading-scene.cjs');
const fs = require('node:fs');
const { documentIssue, loadMessage } = require('./page-status.cjs');
const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const settingsPath = path.join(__dirname, 'settings.html');
const settingsURL = pathToFileURL(settingsPath).href;

const shellPath = path.join(__dirname, 'shell.html');
const shellURL = pathToFileURL(shellPath).href;
const navigationPath = path.join(__dirname, 'navigation.html');
const navigationURL = pathToFileURL(navigationPath).href;
const remotePreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

function createWindow() {
  const shortcuts = new Shortcuts(path.join(app.getPath('userData'), 'shortcuts.json'));
  const scene = new ReadingScene(path.join(app.getPath('userData'), 'reading-scene.json'));
  const browserSession = session.fromPartition('persist:qireader-desktop');
  const cuboxSession = session.fromPartition('cubox-api');
  const diagnosticContents = new Map();
  const diagnosticScripts = [...new Set([browserSession, session.defaultSession])].map(ses =>
    [ses, ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'diagnostics-preload.cjs') })]);
  const networkProxy = new NetworkProxy({ file: path.join(app.getPath('userData'), 'proxy-settings.json'), sessions: [browserSession, cuboxSession], onRequest: observeScreeningRequest });
  networkProxy.log('app-start', READER_ORIGINS[0], { version: app.getVersion() });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const win = new BaseWindow({
    width: 1500, height: 960, minWidth: 960, minHeight: 600,
    title: `QiReader Desktop ${app.getVersion()}`, backgroundColor: '#ffffff', icon: iconPath
  });
  const shellView = new WebContentsView({ webPreferences: { ...remotePreferences, backgroundThrottling: false, preload: path.join(__dirname, 'shell-preload.cjs') } });
  const shellContents = shellView.webContents;
  shellView.setBackgroundColor('#00000000');
  win.contentView.addChildView(shellView);
  const reader = new WebContentsView({ webPreferences: {
    ...remotePreferences, backgroundThrottling: false, session: browserSession, preload: path.join(__dirname, 'reader-preload.cjs'), additionalArguments: ['--qireader-list']
  } });
  const preloaded = new Map();
  const articlePages = new Map();
  const failedPreparations = new Set();
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
  let listWidth = scene.data.layout.width;
  let listSide = scene.data.layout.side;
  let listHidden = scene.data.layout.hidden;
  let dragging = false;
  let dragRequest = 0;
  let selectedURL = '';
  let pendingURL = '', selection = 0, poolState = '', proxyQueue = Promise.resolve();
  let prefetchAnchor = '', prefetchRoute = '', prefetchTargets = [];
  const state = { error: scene.error, url: '', screening: false, listHidden, listWidth, listSide, readerZoom: scene.data.layout.readerZoom, originalZoom: 100, canPrevious: false, canNext: false, progressPeriod: scene.data.layout.period };
  let roundBlocked = false;
  let roundArticle = null, roundArticleAccount = null;
  const progress = new ReadingProgress({
    file: path.join(app.getPath('userData'), 'reading-progress.json'),
    fetch: (url, options) => browserSession.fetch(url, options), onChange: publish
  });
  const pendingCompletions = new Map();
  const screeningRequests = new Map();
  function observeScreeningRequest(details) {
    if (details.webContentsId !== reader.webContents.id) return;
    screeningRequests.delete(details.id);
    if (details.frame && details.frame !== reader.webContents.mainFrame) return;
    const url = new URL(details.url);
    if (!READER_ORIGINS.includes(url.origin)) return;
    if (url.pathname === '/api/session' && ['POST', 'PUT', 'DELETE'].includes(details.method)) {
      progress.active = null; screeningRequests.clear(); return;
    }
    if (!state.screening || details.method !== 'PUT' || !progress.active || url.pathname !== '/api/markers/reads' || !progress.active.startsWith(url.origin + '|')) return;
    const chunks = details.uploadData;
    if (!chunks?.length || chunks.some(chunk => !chunk.bytes || chunk.file)) return;
    const size = chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
    if (size > 256 * 1024 || screeningRequests.size >= 100) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks.map(chunk => chunk.bytes)).toString());
      if (body.type !== 'entries' || !Array.isArray(body.entryIds) || body.entryIds.length > 5000 ||
          body.entryIds.some(id => typeof id !== 'string' || !id || id.length > 512)) return;
      screeningRequests.set(details.id, { key: progress.active, ids: body.entryIds });
    } catch { /* Only native entry batches with a known shape are counted. */ }
  }
  const requestFilter = { urls: ['http://*/*', 'https://*/*'] };
  function logRequest(event, details) {
    if (event === 'request-failed' || details.statusCode >= 400 || ['mainFrame', 'subFrame', 'xhr'].includes(details.resourceType)) {
      networkProxy.log(event, details.url, { page: details.webContentsId, request: details.id, resource: details.resourceType,
        method: details.method, status: details.statusCode, code: details.error?.replace(/^net::/, ''), route: networkProxy.route(details.url) });
    }
  }
  browserSession.webRequest.onCompleted(requestFilter, details => {
    logRequest('request-completed', details);
    const pending = screeningRequests.get(details.id); screeningRequests.delete(details.id);
    if (!pending || details.method !== 'PUT' || new URL(details.url).pathname !== '/api/markers/reads' ||
        details.statusCode < 200 || details.statusCode >= 300 || win.isDestroyed()) return;
    try { progress.saveScreening(pending.key, pending.ids); }
    catch (error) { progress.screeningError = error.message; publish(); }
  });
  browserSession.webRequest.onErrorOccurred(requestFilter, details => { logRequest('request-failed', details); screeningRequests.delete(details.id); });
  const cubox = new Cubox({ file: path.join(app.getPath('userData'), 'cubox-settings.json'), storage: safeStorage,
    fetch: (url, options) => cuboxSession.fetch(url, options) });
  let settingsWindow = null, collecting = false;
  cubox.ready.then(publish);
  function openSettings() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({ parent: win, modal: true, width: 560, height: 760, minWidth: 480, minHeight: 480,
      title: '设置', autoHideMenuBar: true, icon: iconPath,
      webPreferences: { ...remotePreferences, backgroundThrottling: false, preload: path.join(__dirname, 'shell-preload.cjs') } });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    observeDiagnostics(settingsWindow.webContents, 'settings');
    settingsWindow.on('closed', () => { settingsWindow = null; setImmediate(focusReading); });
    settingsWindow.loadFile(settingsPath);
  }
  ipcMain.handle('desktop:request', async (event, message) => {
    const contents = settingsWindow?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== settingsURL) return { ok: false, error: '不允许此操作' };
    try {
      await Promise.all([cubox.ready, networkProxy.ready]);
      networkProxy.log('settings-action', settingsURL, { pane: 'settings', action: message?.action, page: contents.id });
      if (message?.action === 'logs-export') {
        const result = await dialog.showSaveDialog(settingsWindow, { title: '导出调试日志', defaultPath: `qireader-debug-${Date.now()}.jsonl`, filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
        if (!result.canceled && result.filePath) {
          const logs = [networkProxy.logFile + '.1', networkProxy.logFile].filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')).join('');
          fs.writeFileSync(result.filePath, logs, { mode: 0o600 });
        }
        return { ok: true, canceled: result.canceled };
      }
      if (message?.action === 'proxy-configure') {
        if (collecting || cubox.busy) throw new Error('正在收藏，请等本次提交结束后修改代理');
        await networkProxy.configure(message.value);
        clearPreloaded(); state.error = '';
        const current = reader.webContents.getURL();
        void load(reader.webContents, readerURL(current) ? current : `${READER_ORIGINS[0]}/tags/!readlater`, 'reader');
        if (selectedURL) void loadPage(originalPage, webURL(original.webContents.getURL()) || selectedURL);
      } else if (message?.action === 'shortcuts-configure') {
        shortcuts.configure(message.value); broadcastShortcuts();
      } else if (message?.action === 'scene-configure') {
        scene.configure(message.value);
      } else if (message?.action === 'round-configure') {
        progress.configureRound(message.value);
      } else if (message?.action === 'screening-goal') {
        progress.setScreeningGoal(message.value);
      } else if (message?.action === 'goals-configure') progress.setGoals(message.value);
      else if (message?.action === 'cubox-configure') await cubox.configure(message.value);
      else if (message?.action === 'cubox-clear') await cubox.clear();
      else if (message?.action === 'cubox-open-web') {
        await shell.openExternal(message.value === 'cc' ? 'https://help.cubox.cc/save/api/' : 'https://help.cubox.pro/save/89d3/');
      } else if (message?.action !== 'settings-info') return { ok: false, error: '未知操作' };
      publish();
      return { ok: true, info: cubox.summary(), proxy: networkProxy.summary(), shortcuts: shortcuts.summary(), scene: scene.summary(), rounds: { reading: progress.roundSummary('reading'), saving: progress.roundSummary('saving') }, screening: progress.screeningSummary(), goals: { today: progress.summary('today'), week: progress.summary('week') } };
    } catch (error) {
      networkProxy.log('settings-action-failed', settingsURL, { pane: 'settings', action: message?.action, page: contents.id });
      return { ok: false, error: message?.action === 'cubox-open-web' ? '无法打开浏览器' : error.message };
    }
  });
  const changedEntries = new Set();
  let refreshTimer;
  function refreshProgress(manual = false) {
    const url = reader.webContents.getURL();
    if (!readerURL(url)) return;
    if (state.screening) {
      const origin = new URL(url).origin;
      void progress.user(origin).then(user => {
        if (!win.isDestroyed() && readerURL(reader.webContents.getURL()) && new URL(reader.webContents.getURL()).origin === origin) {
          progress.active = `${origin}|${user}`; progress.screeningError = ''; publish();
        }
      }).catch(error => { if (!win.isDestroyed()) { progress.active = null; progress.screeningError = error.message; publish(); } });
      return;
    }
    void progress.sync(new URL(url).origin, { manual: manual === true });
  }
  const progressTimer = setInterval(publish, 60000);
  reader.webContents.on('did-finish-load', refreshProgress);
  reader.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { prefetchAnchor = ''; prefetchTargets = []; clearPreloaded(); }
  });

  function publish() {
    if (!win.isDestroyed()) {
      if (!state.screening && !pendingURL && selectedURL && originalPage.displayed && originalPage.ready && !originalPage.failed && !originalPage.issue &&
          progress.active && (roundArticle !== originalPage || roundArticleAccount !== progress.active)) {
        roundArticle = originalPage; roundArticleAccount = progress.active;
        try { progress.openedArticle(progress.active, selectedURL); }
        catch (error) { state.error = error.message; }
      }
      const round = progress.roundSummary(state.screening ? 'saving' : 'reading');
      const blocked = scene.summary().progressStyle === 'lamps' && round.ready && round.done >= round.total;
      if (blocked !== roundBlocked) {
        roundBlocked = blocked;
        if (blocked) {
          dragging = false; dragRequest++; shellContents.send('shell:end-drag');
          win.contentView.addChildView(shellView); shellContents.focus();
        } else {
          for (const view of [reader, original, navigation]) win.contentView.addChildView(view);
          if (state.screening) reader.webContents.focus(); else void focusReading();
        }
        networkProxy.log(blocked ? 'round-completed' : 'round-unblocked', shellURL, { pane: 'shell' });
      }
      reader.webContents.send('reader:round-blocked', roundBlocked);
      reader.webContents.send('reader:round-account', progress.active);
      shellContents.send('shell:state', { ...state, roundBlocked, progressStyle: scene.summary().progressStyle, round, shortcuts: shortcuts.bindings, progress: state.screening ? progress.screeningSummary() : progress.summary(state.progressPeriod),
        cubox: { ...cubox.summary(original.webContents.getURL()), busy: collecting || cubox.busy,
          available: Boolean(selectedURL && originalPage.ready && !originalPage.failed && originalPage.status < 400 && !original.webContents.isLoadingMainFrame() && webURL(original.webContents.getURL())) } });
      const pool = { ready: [...preloaded.values()].filter(page => page.ready).map(page => page.url),
        failed: [...failedPreparations],
        preparing: Boolean(pendingURL) || [...preloaded.values()].some(page => !page.ready) };
      if (originalPage.ready) pool.ready.push(selectedURL);
      const serialized = JSON.stringify(pool);
      if (serialized !== poolState && !reader.webContents.isDestroyed()) {
        poolState = serialized; reader.webContents.send('reader:pool', pool);
      }
      navigationContents.send('shell:state', { canPrevious: state.canPrevious, canNext: state.canNext, preparing: pool.preparing, shortcuts: shortcuts.bindings });
    }
  }
  function broadcastShortcuts() {
    for (const contents of [reader.webContents, original.webContents, shellContents, navigationContents, ...[...preloaded.values()].map(page => page.view.webContents)]) {
      if (contents && !contents.isDestroyed()) contents.send('desktop:bindings', shortcuts.bindings);
    }
  }
  async function focusReading() {
    const page = originalPage;
    const available = () => !roundBlocked && !state.screening && !win.isDestroyed() && win.isFocused() && !settingsWindow && !popups.size && !dragging &&
      page === originalPage && page.ready && !original.webContents.isDestroyed();
    if (!available()) return;
    const focused = webContents.getFocusedWebContents();
    if (focused === reader.webContents) {
      try {
        const editing = await focused.executeJavaScript(`(() => {
          let node = document.activeElement;
          while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
          return Boolean(node?.isContentEditable || node?.closest('input,textarea,select,iframe,[role="textbox"],[role="searchbox"],[role="combobox"],[role="dialog"],dialog'));
        })()`);
        if (editing) return;
      } catch { return; }
    }
    if (available() && (focused !== reader.webContents || webContents.getFocusedWebContents() === focused)) original.webContents.focus();
  }
  function layout() {
    const [width, height] = win.getContentSize();
    if (width <= 0 || height <= 0) return;
    shellView.setBounds({ x: 0, y: 0, width, height });
    listWidth = Math.max(180, Math.min(width - 360, listWidth));
    const split = listHidden ? 0 : listWidth + 6;
    const right = listSide === 'right';
    reader.setBounds(state.screening ? { x: 0, y: 44, width, height: Math.max(0, height - 44) } :
      { x: listHidden ? (right ? width : -listWidth) : (right ? width - listWidth : 0), y: 44, width: listWidth, height: Math.max(0, height - 44) });
    original.setVisible(!state.screening && Boolean(selectedURL));
    original.setBounds({ x: right ? 0 : split, y: 44, width: width - split, height: Math.max(0, height - 44) });
    for (const page of preloaded.values()) page.view.setBounds(original.getBounds());
    navigation.setBounds({ x: 12, y: Math.max(44, height - 60), width: 104, height: 44 });
    navigation.setVisible(!state.screening && Boolean(selectedURL) && listHidden);
    if (dragging || roundBlocked) { if (win.contentView.children.at(-1) !== shellView) win.contentView.addChildView(shellView); }
    else {
      const order = [reader, original, navigation], children = win.contentView.children;
      if (order.some((view, index) => children[children.length - 3 + index] !== view)) {
        for (const view of order) win.contentView.addChildView(view);
      }
    }
    state.listHidden = listHidden;
    state.listWidth = listWidth;
    state.listSide = listSide;
    state.dragging = dragging;
    scene.update({ width: Math.round(listWidth), side: listSide, hidden: listHidden });
    publish();
  }
  function navigate(contents, url, page, proxyTrial = false) {
    if (!page) return contents.loadURL(url).then(() => true);
    return new Promise((resolve, reject) => {
      const generation = page.generation;
      let timer, slowTimer, settled = false;
      page.proxyTrial = proxyTrial; page.navigationURL = url;
      const address = () => page.generation === generation ? page.navigationURL || url : url;
      const route = () => proxyTrial ? 'proxy' : networkProxy.route(address());
      const details = () => ({ route: route(), status: page.status, page: contents.id, attempt: generation,
        stage: page === originalPage ? 'foreground' : 'pool', elapsedMs: Date.now() - page.startedAt });
      logPage('load-start', url, page, details());
      const finish = (error, ok = false) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(slowTimer);
        contents.removeListener('dom-ready', ready); contents.removeListener('destroyed', destroyed);
        logPage(error ? 'load-failed' : ok ? 'document-ready' : 'document-rejected', address(), page, { ...details(), code: error?.code, reason: error?.name });
        if (error) reject(error); else resolve(ok);
      };
      const ready = () => {
        if (settled || contents.isDestroyed() || page.generation !== generation || page.status <= 0) return;
        // The preload reports before dom-ready; keep this synchronous so a late abort cannot win.
        const issue = documentIssue({ title: contents.getTitle(), ...page.documentSummary });
        page.issue = issue;
        if (issue) logPage('verification-required', address(), page);
        finish(null, page.status < 400 && !page.failed && !issue);
      };
      const destroyed = () => finish(Object.assign(new Error('Page closed'), { code: 'ERR_ABORTED' }));
      contents.on('dom-ready', ready); contents.once('destroyed', destroyed);
      if (!proxyTrial) slowTimer = setTimeout(() => {
        if (!settled && page.generation === generation) logPage('prepare-slow', address(), page, details());
      }, 2000);
      const remaining = Math.max(1, page.deadline - Date.now());
      timer = setTimeout(() => {
          if (settled || contents.isDestroyed()) return;
          if (page.generation !== generation) { destroyed(); return; }
          const target = address();
          logPage('document-timeout', target, page, details());
          if (page.status >= 400) finish(null, false);
          else finish(Object.assign(new Error('Document readiness timed out'), { code: 'ERR_TIMED_OUT', url: target }));
          contents.stop();
      }, !proxyTrial && networkProxy.retryHost(url) ? Math.min(5000, remaining) : remaining);
      // Images may still be loading after the document is available to read.
      contents.loadURL(url).then(() => {
        if (page.generation !== generation) destroyed();
        else if (page.status > 0) void ready();
      }, error => finish(error));
    });
  }
  async function load(contents, url, pane, quiet = false, page) {
    const generation = page?.generation;
    await networkProxy.ready;
    if (win.isDestroyed() || contents.isDestroyed() || (page && page.generation !== generation)) return false;
    if (!networkProxy.active || networkProxy.busy) {
      if (!quiet) { state.error = '网络设置尚未就绪，请在设置中保存有效的代理配置'; publish(); }
      return false;
    }
    return navigate(contents, url, page).catch(async error => {
      if (error.code === 'ERR_ABORTED' || win.isDestroyed() || (page && page.generation !== generation)) return false;
      const foregroundOriginal = pane === 'original' && contents === original.webContents;
      if (page) {
        const failedURL = page.failedURL || error.url || url;
        const current = () => !win.isDestroyed() && !contents.isDestroyed() && generation === page.generation && Date.now() < page.deadline;
        const retry = async () => current() && networkProxy.tryProxy(failedURL, error, async () => {
          if (!current()) return false;
          try {
            return await navigate(contents, failedURL, page, true) && current();
          } catch { return false; }
        });
        const attempt = proxyQueue.then(retry);
        proxyQueue = attempt.catch(() => false);
        const retried = await attempt;
        if (!current()) return false;
        if (retried) { if (foregroundOriginal) state.error = ''; publish(); return true; }
      }
      if (!quiet || foregroundOriginal) {
        state.error = networkProxy.error || loadMessage(page?.status || 0, error.code);
        publish();
      }
      return false;
    });
  }
  function createOriginalPage() {
    const page = {
      view: new WebContentsView({ webPreferences: { ...remotePreferences, session: browserSession, preload: path.join(__dirname, 'reader-preload.cjs') } }),
      url: '', status: 0, ready: false, failed: false, generation: 0, navigation: 0, loading: null
    };
    observeRemote('original', page.view, page);
    const id = page.view.webContents.id;
    articlePages.set(id, page);
    page.view.webContents.once('destroyed', () => articlePages.delete(id));
    return page;
  }
  function disposePage(page) {
    page.generation++;
    page.cancel?.();
    if (!win.isDestroyed() && win.contentView.children.includes(page.view)) win.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }
  function clearPreloaded() {
    selection++; pendingURL = ''; state.preparing = false;
    for (const page of preloaded.values()) disposePage(page);
    preloaded.clear();
    failedPreparations.clear();
  }
  function reconcilePreloads() {
    if (state.screening || win.isDestroyed() || prefetchAnchor !== (pendingURL || selectedURL) ||
        !readerURL(reader.webContents.getURL()) || new URL(reader.webContents.getURL()).pathname !== prefetchRoute) return;
    const targets = new Set([pendingURL, ...prefetchTargets].filter(url => url && (url !== selectedURL || url === pendingURL)));
    for (const [url, page] of preloaded) {
      if (!targets.has(url)) { preloaded.delete(url); disposePage(page); }
    }
    if (popups.size) return;
    for (const url of targets) {
      if (preloaded.size >= 2) break;
      if (preloaded.has(url) || failedPreparations.has(url)) continue;
      const page = createOriginalPage();
      page.view.setBounds(original.getBounds()); page.view.setVisible(false);
      page.view.webContents.setAudioMuted(true);
      // Detached preloads cannot take keyboard focus from the visible window.
      preloaded.set(url, page);
      loadPage(page, url, true);
    }
  }
  function loadPage(page, url, quiet = false) {
    page.cancel?.();
    const generation = ++page.generation;
    page.startedAt = Date.now(); page.deadline = page.startedAt + 60000;
    page.url = url; page.ready = false; page.failed = false; page.status = 0; page.issue = ''; page.errorCode = ''; page.documentSummary = undefined;
    let deadlineTimer;
    const cancelled = new Promise(resolve => { page.cancel = () => resolve(false); });
    deadlineTimer = setTimeout(() => {
      page.failed = true; page.generation++;
      logPage('prepare-expired', url, page, { attempt: generation });
      page.cancel(); page.view.webContents.stop();
    }, 60000);
    page.loading = Promise.race([load(page.view.webContents, url, 'original', quiet, page), cancelled]).then(ok => {
      clearTimeout(deadlineTimer);
      if (generation !== page.generation || win.isDestroyed()) return false;
      page.ready = ok && page.status < 400; page.failed = !page.ready;
      return page.ready;
    }).then(ok => {
      if (win.isDestroyed()) return false;
      if (!ok && (page.issue !== 'verification' || pendingURL !== url) && preloaded.get(url) === page) {
        preloaded.delete(url); failedPreparations.add(url); disposePage(page);
      }
      reconcilePreloads(); publish();
      return ok;
    });
    return page.loading;
  }
  async function openOriginal(value) {
    if (state.screening || roundBlocked) return false;
    const url = webURL(value);
    if (!url) return false;
    const request = ++selection;
    pendingURL = url; state.preparing = true; state.error = ''; state.failedURL = '';
    failedPreparations.delete(url);
    let cached = preloaded.get(url);
    if (!cached) {
      while (preloaded.size >= 2) {
        const [key, page] = [...preloaded].at(-1); preloaded.delete(key); disposePage(page);
      }
      cached = createOriginalPage(); cached.view.setBounds(original.getBounds()); cached.view.setVisible(false);
      cached.view.webContents.setAudioMuted(true);
      preloaded.set(url, cached);
      loadPage(cached, url, true);
    }
    reconcilePreloads(); publish();
    const ok = cached.ready || await cached.loading;
    if (request !== selection || win.isDestroyed()) return false;
    pendingURL = ''; state.preparing = false;
    if ((!ok && cached.issue !== 'verification') || cached.view.webContents.isDestroyed()) {
      state.failedURL = url;
      state.error = loadMessage(cached.status, cached.errorCode);
      reconcilePreloads(); publish(); return false;
    }
    preloaded.delete(url);
    logPage('pool-promote', url, cached);
    {
      const previous = originalPage;
      originalPage = cached; original = cached.view;
      originalPage.displayed = true;
      // A promoted hidden view can retain background visibility and drop keyboard input.
      original.webContents.setBackgroundThrottling(false);
      original.webContents.setAudioMuted(false);
      disposePage(previous);
    }
    selectedURL = url;
    state.url = cached?.ready ? original.webContents.getURL() : url;
    state.error = cached.issue === 'verification' ? '请在右侧完成网站验证，再重新点击列表文章；文章仍保留在稍后阅读' : '';
    state.failedURL = cached.issue === 'verification' ? url : '';
    layout();
    restorePosition(originalPage);
    reconcilePreloads();
    void focusReading();
    return Boolean(ok);
  }
  function secureRemote(contents, foreground = () => true, pane = 'popup') {
    observeDiagnostics(contents, pane);
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
        parent: win, width: 1000, height: 800, autoHideMenuBar: true, icon: iconPath,
        webPreferences: { ...remotePreferences, session: browserSession, preload: undefined }
      } };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      clearPreloaded();
      secureRemote(popup.webContents);
      let returnFocus = false;
      popup.on('close', () => { returnFocus = popup.isFocused(); });
      popup.on('closed', () => {
        popups.delete(popup); reconcilePreloads();
        if (returnFocus && !win.isDestroyed() && !settingsWindow && !popups.size) win.focus();
        setImmediate(focusReading);
      });
    });
  }
  function setZoom(contents, change) {
    const percent = change === 0 ? 100 : Math.round(contents.getZoomFactor() * 100) + change;
    contents.setZoomFactor(Math.min(200, Math.max(50, percent)) / 100);
    if (contents === reader.webContents) { state.readerZoom = Math.round(contents.getZoomFactor() * 100); scene.update({ readerZoom: state.readerZoom }); }
    if (contents === original.webContents) { state.originalZoom = Math.round(contents.getZoomFactor() * 100); scene.setZoom(contents.getURL(), state.originalZoom); }
    publish();
  }
  function restorePosition(page) {
    const contents = page.view.webContents, url = webURL(contents.getURL());
    if (!url || page.failed || page.status >= 400) return;
    state.originalZoom = scene.zoom(url); contents.setZoomFactor(state.originalZoom / 100);
    scene.visit(url); contents.send('desktop:restore-position', scene.position(url)); publish();
  }
  function positionChanged(event, message) {
    const page = articlePages.get(event.sender.id);
    if (!page?.displayed || event.senderFrame !== event.sender.mainFrame || !webURL(event.senderFrame.url) || message?.url !== event.senderFrame.url) return;
    scene.remember(message.url, message.x, message.y);
  }
  ipcMain.on('desktop:position-changed', positionChanged);
  function logPage(event, url, page, details = {}) {
    const contents = page.view.webContents;
    if (!webURL(url) || !contents || contents.isDestroyed()) return;
    networkProxy.log(event, url, { page: contents.id, attempt: page.generation, navigation: page.navigation,
      elapsedMs: Date.now() - page.startedAt, stage: page === originalPage ? 'foreground' : 'pool',
      status: page.status, route: page.proxyTrial ? 'proxy' : networkProxy.route(url),
      afterReady: page.ready === true, requested: page.url, ...details });
  }
  function observeDiagnostics(contents, pane) {
    diagnosticContents.set(contents.id, pane);
    const log = (event, url = contents.getURL(), details = {}) => networkProxy.log(event, url || 'about:blank', { pane, page: contents.id, ...details });
    for (const name of ['did-start-navigation', 'did-redirect-navigation']) contents.on(name, (_event, url, _inPlace, main) => {
      log(`page-${name}`, url, { frame: main === false ? 1 : 0 });
    });
    contents.on('did-navigate-in-page', (_event, url, main) => log('page-in-page', url, { frame: main === false ? 1 : 0 }));
    for (const name of ['dom-ready', 'did-finish-load', 'did-stop-loading']) contents.on(name, () => log(`page-${name}`));
    contents.on('did-navigate', (_event, url, status) => log('page-response', url, { status }));
    contents.on('did-fail-load', (_event, code, description, url) => log('page-load-failed', url, { netError: code, code: description }));
    contents.on('render-process-gone', (_event, details) => log('page-process-gone', undefined, { reason: details.reason }));
    contents.on('unresponsive', () => log('page-unresponsive'));
    contents.on('responsive', () => log('page-responsive'));
    contents.once('destroyed', () => { diagnosticContents.delete(contents.id); });
  }
  function diagnostic(event, message) {
    const pane = diagnosticContents.get(event.sender.id);
    if (pane === 'original' && message?.event === 'document-status' && event.senderFrame === event.sender.mainFrame &&
        Number.isSafeInteger(message.length) && message.length >= 0 && typeof message.challenge === 'boolean') {
      const page = articlePages.get(event.sender.id);
      if (page) page.documentSummary = { length: message.length, challenge: message.challenge };
      return;
    }
    if (!pane || !message || !['click', 'aux-click', 'context-menu', 'resource-error', 'script-error', 'script-rejection', 'page-hidden', 'page-background', 'page-visible', 'page-dom-ready', 'page-signal'].includes(message.event)) return;
    const frameURL = event.senderFrame?.url;
    if (!frameURL || !webURL(frameURL) && ![shellURL, navigationURL, settingsURL].includes(frameURL)) return;
    networkProxy.log(message.event, frameURL, { ...message, pane, page: event.sender.id, frame: event.senderFrame.routingId });
  }
  ipcMain.on('desktop:diagnostic', diagnostic);
  for (const contents of [shellContents, navigationContents]) observeDiagnostics(contents, contents === shellContents ? 'shell' : 'navigation');
  function observeRemote(pane, view, page) {
    const contents = view.webContents;
    const foreground = () => pane === 'reader' || page === originalPage;
    secureRemote(contents, foreground, pane);
    contents.on('dom-ready', () => {
      contents.send('desktop:bindings', shortcuts.bindings);
      contents.setZoomFactor(state[`${pane}Zoom`] / 100);
      if (pane === 'original' && foreground() && page.displayed) restorePosition(page);
    });
    for (const name of ['did-start-navigation', 'did-redirect-navigation']) contents.on(name, (_event, url, inPlace, isMainFrame) => {
      if (page && isMainFrame && !inPlace) {
        const from = page.navigationURL || contents.getURL();
        if (name === 'did-start-navigation') page.navigation++;
        page.status = 0; page.failedURL = ''; page.navigationURL = url;
        logPage(name === 'did-start-navigation' ? 'navigation-start' : 'navigation-redirect', url, page, { from });
      }
    });
    contents.on('did-navigate', (_event, url, status) => {
      if (page) { page.status = status; page.failed = status >= 400; }
      if (page) logPage('response', url, page, { status });
      if (!foreground()) return;
      if (pane === 'original') state.url = url;
      if (status >= 400) state.error = loadMessage(status);
      publish();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (page && isMainFrame) { const from = page.navigationURL; page.navigationURL = url; logPage('navigation-in-page', url, page, { from }); }
      if (pane === 'original' && foreground() && isMainFrame) { state.url = url; if (page.displayed && page.ready && !page.failed) scene.visit(url); publish(); }
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (page && isMainFrame && code !== -3) page.errorCode = description;
      if (page && isMainFrame) logPage('navigation-failed', url, page, { netError: code, code: description });
      if (page && isMainFrame && code !== -3) { page.failed = true; page.failedURL = url; }
      if (foreground() && isMainFrame && code !== -3) { state.error = `加载失败：${description}`; publish(); }
    });
    contents.on('did-finish-load', () => { if (page) logPage('navigation-finished', contents.getURL(), page); });
    contents.on('did-stop-loading', () => { if (foreground()) publish(); });
    contents.on('render-process-gone', () => {
      if (page) { page.failed = true; page.ready = false; }
      if (foreground()) { state.error = '页面进程已退出，请重新打开'; publish(); }
    });
  }
  observeRemote('reader', reader);

  function article(event, message) {
    if (state.screening || roundBlocked) return;
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame ||
        !readerURL(event.senderFrame.url) || !message || typeof message.route !== 'string') return;
    if (new URL(event.senderFrame.url).pathname !== message.route || !/\/entries\/[^/]+/.test(message.route)) return;
    if (webURL(message.url) !== selectedURL) openOriginal(message.url);
  }
  async function listArticle(event, message) {
    if (state.screening || roundBlocked) return { ok: false };
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame ||
        !readerURL(event.senderFrame.url) || !message || typeof message.id !== 'string' || !message.id ||
        new URL(event.senderFrame.url).pathname !== message.route || !webURL(message.url)) return { ok: false };
    const later = message.trackCompletion === true && /^\/tags\/!readlater\/?$/.test(decodeURI(message.route));
    if (later) pendingCompletions.delete(message.id);
    let pending;
    if (later) {
      const origin = new URL(event.senderFrame.url).origin;
      pending = { origin, token: progress.track(origin, message.id, { allowRemoved: true }) };
      pendingCompletions.set(message.id, pending);
    }
    const loaded = await openOriginal(message.url);
    if (!loaded && pendingCompletions.get(message.id) === pending) pendingCompletions.delete(message.id);
    return { ok: Boolean(loaded) };
  }
  async function command(event, message) {
    const fromShell = event.sender === shellContents && event.senderFrame === shellContents.mainFrame && event.senderFrame.url === shellURL;
    const fromNavigation = event.sender === navigationContents && event.senderFrame === navigationContents.mainFrame && event.senderFrame.url === navigationURL;
    if ((!fromShell && !fromNavigation) || !message) return;
    const { action, value } = message;
    if (fromNavigation && !['ready', 'previous', 'next'].includes(action)) return;
    networkProxy.log('shell-command', event.senderFrame.url, { pane: fromShell ? 'shell' : 'navigation', page: event.sender.id, action });
    return perform(action, value);
  }
  async function shortcut(event, action) {
    const { sender, senderFrame } = event;
    if (settingsWindow || !['previous', 'next', 'cubox-save'].includes(action) || !shortcuts.bindings[action] || senderFrame !== sender.mainFrame) return;
    const allowed = sender === reader.webContents && readerURL(senderFrame.url) ||
      sender === original.webContents && webURL(senderFrame.url) ||
      sender === shellContents && senderFrame.url === shellURL || sender === navigationContents && senderFrame.url === navigationURL;
    if (allowed) {
      networkProxy.log('shortcut', senderFrame.url, { page: sender.id, action });
      return perform(action);
    }
  }
  ipcMain.on('desktop:shortcut', shortcut);
  async function perform(action, value) {
    if (action === 'round-continue') {
      if (!roundBlocked) return;
      const kind = state.screening ? 'saving' : 'reading';
      try { progress.configureRound({ kind, target: progress.roundSummary(kind).total, reset: true }); }
      catch (error) { state.error = error.message; publish(); }
      return;
    }
    if (roundBlocked && action !== 'ready') return;
    if (action === 'screening') {
      state.screening = !state.screening; state.error = ''; clearPreloaded();
      dragRequest++; dragging = false; shellContents.send('shell:end-drag');
      original.webContents.setAudioMuted(state.screening); original.webContents.setBackgroundThrottling(state.screening);
      state.canPrevious = false; state.canNext = false; layout();
      const current = reader.webContents.getURL(), origin = readerURL(current) ? new URL(current).origin : READER_ORIGINS[0];
      await load(reader.webContents, state.screening ? origin + '/' : scene.data.reader || origin + '/tags/!readlater', 'reader');
      if (state.screening) { if (win.isFocused() && !settingsWindow && !popups.size) reader.webContents.focus(); }
      else void focusReading();
      return;
    }
    if (state.screening && ['previous', 'next', 'cubox-save', 'external', 'toggle-list', 'list-side', 'drag', 'progress-period', 'progress-older'].includes(action)) return;
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
    if (action === 'zoom' && value && ['reader', 'original'].includes(value.pane) && [-10, 0, 10].includes(value.change)) {
      setZoom(value.pane === 'reader' ? reader.webContents : original.webContents, value.change);
    }
    if (action === 'width' && Number.isFinite(value)) { listWidth = value; layout(); }
    if (action === 'toggle-list') { listHidden = !listHidden; layout(); }
    if (action === 'list-side') { listSide = listSide === 'left' ? 'right' : 'left'; layout(); }
    if (action === 'progress-period') { state.progressPeriod = { today: 'week', week: 'all', all: 'today' }[state.progressPeriod]; scene.update({ period: state.progressPeriod }); publish(); }
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
      const url = webURL(state.failedURL || state.url);
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
    if (state.screening) { publish(); return; }
    if (prefetchRoute && prefetchRoute !== message.route) clearPreloaded();
    state.canPrevious = message.previous === true;
    state.canNext = message.next === true;
    prefetchAnchor = webURL(message.current) || '';
    prefetchRoute = message.route;
    scene.setReader(event.senderFrame.url);
    prefetchTargets = Array.isArray(message.upcoming) ? message.upcoming.slice(0, 64).map(webURL).filter(Boolean) : [];
    if (!prefetchAnchor && !pendingURL) clearPreloaded();
    else reconcilePreloads();
    publish();
  }
  ipcMain.on('reader:navigation', navigationState);
  async function completed(event, id) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url)) return;
    const pending = pendingCompletions.get(id);
    if (pending && pending.origin === new URL(event.senderFrame.url).origin) {
      pendingCompletions.delete(id);
      const completedAt = progress.now(), token = await pending.token;
      if (win.isDestroyed()) return;
      if (token) progress.complete(token, completedAt);
      else { state.error = '文章已移出稍后阅读，阅读进度暂未同步；请稍后同步统计'; publish(); }
    }
  }
  function progressChanged(event, message) {
    if (event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame || !readerURL(event.senderFrame.url)) return;
    if (message?.session === true) { changedEntries.clear(); screeningRequests.clear(); progress.active = null; refreshProgress(); return; }
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
  function roundAdded(event, message) {
    if (!state.screening || event.sender !== reader.webContents || event.senderFrame !== reader.webContents.mainFrame ||
        !readerURL(event.senderFrame.url) || message?.route !== new URL(event.senderFrame.url).pathname || message.account !== progress.active ||
        typeof message.account !== 'string' || !message.account.startsWith(new URL(event.senderFrame.url).origin + '|')) return;
    try { progress.addedToLater(message.account, message.id); }
    catch (error) { state.error = error.message; publish(); }
    return roundBlocked;
  }
  ipcMain.handle('reader:round-added', roundAdded);
  ipcMain.on('reader:progress-changed', progressChanged);
  ipcMain.on('shell:command', command);
  for (const contents of [shellContents, navigationContents]) {
    contents.on('dom-ready', () => contents.send('desktop:bindings', shortcuts.bindings));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
  }
  win.on('resize', layout);
  win.on('focus', () => setImmediate(focusReading));
  let flushing = false, flushed = false;
  win.on('close', event => {
    if (flushed) return;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    browserSession.flushStorageData();
    let timer;
    const current = original.webContents, url = current.getURL();
    const capture = originalPage.ready && !originalPage.failed ? current.executeJavaScriptInIsolatedWorld(1001, [{ code: '({x:window.scrollX,y:window.scrollY})' }])
      .then(value => scene.remember(url, value.x, value.y)).catch(() => {}) : Promise.resolve();
    Promise.race([Promise.all([browserSession.cookies.flushStore(), capture]), new Promise(resolve => { timer = setTimeout(resolve, 3000); })])
      .catch(() => {}).finally(() => { clearTimeout(timer); scene.flush(); flushed = true; if (!win.isDestroyed()) win.close(); });
  });
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
    ipcMain.removeHandler('reader:round-added');
    ipcMain.removeListener('reader:progress-changed', progressChanged);
    ipcMain.removeListener('shell:command', command);
    ipcMain.removeListener('desktop:shortcut', shortcut);
    ipcMain.removeListener('desktop:position-changed', positionChanged);
    ipcMain.removeListener('desktop:diagnostic', diagnostic);
    for (const [ses, id] of diagnosticScripts) ses.unregisterPreloadScript(id);
    browserSession.webRequest.onCompleted(null); browserSession.webRequest.onErrorOccurred(null); screeningRequests.clear();
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
  const resumeURL = scene.data.layout.resume && scene.data.last;
  reader.webContents.once('did-finish-load', () => {
    if (!state.screening && resumeURL && !selectedURL && !pendingURL) void openOriginal(resumeURL).then(ok => {
      if (ok && !reader.webContents.isDestroyed()) reader.webContents.send('reader:resume', resumeURL);
    });
  });
  reader.webContents.on('dom-ready', () => reader.webContents.send('reader:screening', state.screening));
  load(reader.webContents, scene.data.reader || `${READER_ORIGINS[0]}/tags/!readlater`, 'reader');
  return { win, shellContents, navigationContents, navigation, reader, get original() { return original; }, preloaded, browserSession, progress, networkProxy };
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
