const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Cubox, apiURL } = require('../cubox.cjs');
const link = 'https://cubox.pro/c/api/save/test_secret_123';
const article = 'https://www.zhihu.com/question/123';
const key = crypto.randomBytes(32);
const storage = {
  getSelectedStorageBackend: () => 'test-encrypted',
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async text => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decryptStringAsync: async data => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return { result: Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString() };
  }
};
function setup(t, fetch = async () => Response.json({ code: 200 }), store = storage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubox-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Cubox({ file: path.join(dir, 'settings.json'), storage: store, fetch });
}
const input = { link, folder: ' 阅读 ', tags: '学习, 科技，学习' };
test('API URL accepts only official HTTPS personal save endpoints', () => {
  assert.equal(apiURL(link + '/'), link);
  assert.ok(apiURL(link.replace('.pro', '.cc')));
  for (const url of [link.replace('https:', 'http:'), link + '?leak=1', link + '#x', link.replace('.pro', '.pro.evil.org'), link.replace('cubox.pro', 'user@cubox.pro'), link.replace('cubox.pro', 'cubox.pro:8443'), link.replace('/save/', '/other/'), 'file:///secret']) assert.equal(apiURL(url), null);
});
test('settings encrypted on disk, restored without revealing key, invalid changes preserve configuration', async t => {
  const service = setup(t); await service.configure(input);
  assert.ok(!fs.readFileSync(service.file, 'utf8').includes('test_secret'));
  assert.ok(!JSON.stringify(service.summary()).includes('test_secret'));
  const restored = new Cubox({ file: service.file, storage, fetch: service.fetch }); await restored.ready;
  assert.equal(restored.summary().configured, true);
  assert.deepEqual(restored.summary().tags, ['学习', '科技']);
  await restored.configure({ link: '', folder: '', tags: '' });
  assert.equal(restored.config.link, link);
  await assert.rejects(restored.configure({ ...input, link: 'https://evil.org/key' }));
  assert.equal(restored.config.link, link);
  await restored.clear(); assert.equal(fs.existsSync(service.file), false);
  assert.equal(restored.summary().configured, false);
});
test('unavailable encryption never falls back to plaintext', async t => {
  const service = setup(t, undefined, { ...storage, isAsyncEncryptionAvailable: async () => false });
  await assert.rejects(service.configure(input), /安全存储/);
  assert.equal(fs.existsSync(service.file), false);
});
test('sends explicit URL/title only, omits cookies and redirects, prevents concurrent and duplicate posts', async t => {
  let finish; const calls = [];
  const service = setup(t, (url, options) => { calls.push({ url, options }); return new Promise(resolve => { finish = resolve; }); });
  await service.configure(input);
  const pending = service.collect(article, ' 标题 '); await Promise.resolve();
  await assert.rejects(service.collect(article, '标题'), /正在提交/);
  await assert.rejects(service.clear(), /正在提交/);
  finish(Response.json({ code: 200 })); await pending;
  await service.collect(article, '标题'); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { type: 'url', content: article, title: '标题', folder: '阅读', tags: ['学习', '科技'] });
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(service.summary(article).submitted, true);
  assert.equal(service.summary(article + '4').submitted, false);
});
test('HTTP and business errors never count as accepted or expose response secrets; no automatic retries', async t => {
  for (const response of [() => Response.json({ code: 401, message: link }), () => new Response(link, { status: 401 }), () => new Response(link, { status: 429 }), () => new Response(link), () => { throw Error(link); }]) {
    let calls = 0;
    const service = setup(t, async () => { calls++; return response(); }); await service.configure(input);
    await assert.rejects(service.collect(article, ''), error => !error.message.includes('test_secret'));
    assert.equal(service.summary(article).submitted, false); assert.equal(service.busy, false); assert.equal(calls, 1);
  }
});
