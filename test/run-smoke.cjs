const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-desktop-test-'));
const testDay = String(Date.now());
let passed = false;
try {
  for (const phase of ['first', 'restart', 'resume-off', 'budget', 'screening', 'screening-restart', 'diagnostics']) {
    const result = spawnSync(require('electron'), [path.join(__dirname, phase === 'diagnostics' ? 'diagnostics-smoke.cjs' : 'smoke.cjs')], {
      stdio: 'inherit', timeout: 150000, killSignal: 'SIGKILL',
      env: { ...process.env, QIREADER_TEST_PROFILE: profile, QIREADER_TEST_PHASE: phase, QIREADER_TEST_DAY: testDay }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Browser checks failed (${phase}, exit ${result.status})`);
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(profile, { recursive: true, force: true });
  else console.error(`Failed test profile and diagnostics retained: ${profile}`);
}
