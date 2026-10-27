const $ = id => document.getElementById(id);
let currentProxy;
function proxyMode() {
  const custom = $('proxy-mode').value === 'custom';
  $('proxy-address').disabled = !custom; $('proxy-address').required = custom;
  $('proxy-scope').disabled = !custom;
  $('proxy-domains').disabled = !custom || $('proxy-scope').value !== 'selected';
  $('proxy-auto').disabled = $('proxy-domains').disabled;
  $('proxy-domains').required = !$('proxy-domains').disabled && !$('proxy-auto').checked;
}
function showProxy(info) {
  currentProxy = info;
  $('proxy-mode').value = info.mode; $('proxy-address').value = info.address;
  $('proxy-scope').value = info.scope; $('proxy-domains').value = info.domains.join('\n');
  $('proxy-auto').checked = info.autoLearn;
  proxyMode(); $('save-proxy').disabled = false; $('proxy-result').textContent = info.error || '';
}
for (const id of ['proxy-mode', 'proxy-scope', 'proxy-auto']) $(id).addEventListener('change', proxyMode);
$('proxy').addEventListener('submit', async event => {
  event.preventDefault(); $('save-proxy').disabled = true; $('proxy-result').classList.remove('success');
  const mode = $('proxy-mode').value, scope = $('proxy-scope').value;
  const value = { mode, scope, autoLearn: $('proxy-auto').checked, address: mode === 'custom' ? $('proxy-address').value : currentProxy.address,
    domains: mode === 'custom' && scope === 'selected' ? $('proxy-domains').value : currentProxy.domains.join('\n') };
  const result = await request('proxy-configure', value); $('save-proxy').disabled = false;
  if (result.ok) { showProxy(result.proxy); $('proxy-result').classList.add('success'); $('proxy-result').textContent = '代理已应用，页面正在重新加载；原登录信息保留。'; }
  else $('proxy-result').textContent = result.error;
});
let currentGoals;
function goalMode(period) { $(`${period}-target`).disabled = $(`${period}-auto`).checked; }
function showGoals(goals) {
  currentGoals = goals;
  for (const period of ['today', 'week']) {
    $(`${period}-target`).value = goals[period].target;
    $(`${period}-auto`).checked = goals[period].automatic;
    goalMode(period);
  }
  $('save-goals').disabled = !goals.today.ready;
  $('goals-result').textContent = goals.today.ready ? '' : '登录并等待统计初始化后即可设置目标。';
}
for (const period of ['today', 'week']) $(`${period}-auto`).addEventListener('change', () => goalMode(period));
$('goals').addEventListener('submit', async event => {
  event.preventDefault(); $('save-goals').disabled = true; $('goals-result').classList.remove('success');
  const goals = Object.fromEntries(['today', 'week'].map(period => [period, {
    automatic: $(`${period}-auto`).checked,
    target: $(`${period}-auto`).checked ? currentGoals[period].target : Number($(`${period}-target`).value)
  }]));
  const result = await request('goals-configure', goals);
  $('save-goals').disabled = false;
  if (result.ok) { showGoals(result.goals); $('goals-result').classList.add('success'); $('goals-result').textContent = '阅读目标已保存。'; }
  else $('goals-result').textContent = result.error;
});
function show(info) {
  $('api-link').value = '';
  $('api-link').placeholder = info.configured ? '已保存；留空继续使用，输入新链接可替换' : 'https://cubox.pro/c/api/save/…';
  $('configured').textContent = info.configured ? `已配置 ${info.server}。API 链接已加密保存在本机。` : '链接将加密保存在本机，不会提供给文章网页。';
  $('folder').value = info.folder;
  $('tags').value = info.tags.join(', ');
  $('clear').disabled = !info.configured && !info.error;
  $('result').textContent = info.error || '';
}
function busy(value) { for (const id of ['save', 'clear', 'api-link', 'folder', 'tags']) $(id).disabled = value; }
async function request(action, value) {
  try { return await window.desktop.request(action, value); }
  catch { return { ok: false, error: '操作未完成，请关闭后重试' }; }
}
for (const region of ['pro', 'cc']) $(`open-${region}`).addEventListener('click', () => { void request('cubox-open-web', region); });
$('close').addEventListener('click', () => window.close());
$('settings').addEventListener('submit', async event => {
  event.preventDefault(); busy(true); $('result').classList.remove('success');
  const result = await request('cubox-configure', { link: $('api-link').value, folder: $('folder').value, tags: $('tags').value });
  busy(false);
  if (result.ok) {
    show(result.info); $('result').classList.add('success');
    $('result').textContent = '设置已保存。关闭此窗口后，点击顶部「收藏」即可提交当前文章。';
  } else $('result').textContent = result.error;
});
$('clear').addEventListener('click', async () => {
  busy(true);
  const result = await request('cubox-clear'); busy(false);
  if (result.ok) { show(result.info); $('result').classList.add('success'); $('result').textContent = '本机配置已清除。'; }
  else { $('result').classList.remove('success'); $('result').textContent = result.error; }
});
request('settings-info').then(result => {
  if (result.ok) { show(result.info); showGoals(result.goals); showProxy(result.proxy); } else $('result').textContent = result.error;
});
