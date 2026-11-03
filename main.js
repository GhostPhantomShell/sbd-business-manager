// SBD Business Manager — desktop shell.
// The app itself is app/index.html. Day-to-day updates replace that file in the GitHub repo;
// this shell downloads the newer copy on launch, so most updates never need a reinstall.
const { app, BrowserWindow, shell, dialog, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');

const OWNER = 'GhostPhantomShell', REPO = 'sbd-business-manager', BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/app`;
const bundledDir = path.join(__dirname, 'app');
const cacheDir = () => path.join(app.getPath('userData'), 'app-cache');

const readVer = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } };
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; } return false; };

function currentDir() {
  const c = cacheDir();
  if (fs.existsSync(path.join(c, 'index.html')) && newer(readVer(c), readVer(bundledDir))) return c;
  return bundledDir;
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 600,
    backgroundColor: '#0F0E0E', title: 'SBD Business Manager',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.loadFile(path.join(currentDir(), 'index.html'));
  // Open web links in the normal browser, keep the app window on the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, cache: 'no-cache' });
    let body = '';
    req.on('response', res => { if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; } res.on('data', d => body += d); res.on('end', () => resolve(body)); });
    req.on('error', reject); req.end();
  });
}

async function checkContentUpdate() {
  try {
    const remote = JSON.parse(await fetchText(`${RAW}/version.json?t=${Date.now()}`)).version;
    const local = readVer(currentDir());
    if (!remote || !newer(remote, local)) return;
    const html = await fetchText(`${RAW}/index.html?t=${Date.now()}`);
    if (!html.includes('SBD Business Manager')) return; // sanity check
    const c = cacheDir(); fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, 'index.html'), html);
    fs.writeFileSync(path.join(c, 'version.json'), JSON.stringify({ version: remote }));
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready', message: `SBD Business Manager ${remote} is ready.`, detail: 'Restart now to use it, or it will load the next time you open the app.'
    });
    if (response === 0 && win) win.loadFile(path.join(c, 'index.html'));
  } catch (_) { /* offline or repo not reachable: keep the current version */ }
}

function checkShellUpdate() {
  // Full installer updates (rare). Windows only: macOS requires a paid Apple certificate for this.
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try { const { autoUpdater } = require('electron-updater'); autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch (_) {}
}

const menuTemplate = [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { label: 'File', submenu: [{ label: 'Check for updates', click: () => checkContentUpdate() }, { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }] },
  { role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
  { role: 'windowMenu' }
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  setTimeout(checkContentUpdate, 3000);
  checkShellUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
