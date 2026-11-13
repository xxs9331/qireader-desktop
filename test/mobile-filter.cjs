// Synthetic mobile browser verification; not an Android device or real account test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.QIREADER_PLAYWRIGHT || 'playwright');
const fixture = require('./screening-fixture.cjs');
const script = fs.readFileSync(path.join(__dirname, '../mobile/android/app/src/main/assets/filter.js'), 'utf8');
const mock = `
window.nativeStates=[];window.errors=[];window.nativeUser='';
window.qireaderMobile={postMessage(raw){setTimeout(()=>{
 const m=JSON.parse(raw);let ids=JSON.parse(localStorage.getItem('mock-native:'+m.user)||'[]');
 if(m.action==='ready')window.nativeUser=m.user;
 if(m.action==='saved'&&m.user===window.nativeUser&&ids.length<5&&!ids.includes(m.id)){ids.push(m.id);localStorage.setItem('mock-native:'+m.user,JSON.stringify(ids));}
 if(m.action==='error')window.errors.push(m.message);
 if(m.action==='settings')window.settingsOpened=true;
 const state={target:5,count:ids.length,blocked:ids.length>=5};window.nativeStates.push(state);
 window.qireaderMobile.onmessage({data:JSON.stringify({request:m.request,ok:true,state})});
},20)}};
`;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.QIREADER_CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let user = 'alice'; const adds = []; let rejectBad = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'https://www.qireader.com') return route.abort();
      if (url.pathname === '/api/session/user') return route.fulfill({ json: { result: { id: user } } });
      if (url.pathname.startsWith('/api/entries/') && request.method() === 'PUT') {
        const id = url.pathname.split('/').at(-3); adds.push(id);
        if (id === 'bad' && rejectBad) { rejectBad = false; return route.fulfill({ status: 503, json: {} }); }
        return route.fulfill({ status: 200, json: { result: {} } });
      }
      const body = fixture.html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
        .replace('<button title="视图选项" id="options">视图选项</button>', '<nav id="original-nav" style="height:48px;display:flex;align-items:center"><span>全部订阅源</span><button title="视图选项" id="options">⋮</button></nav>');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    await context.addInitScript({ content: mock + script });
    const page = await context.newPage(); await page.goto('https://www.qireader.com/');
    await page.waitForFunction(() => window.nativeUser === 'alice' && window.prefs.magazine);
    await page.waitForFunction(() => document.querySelector('#original-nav #qi-filter-controls'));
    assert.equal(await page.locator('nav').count(), 1, 'A second app navigation bar was added');
    assert.equal(await page.locator('#qi-filter-lamps span').count(), 5);
    await page.locator('#qi-filter-controls button').click();
    await page.waitForFunction(() => window.settingsOpened);
    const click = id => page.evaluate(id => document.querySelector('[data-is-entry="'+id+'"] a').click(), id);
    const count = async number => page.waitForFunction(number => JSON.parse(localStorage.getItem('mock-native:alice') || '[]').length === number, number);
    await click('screen-a'); await count(1);
    assert.equal(await page.locator('#qi-filter-lamps .lit').count(), 1, 'Confirmed save did not light a lamp');
    await click('screen-a'); await click('already'); await page.waitForTimeout(100);
    assert.deepEqual(adds, ['screen-a']);
    await click('bad'); await page.waitForFunction(() => window.errors.some(message => message.includes('服务器确认')));
    await count(1); await click('bad'); await count(2);
    await page.evaluate(() => {
      window.menuWasHidden = false;
      const row = document.querySelector('[data-is-entry="menu-only"]');
      row.addEventListener('contextmenu', () => {
        window.menuWasHidden = document.documentElement.classList.contains('qi-filter-native-menu');
      });
    });
    await click('menu-only'); await count(3);
    assert.equal(await page.evaluate(() => window.menuWasHidden), true, 'Automatic context menu was visible');
    await page.waitForFunction(() => !document.documentElement.classList.contains('qi-filter-native-menu'));
    assert.equal(await page.locator('#portal').textContent(), '', 'Context menu remained after the save');
    await page.evaluate(() => document.querySelector('#original-nav').outerHTML = '<nav id="original-nav" style="height:48px;display:flex;align-items:center"><span>新的订阅源</span></nav>');
    await page.waitForFunction(() => document.querySelector('#original-nav #qi-filter-controls'));
    assert.equal(await page.locator('nav').count(), 1, 'SPA navigation duplicated the toolbar');
    await page.evaluate(() => document.getElementById('original-nav').remove());
    await page.waitForFunction(() => document.querySelector('#qi-filter-fallback #qi-filter-controls'));
    assert.equal(await page.locator('nav').count(), 1);
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<nav id="original-nav" style="height:48px;display:flex"><span>全部订阅源</span></nav>'));
    await page.waitForFunction(() => document.querySelector('#original-nav #qi-filter-controls') && !document.getElementById('qi-filter-fallback'));
    await click('tail'); await count(4);
    await page.evaluate(() => {
      const row=document.createElement('div');row.setAttribute('data-is-entry','extra');
      row.innerHTML='<a data-is-entry-title>extra</a><button title="稍后阅读"><svg fill="none"></svg></button>';
      row.querySelector('button').onclick=()=>fetch('/api/entries/saved/extra/tags/later',{method:'PUT'});
      document.getElementById('items').append(row);
      document.querySelector('[data-is-entry="screen-b"] a').click();row.querySelector('a').click();
    });
    await count(5); await page.waitForTimeout(150);
    assert.equal(await page.locator('#qi-filter-lamps .lit').count(), 5);
    await page.evaluate(() => window.qiFilter.update({target:12,count:3,blocked:false}));
    assert.equal(await page.locator('#qi-filter-lamps span').count(), 12);
    assert.equal(await page.locator('#qi-filter-lamps .lit').count(), 3);
    await page.evaluate(() => window.qiFilter.update({target:5,count:5,blocked:true}));
    fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../artifacts/mobile-merged-nav.png') });
    assert.equal(adds.includes('extra'), false, 'Queued save crossed the five-item boundary');
    await click('extra'); await page.waitForTimeout(100); assert.equal(adds.includes('extra'), false);
    assert.equal(await page.evaluate(() => window.nativeOpened), false, 'Selection opened article reader');
    assert.equal(await page.evaluate(() => window.prefs.scroll), false, 'Mobile must not enable unrelated read-on-scroll');
    user = 'bob'; await page.evaluate(() => window.qiFilter.refresh()); await click('extra');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-native:bob') || '[]').length === 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-native:alice')).length), 5, 'Switching accounts changed another round');
    await page.reload(); await page.waitForFunction(() => window.nativeUser === 'bob');
    assert.equal(await page.evaluate(() => window.nativeStates.at(-1).count), 1, 'Round did not restore after reload');
    assert.equal(await page.locator('#qi-filter-lamps .lit').count(), 1);
    console.log('PASS: single merged navigation with settings, lamp counts and SPA replacement; invisible automatic menus; confirmed saves and five-item boundary; account isolation and reload');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
