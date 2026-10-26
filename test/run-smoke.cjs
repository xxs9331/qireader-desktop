const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qireader-desktop-test-'));
try {
  for (const phase of ['first', 'restart']) {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'smoke.cjs')], {
      stdio: 'inherit', timeout: 60000,
      env: { ...process.env, QIREADER_TEST_PROFILE: profile, QIREADER_TEST_PHASE: phase }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Browser checks failed (${phase}, exit ${result.status})`);
  }
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
