// Only this app's OSS prefix is writable; advance latest after verifying public bytes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'prepare-mobile-release.cjs')], { stdio: 'inherit' });
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'mobile/android/app/build/outputs/apk/release/output-metadata.json')));
const directory = path.join(root, 'artifacts', `android-${metadata.elements[0].versionName}`);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'latest.json')));
const base = 'https://download.swlyes.top/updates/qireader-filter/';
const prefix = 'updates/qireader-filter/';
const oss = process.env.QIREADER_OSSUTIL || path.join(os.homedir(), '.local/share/kelivo-tools/ossutil-2.4.0-linux-amd64/ossutil');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readPublic(name) {
  const response = execFileSync('curl', ['-sSL', '--max-time', '90', '--write-out', '\n%{http_code}', base + name + '?verify=' + Date.now()], { maxBuffer: 40 * 1024 * 1024 });
  const status = response.subarray(-3).toString();
  if (status === '404') return null;
  if (status !== '200') throw Error(`Public verification failed for ${name}: HTTP ${status}`);
  return response.subarray(0, -4);
}
function upload(file, name, type, immutable) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error('Invalid object name');
  const args = ['api', 'put-object', '--bucket', 'xxs-apk', '--key', prefix + name, '--body', 'file://' + file,
    '--region', 'cn-beijing', '--endpoint', 'https://oss-cn-beijing.aliyuncs.com', '--proxy', 'env', '--content-type', type,
    '--cache-control', immutable ? 'public,max-age=31536000,immutable' : 'no-cache,no-store,must-revalidate'];
  if (immutable) args.push('--forbid-overwrite=true');
  execFileSync(oss, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}
const currentBytes = readPublic('latest.json');
if (currentBytes) {
  const current = JSON.parse(currentBytes);
  if (current.versionCode >= manifest.versionCode && JSON.stringify(current) !== JSON.stringify(manifest)) throw Error('Refusing downgrade or modified republish');
}
const apk = `QiReader-Filter-${manifest.versionName}.apk`;
for (const [local, remote, type] of [
  [apk, apk, 'application/vnd.android.package-archive'],
  ['SHA256SUMS', apk + '.sha256', 'text/plain; charset=utf-8'],
  ['android-update.json', `android-update-${manifest.versionName}.json`, 'application/json; charset=utf-8']
]) {
  const file = path.join(directory, local), expected = hash(fs.readFileSync(file));
  let publicBytes = readPublic(remote);
  if (!publicBytes) { upload(file, remote, type, true); publicBytes = readPublic(remote); }
  if (!publicBytes || hash(publicBytes) !== expected) throw Error('Public object differs: ' + remote);
  console.log('Verified', base + remote, expected);
}
upload(path.join(directory, 'latest.json'), 'latest.json', 'application/json; charset=utf-8', false);
const published = readPublic('latest.json');
if (!published || !published.equals(fs.readFileSync(path.join(directory, 'latest.json')))) throw Error('Published manifest differs');
console.log('Published', base + 'latest.json');
