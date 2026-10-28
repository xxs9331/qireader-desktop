for (const action of ['previous', 'next']) {
  document.getElementById(action).addEventListener('click', () => window.desktop.command(action));
}
window.desktop.onState(state => {
  document.getElementById('previous').disabled = !state.canPrevious;
  document.getElementById('next').disabled = !state.canNext;
  const previous = state.shortcuts?.previous, next = state.shortcuts?.next;
  document.getElementById('previous').title = '上一篇文章' + (previous ? `（${previous}）` : '');
  document.getElementById('next').title = (state.canNext ? '下一篇已就绪的文章' : state.preparing ? '文章正在后台准备，当前页面保持不变' : '暂无已就绪文章，可展开列表选择或重试') + (next ? `（${next}）` : '');
  for (const action of ['previous', 'next']) document.getElementById(action).setAttribute('aria-keyshortcuts', (state.shortcuts?.[action] || '').replace(/\bCtrl\b/g, 'Control'));
});
window.desktop.command('ready');
