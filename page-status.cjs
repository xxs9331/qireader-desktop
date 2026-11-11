function documentIssue(summary) {
  return summary && (summary.challenge === true || summary.length < 6000 &&
    /^(?:安全验证|访问验证|人机验证|验证码|请完成验证|just a moment|verify you are human|security verification|access verification)(?:$|[\s.!…:：|·_—–-])/i.test(String(summary.title).trim())) ? 'verification' : '';
}
function loadMessage(status, code) {
  if (status === 403) return '网页加载失败（HTTP 403）：网站拒绝访问，可能需要登录或验证；可外部打开原文';
  if (status === 404) return '网页加载失败（HTTP 404）：可能是链接失效或站点拦截；可外部打开核对';
  if (status === 429) return '网页加载失败（HTTP 429）：网站限制访问频率，请稍后重试';
  if (status >= 400) return `网页加载失败（HTTP ${status}）`;
  if (code === 'ERR_PROXY_CONNECTION_FAILED' || code === 'ERR_TUNNEL_CONNECTION_FAILED') return '代理连接失败，请检查设置；国内站点可使用直连';
  return code ? `加载失败：${code}` : '网页加载失败，请重试或外部打开原文';
}
module.exports = { documentIssue, loadMessage };
