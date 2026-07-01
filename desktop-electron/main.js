const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const { autoUpdater } = require('electron-updater');

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
function findPython() {
  const fs = require('fs');
  // 1) Bundled portable Python (packaged app)
  if (isPackaged) {
    const base = path.join(process.resourcesPath, 'python-portable');
    const candidates = process.platform === 'win32'
      ? [path.join(base, 'python.exe')]
      : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')];
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
    }
  }
  // 2) Bundled portable Python (dev mode — local checkout)
  {
    const base = path.join(__dirname, 'python-portable');
    const candidates = process.platform === 'win32'
      ? [path.join(base, 'python.exe')]
      : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')];
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
    }
  }
  // 3) System Python (fallback)
  const { execSync } = require('child_process');
  const cmds = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const cmd of cmds) {
    try {
      let realPath = cmd;
      if (process.platform !== 'win32') {
        try { realPath = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch (_) {}
      }
      if (realPath) {
        execSync(`"${realPath}" --version`, { stdio: 'ignore' });
        return realPath;
      }
    } catch (_) {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startPythonBackend() {
  const launcher = path.join(__dirname, 'desktop_server.py');
  const pythonCmd = findPython();
  console.log(`[main] Using Python: ${pythonCmd}`);
  pythonProcess = spawn(pythonCmd, [launcher, '--port', String(API_PORT), '--no-browser'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  pythonProcess.on('error', (err) => {
    if (err.code === 'ENOENT') {
      const isMac = process.platform === 'darwin';
      dialog.showMessageBox({
        type: 'error',
        title: 'Python 未找到',
        message: isMac
          ? '未找到 Python 3，请安装后重试。\n\n如果已安装但仍报错，请运行：\n  xattr -dr com.apple.quarantine "/Applications/dou+.app"'
          : '未找到 Python 3，请安装后重试。\n\n从 https://python.org 下载安装。',
        buttons: ['确定'],
      }).then(() => app.quit());
    }
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
    icon: path.join(__dirname, 'icon.ico'),
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
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:isPackaged', () => isPackaged);
ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));

// ---------------------------------------------------------------------------
// Auto-updater
// ---------------------------------------------------------------------------
let updateDownloaded = false;

function setupAutoUpdater() {
  if (isPackaged) {
    autoUpdater.autoDownload = false; // let user decide
    autoUpdater.allowDowngrade = false;
  }

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:status', {
      type: 'available',
      version: info.version,
    });
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `dou+ ${info.version} 可用，是否下载更新？`,
      buttons: ['下载更新', '稍后提醒'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow?.webContents.send('update:status', { type: 'downloading' });
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:status', {
      type: 'downloading',
      percent: Math.floor(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true;
    mainWindow?.webContents.send('update:status', { type: 'downloaded' });
    const isMac = process.platform === 'darwin';
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已下载',
      message: isMac
        ? '新版本已下载，是否打开安装包手动安装？\n（由于未签名，需要手动拖入应用程序文件夹）'
        : '更新已下载完毕，是否立即重启安装？',
      buttons: isMac ? ['打开安装包', '稍后'] : ['立即重启', '稍后'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        if (isMac) {
          // Open the downloaded DMG in Finder so the user can drag to Applications
          const fs = require('fs');
          const downloadPath = path.join(os.homedir(), 'Library', 'Caches', app.getName(), 'pending');
          if (fs.existsSync(downloadPath)) {
            const files = fs.readdirSync(downloadPath);
            const dmg = files.find(f => f.endsWith('.dmg'));
            if (dmg) shell.openPath(path.join(downloadPath, dmg));
          }
        } else {
          autoUpdater.quitAndInstall();
        }
      }
    });
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update:status', {
      type: 'error',
      message: err.message,
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update:status', { type: 'none' });
  });
}

ipcMain.handle('app:checkUpdate', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:downloadUpdate', async () => {
  mainWindow?.webContents.send('update:status', { type: 'downloading' });
  autoUpdater.downloadUpdate();
});

ipcMain.handle('app:installUpdate', async () => {
  if (updateDownloaded) autoUpdater.quitAndInstall();
});

// Login via Electron's built-in Chromium
ipcMain.handle('app:login', async () => {
  return new Promise((resolve) => {
    // Unique partition so each login attempt starts fresh (no stale cookies)
    const partition = 'douyin-login-' + Date.now();
    const loginWin = new BrowserWindow({
      width: 520,
      height: 780,
      minWidth: 400,
      minHeight: 600,
      title: '抖音登录 — dou+',
      parent: mainWindow,
      modal: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: partition,
      },
      autoHideMenuBar: true,
    });

    let resolved = false;
    const ses = loginWin.webContents.session;

    // Detect cookie changes in real time — more reliable than navigation events
    ses.cookies.on('changed', () => {
      if (!resolved) checkLogin();
    });

    async function checkLogin() {
      if (resolved) return;
      try {
        const allCk = await ses.cookies.get({});
        const hasSession = allCk.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        const hasCsrf = allCk.some(c => c.name === 'passport_csrf_token');
        if (!hasSession || !hasCsrf) return;

        resolved = true;
        // Collect all likely-relevant cookies — don't filter by domain,
        // some cookies may have null/empty domain (host-only cookies)
        const cookies = {};
        for (const c of allCk) {
          if (!c.domain || c.domain.includes('douyin') || c.domain.includes('snssdk')) {
            cookies[c.name] = c.value;
          }
        }

        const http = require('http');
        const data = JSON.stringify({ cookies });
        await new Promise((res, rej) => {
          const req = http.request({
            hostname: API_HOST, port: API_PORT,
            path: '/api/v1/save-cookies', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (r) => {
            let body = '';
            r.on('data', d => body += d);
            r.on('end', () => {
              try { res(JSON.parse(body)); } catch (_) { res({ ok: true }); }
            });
          });
          req.on('error', rej);
          req.write(data); req.end();
        }).catch(() => {});

        loginWin.close();
        resolve({ ok: true });
      } catch (_) {}
    }

    // Backup: check on navigation too (handles SPA-like login flows)
    loginWin.webContents.on('did-navigate', () => {
      setTimeout(checkLogin, 1200);
    });
    loginWin.webContents.on('did-navigate-in-page', () => {
      setTimeout(checkLogin, 800);
    });

    // Last-resort: when window is closing, try one more cookie check
    loginWin.on('close', (e) => {
      if (resolved) return;
      e.preventDefault();
      ses.cookies.get({}).then(allCk => {
        const hasSession = allCk.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        const hasCsrf = allCk.some(c => c.name === 'passport_csrf_token');
        if (hasSession && hasCsrf && !resolved) { checkLogin(); return; }
        setImmediate(() => { if (!loginWin.isDestroyed()) loginWin.destroy(); });
      }).catch(() => {
        setImmediate(() => { if (!loginWin.isDestroyed()) loginWin.destroy(); });
      });
    });

    loginWin.on('closed', () => {
      if (!resolved) resolve({ ok: false, error: '登录窗口已关闭' });
    });

    loginWin.loadURL('https://www.douyin.com/?recommend=1');
  });
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  setupAutoUpdater();
  startPythonBackend();
  const ready = await waitForServer();
  if (ready) console.log('[main] Python backend ready');
  else console.log('[main] WARNING: Python backend may not be ready');
  createWindow();

  // Auto-check for updates on startup, then every 30 minutes
  if (isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 30 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  app.quit();
});

app.on('before-quit', () => stopPythonBackend());
