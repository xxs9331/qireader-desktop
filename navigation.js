for (const action of ['previous', 'next']) {
  document.getElementById(action).addEventListener('click', () => window.desktop.command(action));
}
window.desktop.onState(state => {
  document.getElementById('previous').disabled = !state.canPrevious;
  document.getElementById('next').disabled = !state.canNext;
});
window.desktop.command('ready');
