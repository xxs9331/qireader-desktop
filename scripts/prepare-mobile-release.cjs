const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const built = path.join(root, 'mobile/android/app/build/outputs/apk/release');
const metadata = JSON.parse(fs.readFileSync(path.join(built, 'output-metadata.json')));
const version = metadata.elements?.[0];
if (metadata.applicationId !== 'com.qireader.filter' || metadata.elements.length !== 1 ||
    !Number.isInteger(version.versionCode) || version.versionCode < 1 || !/^\d+\.\d+\.\d+$/.test(version.versionName) ||
    version.outputFile !== 'app-release.apk') throw Error('Unexpected Android build metadata');
const apk = path.join(built, version.outputFile);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw Error('Set ANDROID_HOME to verify the release signature');
const tools = path.join(sdk, 'build-tools', process.env.QIREADER_BUILD_TOOLS || '36.0.0', 'apksigner');
const verification = execFileSync(tools, ['verify', '--verbose', '--print-certs', apk], { encoding: 'utf8' });
if (!verification.includes('certificate SHA-256 digest: 5187ed9d9a1de2383e4210f1259d42b1623d8caccfb1d506c8baa58608661fa9')) throw Error('APK does not use the original mobile release signing key');
console.log(verification.trim());
const content = fs.readFileSync(apk);
if (content.length > 32 * 1024 * 1024) throw Error('APK exceeds the in-app download limit');
const name = `QiReader-Filter-${version.versionName}.apk`;
const sha256 = crypto.createHash('sha256').update(content).digest('hex');
const info = {
  versionCode: version.versionCode, versionName: version.versionName,
  url: `https://github.com/xxs9331/qireader-desktop/releases/download/android-v${version.versionName}/${name}`, sha256
};
const directory = path.join(root, 'artifacts', `android-${version.versionName}`);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, name), content);
const json = JSON.stringify(info, null, 2) + '\n';
fs.writeFileSync(path.join(directory, 'android-update.json'), json);
fs.writeFileSync(path.join(root, 'mobile/android/update.json'), json);
fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${sha256}  ${name}\n`);
console.log(`Prepared ${directory}; commit update.json and upload these three files to android-v${version.versionName}`);
