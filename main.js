// SBD Business Manager — desktop shell.
// The app itself is app/index.html. Day-to-day updates replace that file in the GitHub repo;
// this shell downloads the newer copy on launch, so most updates never need a reinstall.
// It keeps the last few versions so you can go back (File → Go back to a previous version),
// and it returns to the last working version by itself if a new one fails to start.
const { app, BrowserWindow, shell, dialog, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');

const OWNER = 'GhostPhantomShell', REPO = 'sbd-business-manager', BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/app`;
const KEEP = 3;                      // versions kept on this computer
const START_TIMEOUT = 25000;         // a version that hasn't drawn the app by then counts as failed
const bundledDir = path.join(__dirname, 'app');
const userDir = () => app.getPath('userData');
const versionsDir = () => path.join(userDir(), 'app-versions');
const legacyCacheDir = () => path.join(userDir(), 'app-cache');
const stateFile = () => path.join(userDir(), 'app-state.json');

const readVer = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } };
const cmp = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };
const newer = (a, b) => cmp(a, b) > 0;
const loadState = () => { try { return { pinned: null, bad: [], ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { return { pinned: null, bad: [] }; } };
const saveState = s => { try { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); } catch (_) {} };

function ensureVendor(dir) {
  // Updated pages live in the user folder; give them the bundled libraries too.
  try {
    const src = path.join(bundledDir, 'vendor'), dst = path.join(dir, 'vendor');
    if (dir === bundledDir || !fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) { const t = path.join(dst, f); if (!fs.existsSync(t)) fs.copyFileSync(path.join(src, f), t); }
  } catch (_) {}
}

// All versions available on this computer, newest first: [{version, dir, bundled}]
function installed() {
  const list = [{ version: readVer(bundledDir), dir: bundledDir, bundled: true }];
  try {
    for (const v of fs.readdirSync(versionsDir())) {
      const dir = path.join(versionsDir(), v);
      if (fs.existsSync(path.join(dir, 'index.html'))) list.push({ version: readVer(dir), dir, bundled: false });
    }
  } catch (_) {}
  // Older shells kept one updated copy in app-cache; keep using it until a newer version arrives.
  const lc = legacyCacheDir();
  if (fs.existsSync(path.join(lc, 'index.html')) && !list.some(x => x.version === readVer(lc))) list.push({ version: readVer(lc), dir: lc, bundled: false });
  const seen = new Set();
  return list.filter(x => !seen.has(x.version) && seen.add(x.version)).sort((a, b) => cmp(b.version, a.version));
}

function pickVersion() {
  const st = loadState(); const all = installed();
  if (st.pinned) { const p = all.find(x => x.version === st.pinned); if (p) return p; }
  return all.find(x => !st.bad.includes(x.version)) || all[all.length - 1];
}

function prune() {
  const st = loadState();
  const own = installed().filter(x => !x.bundled && x.dir.startsWith(versionsDir()));
  const keep = new Set(own.slice(0, KEEP).map(x => x.version)); if (st.pinned) keep.add(st.pinned);
  for (const x of own) if (!keep.has(x.version)) { try { fs.rmSync(x.dir, { recursive: true, force: true }); } catch (_) {} }
}

let win, current = null, watchdog = null;
function load(ver) {
  current = ver; ensureVendor(ver.dir);
  win.loadFile(path.join(ver.dir, 'index.html'));
  armWatchdog();
  buildMenu();
}

// If the app never gets past "Loading…", mark that version as failed and go back to the last one that worked.
function armWatchdog() {
  clearTimeout(watchdog);
  const ver = current; const t0 = Date.now();
  const check = async () => {
    if (!win || win.isDestroyed() || current !== ver) return;
    let ok = false;
    try { ok = await win.webContents.executeJavaScript(`(()=>{const a=document.getElementById('app');return !!a&&!/Loading Strength By Design/.test(a.innerText||'')&&a.children.length>0})()`); } catch (_) {}
    if (ok) { const st = loadState(); if (st.lastGood !== ver.version) { st.lastGood = ver.version; saveState(st); } return; }
    if (Date.now() - t0 < START_TIMEOUT) { watchdog = setTimeout(check, 1500); return; }
    fail(ver, 'it did not finish starting');
  };
  watchdog = setTimeout(check, 1500);
}
async function fail(ver, why) {
  const st = loadState();
  if (!st.bad.includes(ver.version)) st.bad.push(ver.version);
  if (st.pinned === ver.version) st.pinned = null;
  saveState(st);
  const next = installed().find(x => x.version !== ver.version && !st.bad.includes(x.version));
  if (!next || !win) return;
  load(next);
  dialog.showMessageBox(win, { type: 'warning', buttons: ['OK'], title: 'Went back to the previous version',
    message: `Version ${ver.version} didn't start properly, so the app went back to version ${next.version}.`,
    detail: `Reason: ${why}. Your data is safe: it lives in your account, not in the app. A fixed update will install as usual.` });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 600,
    backgroundColor: '#0F0E0E', title: 'SBD Business Manager',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.webContents.on('render-process-gone', () => { if (current) fail(current, 'the page crashed'); });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && current && code !== -3) fail(current, 'the page could not be opened'); });
  // Open web links in the normal browser, keep the app window on the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  load(pickVersion());
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, cache: 'no-cache' });
    let body = '';
    req.on('response', res => { if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; } res.on('data', d => body += d); res.on('end', () => resolve(body)); });
    req.on('error', reject); req.end();
  });
}

