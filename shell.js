const $ = id => document.getElementById(id);
for (const action of ['toggle-list', 'list-side', 'external', 'cubox-save', 'settings']) $(action).addEventListener('click', () => window.desktop.command(action));
for (const [id, action] of [['progress-period', 'progress-period'], ['progress-count', 'progress-refresh'], ['progress-older', 'progress-older']]) {
  $(id).addEventListener('click', () => window.desktop.command(action));
}
$('error').addEventListener('click', () => window.desktop.command('dismiss-error'));
document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
  window.desktop.command('zoom', { pane: button.dataset.pane, change: Number(button.dataset.zoom) });
}));
let dragging = false;
let width = 280;
let side = 'left';
let startX = 0, startWidth = 280;
const splitter = $('splitter');
function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('resizing');
  window.desktop.command('drag', false);
}
splitter.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  startX = event.clientX;
  startWidth = width;
  splitter.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  window.desktop.command('drag', true);
});
window.addEventListener('pointermove', event => {
  if (dragging && (event.buttons & 1)) window.desktop.command('width', startWidth + (event.clientX - startX) * (side === 'left' ? 1 : -1));
});
window.addEventListener('pointerup', endDrag);
splitter.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);
window.addEventListener('keydown', event => { if (event.key === 'Escape') endDrag(); });
splitter.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  window.desktop.command('width', width + (event.key === 'ArrowLeft' ? -20 : 20) * (side === 'left' ? 1 : -1));
});
window.desktop.onEndDrag(endDrag);
window.desktop.onPreview(images => { $('reader-preview').src = images[0]; $('original-preview').src = images[1]; });
window.desktop.onState(state => {
  width = state.listWidth;
  side = state.listSide;
  document.body.classList.toggle('list-right', side === 'right');
  $('list-side').textContent = side === 'left' ? '列表置右' : '列表置左';
  $('list-side').title = side === 'left' ? '将列表移到右侧' : '将列表移到左侧';
  document.documentElement.style.setProperty('--list-width', `${width}px`);
  document.body.classList.toggle('previewing', Boolean(state.dragging));
  splitter.hidden = state.listHidden;
  splitter.setAttribute('aria-valuenow', width);
  splitter.setAttribute('aria-valuemax', innerWidth - 360);
  $('toggle-list').textContent = state.listHidden ? '▸' : '▾';
  $('toggle-list').title = state.listHidden ? '展开列表' : '收起列表';
  $('toggle-list').setAttribute('aria-label', $('toggle-list').title);
  $('toggle-list').setAttribute('aria-expanded', String(!state.listHidden));
  $('list-zoom-controls').hidden = state.listHidden;
  $('reader-zoom').textContent = `${state.readerZoom}%`;
  $('original-zoom').textContent = `${state.originalZoom}%`;
  $('external').disabled = !state.url;
  if (state.cubox) {
    const info = state.cubox;
    $('cubox-save').textContent = info.busy ? '收藏中' : info.submitted ? '已提交 ✓' : '收藏';
    $('cubox-save').disabled = info.busy || (info.configured && (!info.available || info.submitted));
    $('cubox-save').title = info.submitted ? '已提交到 Cubox，正文由 Cubox 后台解析' : info.configured ? '收藏当前文章到 Cubox' : '设置 Cubox API 链接';
  }
  $('error').textContent = state.error || '';
  $('error').title = `${state.error || ''}（点击关闭提示）`;
  $('error').hidden = !state.error;
  $('reading-status').hidden = Boolean(state.error);
  const stats = state.progress;
  if (stats) {
    $('progress-period').textContent = { today: '今日', week: '本周', all: '全部' }[state.progressPeriod];
    $('reading-status').classList.toggle('stale', Boolean(stats.error));
    const result = stats.automatic ? (stats.total === 0 ? '暂无文章' : stats.remaining ? `剩余 ${stats.remaining}` : '已全部看完') : stats.reached ? '已达标 ✓' : `还需 ${stats.remaining}`;
    const count = stats.ready ? `已完成 ${stats.done} / ${stats.total} · ${result}` : '等待同步';
    $('progress-count').textContent = stats.error ? (stats.ready ? `${count} · 待同步` : '统计未同步 ↻') : stats.loading ? (stats.ready ? `${count} ↻` : '同步中…') : count;
    $('progress-count').disabled = stats.loading;
    $('reading-progress').max = Math.max(1, stats.total);
    $('reading-progress').value = Math.min(stats.done, stats.total);
    $('reading-progress').setAttribute('aria-valuetext', stats.ready ? count : '统计尚未同步');
    $('progress-older').hidden = !stats.ready || !stats.older;
    $('progress-older').textContent = `往期 ${stats.older}`;
    $('progress-count').title = [
      stats.automatic ? '自动模式：按当前周期收录的稍后阅读文章统计；周一开始。重新加入后恢复待看。' :
        '手动目标：按本机确认完成的日期统计，周一开始；阅读以前收录的文章也计入。每篇文章在当前周期最多计一次，重新加入不扣除已完成量。',
      '仅统计稍后阅读；服务器确认移出后计为完成（含手动移出）。旧版本未记录完成日期，不能补算目标进度；其他设备的移出不推测完成日期。',
      stats.startedAt ? `记录始于 ${new Date(stats.startedAt).toLocaleString()}，启用前已移出的文章无法补回。` : '首次同步后开始记录；启用前已移出的文章无法补回。',
      stats.updatedAt ? `最近完整同步：${new Date(stats.updatedAt).toLocaleString()}。` : '',
      stats.error, '本机阅读即时更新；启动时最多每天自动全量同步一次。',
      '其他设备的变动可手动同步（间隔至少 30 分钟）；每日统计列表请求上限 100 次。'
    ].filter(Boolean).join('\n');
  }
});
window.desktop.command('ready');
