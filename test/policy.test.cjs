const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webURL, readerURL } = require('../policy.cjs');

test('only credential-free web addresses can enter a remote view or external browser', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'mailto:x@y.com', 'https://user:pass@x.com', null, {}, 'x'.repeat(17000)]) {
    assert.equal(webURL(value), null);
  }
  assert.equal(webURL('https://www.zhihu.com/question/123'), 'https://www.zhihu.com/question/123');
  assert.equal(webURL('http://example.com'), 'http://example.com/');
});
test('QiReader bridge trusts exact HTTPS origins only', () => {
  assert.ok(readerURL('https://www.qireader.com/tags/!readlater'));
  assert.ok(readerURL('https://www.qireader.com.cn/'));
  for (const url of ['http://www.qireader.com/', 'https://www.qireader.com.evil.test/', 'https://www.qireader.com:444/', 'https://evil.test/?q=https://www.qireader.com']) assert.equal(readerURL(url), false);
});