async function checkContentUpdate(manual) {
  try {
    const st = loadState();
    const remote = JSON.parse(await fetchText(`${RAW}/version.json?t=${Date.now()}`)).version;
    const latest = installed()[0];
    if (!remote || !newer(remote, latest ? latest.version : '0.0.0') || st.bad.includes(remote)) {
      if (manual) dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], title: 'Up to date', message: st.pinned ? `You're using version ${st.pinned} by choice. The newest is ${latest.version}.` : `You have the latest version (${latest ? latest.version : remote}).` });
      return;
    }
    const html = await fetchText(`${RAW}/index.html?t=${Date.now()}`);
    if (!html.includes('SBD Business Manager')) return; // sanity check
    const dir = path.join(versionsDir(), remote); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: remote }));
    ensureVendor(dir); prune(); buildMenu();
    if (st.pinned) return; // they chose to stay on an older version; the new one waits in the menu
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready', message: `SBD Business Manager ${remote} is ready.`,
      detail: 'Restart now to use it, or it will load the next time you open the app. If anything looks wrong, File → Go back to a previous version.'
    });
    if (response === 0 && win) load(pickVersion());
  } catch (_) { if (manual) dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], title: 'No connection', message: "Couldn't check for updates. You're offline or GitHub can't be reached." }); }
}

function useVersion(ver) {
  const st = loadState(); const isLatest = installed().filter(x => !st.bad.includes(x.version) || x.version === ver.version)[0].version === ver.version;
  st.pinned = isLatest ? null : ver.version; st.bad = st.bad.filter(v => v !== ver.version); saveState(st);
  load(ver);
  dialog.showMessageBox(win, { type: 'info', buttons: ['OK'], title: 'Version changed',
    message: isLatest ? `Back on the latest version (${ver.version}).` : `Now using version ${ver.version}.`,
    detail: isLatest ? 'New updates will install as usual.' : 'The app stays on this version until you choose File → Return to the latest version. Your data is the same in every version.' });
}

function checkShellUpdate() {
  // Full installer updates (rare). Windows only: macOS requires a paid Apple certificate for this.
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try { const { autoUpdater } = require('electron-updater'); autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch (_) {}
}

function buildMenu() {
  const st = loadState(); const all = installed();
  const verItems = all.map(v => ({ label: `${v.version}${v === all[0] ? '  (latest)' : ''}${st.bad.includes(v.version) ? '  · failed to start' : ''}${v.bundled ? '  · came with install' : ''}`,
    type: 'radio', checked: !!current && current.version === v.version, click: () => useVersion(v) }));
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Check for updates', click: () => checkContentUpdate(true) },
      { label: 'Go back to a previous version', submenu: verItems },
      ...(st.pinned ? [{ label: 'Return to the latest version', click: () => { const s = loadState(); s.pinned = null; saveState(s); load(pickVersion()); } }] : []),
      { label: `Using version ${current ? current.version : '—'}`, enabled: false },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.whenReady().then(() => {
  createWindow();
  setTimeout(() => checkContentUpdate(false), 3000);
  checkShellUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
