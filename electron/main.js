// AAF eVote Station — Windows app (Electron).
// The web app in ../www is served from a private app:// address so its saved data (IndexedDB)
// stays in one place and survives updates. Nothing is loaded from the internet except the API calls.
const { app, BrowserWindow, Menu, protocol, net, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, '..', 'www');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

if (!app.requestSingleInstanceLock()) { app.quit(); }
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 560,
    title: 'AAF eVote Station', backgroundColor: '#eef1f5', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL('app://station/index.html');

  // Links to other sites open in the normal browser, never inside the station.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://station/')) e.preventDefault(); });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = path.normalize(path.join(WWW, decodeURIComponent(u.pathname)));
    if (!p.startsWith(WWW)) return new Response('Not found', { status: 404 });
    if (u.pathname === '/' ) p = path.join(WWW, 'index.html');
    return net.fetch(pathToFileURL(p).toString());
  });

  ipcMain.handle('save-file', async (_e, name, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '-')), filters: [{ name: 'Backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(text), 'utf8');
    return r.filePath;
  });

  const menu = Menu.buildFromTemplate([
    { label: 'Station', submenu: [
      { label: 'Full screen', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => win && win.reload() },
      { type: 'separator' },
      { role: 'zoomIn', accelerator: 'Ctrl+=' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() }
    ] },
    { label: 'Help', submenu: [
      { label: 'About AAF eVote Station', click: () => dialog.showMessageBox(win, { type: 'info', title: 'AAF eVote Station', message: 'AAF eVote Station ' + app.getVersion(), detail: 'Offline voting for AAF eVote school elections.\nAye-Africa Foundation.' }) }
    ] }
  ]);
  Menu.setApplicationMenu(menu);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
