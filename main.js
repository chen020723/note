const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let savedBounds = null;
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

function getSettings() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = store.get(k, DEFAULTS[k]);
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

function createWindow() {
  const settings = getSettings();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const x = settings.x ?? sw - settings.width - 24;
  const y = settings.y ?? 80;

  mainWindow = new BrowserWindow({
    width: settings.width,
    height: settings.height,
    x, y,
    icon: getAppIcon(256),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    hasShadow: true,
    minWidth: 280,
    minHeight: 360,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    if (settings.hiddenEdge) collapseToEdge(settings.hiddenEdge, false);
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

  const isAutoStart = process.argv.includes('--autostart');
  if (isAutoStart) {
    mainWindow.hide();
  }
}

function buildTrayMenu() {
  const autoLaunch = store.get('autoLaunch', DEFAULTS.autoLaunch);
  return Menu.buildFromTemplate([
    { label: '显示便签', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '置顶开关', click: () => {
      const top = !mainWindow.isAlwaysOnTop();
      mainWindow.setAlwaysOnTop(top);
      store.set('alwaysOnTop', top);
      mainWindow.webContents.send('settings-updated', { alwaysOnTop: top });
    }},
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

ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (_, data) => {
  Object.entries(data).forEach(([k, v]) => store.set(k, v));
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
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
