const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let savedBounds = null;
let backupTimer = null;
const COLLAPSED_WIDTH = 36;
const EDGE_SNAP_THRESHOLD = 40;
let suppressEdgeCheck = false;

const DEFAULTS = {
  opacity: 0.92,
  autoLaunch: true,
  alwaysOnTop: true,
  hiddenEdge: null,
  width: 360,
  height: 520,
  x: null,
  y: null,
  collapsedY: null,
  activeTab: 'work',
  categories: [
    { id: 'work', name: '工作' },
    { id: 'plan', name: '计划' },
    { id: 'password', name: '密码' }
  ],
  notes: { work: '', plan: '', password: '' },
  theme: 'warm'
};
const SETTINGS_KEYS = Object.keys(DEFAULTS);
const THEMES = ['warm', 'cool', 'green'];
const SHOW_HIDE_SHORTCUT = 'CommandOrControl+Alt+S';

function getSettings() {
  const s = {};
  for (const k of SETTINGS_KEYS) s[k] = store.get(k, DEFAULTS[k]);
  if (!Array.isArray(s.categories) || s.categories.length === 0) {
    s.categories = DEFAULTS.categories;
  }
  if (!s.notes || typeof s.notes !== 'object') s.notes = { ...DEFAULTS.notes };
  if (!s.categories.some(c => c.id === s.activeTab)) {
    s.activeTab = s.categories[0].id;
  }
  return s;
}

function getAppIcon(size = 256) {
  const iconPath = path.join(__dirname, 'build', size <= 32 ? 'tray.png' : 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return nativeImage.createEmpty();
  return size ? image.resize({ width: size, height: size }) : image;
}

function applyAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath,
    args: enabled ? ['--autostart'] : []
  });
  store.set('autoLaunch', enabled);
}

// ---------- 数据备份 ----------

function backupFilePath() {
  return path.join(app.getPath('userData'), 'notes-backup.json');
}

