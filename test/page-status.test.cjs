const { test } = require('node:test');
const assert = require('node:assert/strict');
const { documentIssue, loadMessage } = require('../page-status.cjs');
test('verification pages cannot be mistaken for readable HTTP 200 articles', () => {
  for (const title of ['安全验证 - 虎嗅', '验证码', 'Just a moment...', 'Verify you are human']) {
    assert.equal(documentIssue({ title, length: 300, challenge: false }), 'verification');
  }
  assert.equal(documentIssue({ title: '知乎', length: 500, challenge: true }), 'verification');
  assert.equal(documentIssue({ title: '如何实现验证码', length: 1200, challenge: false }), '');
  assert.equal(documentIssue({ title: '安全验证技术详解', length: 1200, challenge: false }), '');
  assert.equal(documentIssue({ title: '安全验证技术详解', length: 20000, challenge: false }), '');
});
test('site errors and proxy failures get distinct actionable messages', () => {
  assert.match(loadMessage(403), /登录或验证/);
  assert.match(loadMessage(404), /链接失效或站点拦截/);
  assert.match(loadMessage(429), /频率/);
  assert.match(loadMessage(503), /HTTP 503/);
  assert.match(loadMessage(0, 'ERR_PROXY_CONNECTION_FAILED'), /国内站点可使用直连/);
});
