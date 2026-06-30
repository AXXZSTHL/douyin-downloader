const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');

let mainWindow = null;
let pythonProcess = null;
const API_PORT = 18080;
const API_HOST = '127.0.0.1';
const API_BASE = `http://${API_HOST}:${API_PORT}`;

// In packaged builds, extraResources land in process.resourcesPath.
// In dev, the project root is the parent of this source directory.
const isPackaged = app.isPackaged;
const PROJECT_ROOT = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Python backend
// ---------------------------------------------------------------------------
function startPythonBackend() {
  const launcher = path.join(__dirname, 'desktop_server.py');
  pythonProcess = spawn('python', [launcher, '--port', String(API_PORT), '--no-browser'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (d) => console.log(`[py] ${d.toString().trim()}`));
  pythonProcess.stderr.on('data', (d) => console.log(`[py] ${d.toString().trim()}`));
  pythonProcess.on('close', (code) => console.log(`[py] exited with code ${code}`));
}

function stopPythonBackend() {
  if (pythonProcess) { pythonProcess.kill(); pythonProcess = null; }
}

// ---------------------------------------------------------------------------
// API proxy helpers
// ---------------------------------------------------------------------------
function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(data); } });
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForServer(retries = 40) {
  return new Promise((resolve) => {
    function check(n) {
      const req = http.get(`http://${API_HOST}:${API_PORT}/api/v1/health`, (res) => {
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', () => retry());
      req.setTimeout(1000, () => { req.destroy(); retry(); });
      function retry() {
        if (n <= 0) return resolve(false);
        setTimeout(() => check(n - 1), 500);
      }
    }
    check(retries);
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 760,
    minHeight: 560,
    title: 'dou+',
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    frame: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('api:get', async (_e, endpoint) => apiRequest('GET', endpoint));
ipcMain.handle('api:post', async (_e, endpoint, body) => apiRequest('POST', endpoint, body));
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('app:getDownloadsPath', () => {
  return path.join(os.homedir(), 'Downloads');
});
ipcMain.handle('app:getPlatform', () => process.platform);
ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  startPythonBackend();
  const ready = await waitForServer();
  if (ready) console.log('[main] Python backend ready');
  else console.log('[main] WARNING: Python backend may not be ready');
  createWindow();
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  app.quit();
});

app.on('before-quit', () => stopPythonBackend());