function writeBackup() {
  try {
    const data = {
      app: 'desktop-sticky-notes',
      backedUpAt: new Date().toISOString(),
      categories: store.get('categories', DEFAULTS.categories),
      notes: store.get('notes', DEFAULTS.notes),
      theme: store.get('theme', DEFAULTS.theme)
    };
    fs.writeFileSync(backupFilePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('写入便签备份失败:', err);
  }
}

function scheduleBackup(delayMs = 10000) {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(writeBackup, delayMs);
}

// ---------- 导出 / 导入 ----------

async function exportNotes() {
  try {
    const res = await dialog.showSaveDialog({
      title: '导出便签备份',
      defaultPath: `便签备份-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return;
    const data = {
      app: 'desktop-sticky-notes',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: store.get('categories', DEFAULTS.categories),
      notes: store.get('notes', DEFAULTS.notes),
      theme: store.get('theme', DEFAULTS.theme),
      opacity: store.get('opacity', DEFAULTS.opacity)
    };
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    dialog.showErrorBox('导出失败', String(err?.message || err));
  }
}

async function importNotes() {
  try {
    const res = await dialog.showOpenDialog({
      title: '导入便签备份',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return;
    const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    const categories = Array.isArray(data?.categories)
      ? data.categories.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string' && c.name.trim())
      : [];
    if (!categories.length || !data?.notes || typeof data.notes !== 'object') {
      dialog.showErrorBox('导入失败', '文件格式不正确，请选择由本应用导出的备份文件。');
      return;
    }
    writeBackup(); // 覆盖当前数据前先自动备份，导入有误可回退
    const notes = {};
    for (const c of categories) {
      notes[c.id] = typeof data.notes[c.id] === 'string' ? data.notes[c.id] : '';
    }
    store.set('categories', categories);
    store.set('notes', notes);
    store.set('activeTab', categories[0].id);
    if (THEMES.includes(data.theme)) store.set('theme', data.theme);
    if (typeof data.opacity === 'number') store.set('opacity', data.opacity);
    mainWindow?.webContents.reload();
  } catch (err) {
    dialog.showErrorBox('导入失败', String(err?.message || err));
  }
}

// ---------- 窗口 ----------

function createWindow() {
  const settings = getSettings();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const collapsed = !!settings.hiddenEdge;

  const stored = {
    x: settings.x ?? sw - settings.width - 24,
    y: settings.y ?? 80,
    width: settings.width,
    height: settings.height
  };
  const workArea = screen.getDisplayMatching(stored).workArea;

  let { x, y, width, height } = stored;
  if (collapsed) {
    // 启动前就把窗口设为收起状态，避免先以完整尺寸闪现
    width = COLLAPSED_WIDTH;
    height = Math.min(stored.height, 120);
    y = settings.collapsedY ?? stored.y;
    x = settings.hiddenEdge === 'left' ? workArea.x : workArea.x + workArea.width - COLLAPSED_WIDTH;
  }
  // 位置夹回工作区，防止换显示器/改分辨率后窗口跑出屏幕
  width = Math.min(width, workArea.width);
  height = Math.min(height, workArea.height);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    icon: getAppIcon(256),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    hasShadow: true,
    minWidth: collapsed ? COLLAPSED_WIDTH : 280,
    minHeight: collapsed ? 80 : 360,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--autostart')) mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (settings.hiddenEdge) {
      mainWindow.webContents.send('edge-state', { collapsed: true, edge: settings.hiddenEdge });
    }
  });

  mainWindow.on('moved', () => {
    if (store.get('hiddenEdge')) {
      snapCollapsedToEdge(store.get('hiddenEdge'));
      return;
    }
    checkEdgeSnap();
  });

  mainWindow.on('resized', () => {
    if (store.get('hiddenEdge')) return;
    const [w, h] = mainWindow.getSize();
    store.set('width', w);
    store.set('height', h);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function ensureWindowVisible() {
  if (!mainWindow) return;
  if (store.get('hiddenEdge')) {
    snapCollapsedToEdge(store.get('hiddenEdge'));
    return;
  }
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
  if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) {
    mainWindow.setBounds({ x, y, width, height });
    store.set('x', x);
    store.set('y', y);
  }
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function shortcutLabel() {
  return process.platform === 'darwin' ? '⌘+Alt+S' : 'Ctrl+Alt+S';
}

// ---------- 托盘 ----------

function buildTrayMenu() {
  const autoLaunch = store.get('autoLaunch', DEFAULTS.autoLaunch);
  return Menu.buildFromTemplate([
    { label: `显示 / 隐藏便签 (${shortcutLabel()})`, click: toggleMainWindow },
    { label: '置顶开关', click: () => {
      const top = !mainWindow.isAlwaysOnTop();
      mainWindow.setAlwaysOnTop(top);
      store.set('alwaysOnTop', top);
      mainWindow.webContents.send('settings-updated', { alwaysOnTop: top });
    }},
    { type: 'separator' },
    { label: '导出便签备份', click: exportNotes },
    { label: '导入便签备份', click: importNotes },
    { type: 'separator' },
    { label: '开机自启动', type: 'checkbox', checked: autoLaunch, click: (item) => {
      applyAutoLaunch(item.checked);
    }},
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const icon = getAppIcon(32);
  tray = new Tray(icon);
  tray.setToolTip('桌面便签');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ---------- IPC ----------

ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (_, data) => {
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (SETTINGS_KEYS.includes(k)) store.set(k, v);
    }
    if ('notes' in data) scheduleBackup();
  }
  return getSettings();
});
ipcMain.handle('set-bg-opacity', (_, v) => {
  store.set('opacity', v);
});
ipcMain.handle('set-always-on-top', (_, v) => {
  store.set('alwaysOnTop', v);
  mainWindow?.setAlwaysOnTop(v);
});
function checkEdgeSnap() {
  if (!mainWindow || suppressEdgeCheck || store.get('hiddenEdge')) return;

  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const { x: dx, width: dw } = display.workArea;

  const distLeft = bounds.x - dx;
  const distRight = (dx + dw) - (bounds.x + bounds.width);

  if (distLeft <= EDGE_SNAP_THRESHOLD) {
    collapseToEdge('left');
  } else if (distRight <= EDGE_SNAP_THRESHOLD) {
    collapseToEdge('right');
  } else {
    store.set('x', bounds.x);
    store.set('y', bounds.y);
  }
}

function snapCollapsedToEdge(edge = 'right') {
  if (!mainWindow) return;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const bounds = mainWindow.getBounds();
  const h = bounds.height;
  const y = Math.max(dy, Math.min(bounds.y, dy + dh - h));
  const x = edge === 'left' ? dx : dx + dw - COLLAPSED_WIDTH;

  if (bounds.x !== x || bounds.y !== y) {
    mainWindow.setBounds({ x, y, width: COLLAPSED_WIDTH, height: h }, false);
  }
  store.set('collapsedY', y);
}

function collapseToEdge(edge = 'right', persist = true) {
  if (!mainWindow) return;
  suppressEdgeCheck = true;

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  savedBounds = mainWindow.getBounds();

  const h = Math.min(savedBounds.height, 120);
  const storedY = store.get('collapsedY');
  const y = storedY != null
    ? Math.max(dy, Math.min(storedY, dy + dh - h))
    : Math.max(dy, Math.min(savedBounds.y, dy + dh - h));
  let x;

  if (edge === 'left') {
    x = dx;
  } else {
    x = dx + dw - COLLAPSED_WIDTH;
    edge = 'right';
  }

  if (persist) {
    store.set('hiddenEdge', edge);
    store.set('collapsedY', y);
  }

  mainWindow.setMinimumSize(COLLAPSED_WIDTH, 80);
  mainWindow.setBounds({ x, y, width: COLLAPSED_WIDTH, height: h }, true);
  mainWindow.webContents.send('edge-state', { collapsed: true, edge });
  suppressEdgeCheck = false;
}

function expandFromEdge() {
  if (!mainWindow) return;
  const bounds = savedBounds || {
    width: store.get('width', DEFAULTS.width),
    height: store.get('height', DEFAULTS.height),
    x: store.get('x'),
    y: store.get('y')
  };
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const x = bounds.x ?? sw - bounds.width - 24;
  const y = bounds.y ?? 80;

  mainWindow.setMinimumSize(280, 360);
  mainWindow.setBounds({ x, y, width: bounds.width, height: bounds.height }, true);
  store.set('hiddenEdge', null);
  store.set('x', x);
  store.set('y', y);
  store.set('width', bounds.width);
  store.set('height', bounds.height);
  savedBounds = null;
  mainWindow.webContents.send('edge-state', { collapsed: false });
}

ipcMain.handle('toggle-edge', (_, collapse) => {
  if (collapse) {
    const bounds = mainWindow?.getBounds();
    if (!bounds) return;
    const display = screen.getDisplayMatching(bounds);
    const { x: dx, width: dw } = display.workArea;
    const distLeft = bounds.x - dx;
    const distRight = (dx + dw) - (bounds.x + bounds.width);
    collapseToEdge(distLeft <= distRight ? 'left' : 'right');
  } else {
    expandFromEdge();
  }
});
ipcMain.handle('get-window-bounds', () => mainWindow?.getBounds());
ipcMain.handle('set-collapsed-position', (_, topY) => {
  if (!mainWindow || !store.get('hiddenEdge')) return;
  const edge = store.get('hiddenEdge');
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const h = mainWindow.getBounds().height;
  const y = Math.max(dy, Math.min(topY, dy + dh - h));
  const x = edge === 'left' ? dx : dx + dw - COLLAPSED_WIDTH;
  mainWindow.setBounds({ x, y, width: COLLAPSED_WIDTH, height: h });
  store.set('collapsedY', y);
});
ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('close-window', () => mainWindow?.hide());

// ---------- 应用生命周期 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  applyAutoLaunch(store.get('autoLaunch', DEFAULTS.autoLaunch));
  createWindow();
  createTray();
  screen.on('display-removed', ensureWindowVisible);
  screen.on('display-metrics-changed', ensureWindowVisible);
  globalShortcut.register(SHOW_HIDE_SHORTCUT, toggleMainWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(backupTimer);
  writeBackup();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
