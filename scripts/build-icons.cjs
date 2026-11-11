// Run with Electron: electron scripts/build-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = path.join(__dirname, '..', 'assets');
  const svg = fs.readFileSync(path.join(directory, 'icon.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, transparent: true, width: 256, height: 256, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0;width:256px;height:256px;overflow:hidden}svg{width:256px;height:256px}</style>${svg}`));
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(directory, 'icon.png'), image.resize({ width: 256, height: 256 }).toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size; header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('Generated icon.png and seven-resolution icon.ico');
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
