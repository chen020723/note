let settings = {};
let activeTab = 'work';
let saveTimer = null;
let isPinned = true;
let searchMatches = [];
let searchIndex = -1;

const app = document.getElementById('app');
const tabsEl = document.getElementById('tabs');
const editor = document.getElementById('editor');
const opacitySlider = document.getElementById('opacity');
const opacityValue = document.getElementById('opacity-value');
const statusEl = document.getElementById('status');
const btnPin = document.getElementById('btn-pin');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const dialogOverlay = document.getElementById('dialog-overlay');
const dialogTitle = document.getElementById('dialog-title');
const dialogInput = document.getElementById('dialog-input');
const dialogMessage = document.getElementById('dialog-message');
const dialogOk = document.getElementById('dialog-ok');
const dialogCancel = document.getElementById('dialog-cancel');

let dialogResolve = null;

function showPrompt(title, defaultValue = '') {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogInput.value = defaultValue;
    dialogInput.classList.remove('hidden');
    dialogMessage.classList.add('hidden');
    dialogOverlay.classList.remove('hidden');
    dialogInput.focus();
    dialogInput.select();
  });
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogMessage.classList.remove('hidden');
    dialogInput.classList.add('hidden');
    dialogOverlay.classList.remove('hidden');
    dialogOk.focus();
  });
}

function closeDialog(result) {
  dialogOverlay.classList.add('hidden');
  if (dialogResolve) {
    dialogResolve(result);
    dialogResolve = null;
  }
}

function bindDialogEvents() {
  dialogOk.addEventListener('click', () => {
    if (dialogInput.classList.contains('hidden')) {
      closeDialog(true);
    } else {
      closeDialog(dialogInput.value.trim());
    }
  });
  dialogCancel.addEventListener('click', () => closeDialog(null));
  dialogInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeDialog(dialogInput.value.trim());
    if (e.key === 'Escape') closeDialog(null);
  });
  dialogOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog(null);
  });
}

async function init() {
  settings = await window.api.getSettings();
  activeTab = settings.activeTab || settings.categories[0]?.id;
  isPinned = settings.alwaysOnTop;

  if (settings.hiddenEdge) {
    setCollapsed(true, settings.hiddenEdge);
  }

  opacitySlider.value = 1 - parseFloat(settings.opacity);
  updateOpacityLabel(parseFloat(opacitySlider.value));
  applyBgOpacity(parseFloat(settings.opacity));
  btnPin.classList.toggle('active', isPinned);
  app.classList.add(`theme-${settings.theme || 'warm'}`);

  renderTabs();
  loadEditorContent();
  bindDialogEvents();
  bindFormatBar();
  bindEvents();
}

function renderTabs() {
  tabsEl.innerHTML = '';
  settings.categories.forEach(cat => {
    const tab = document.createElement('button');
    tab.className = 'tab' + (cat.id === activeTab ? ' active' : '');
    tab.dataset.tab = cat.id;
    tab.title = cat.name;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = cat.name;
    tab.appendChild(name);

    if (settings.categories.length > 1) {
      const del = document.createElement('span');
      del.className = 'tab-del';
      del.textContent = '×';
      del.title = '删除分类';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteCategory(cat.id);
      });
      tab.appendChild(del);
    }

    tab.addEventListener('click', () => switchTab(cat.id));
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameCategory(cat.id);
    });

    tabsEl.appendChild(tab);
  });
}

function getEditorHtml() {
  return editor.innerHTML;
}

function getEditorPlainText() {
  return editor.innerText || editor.textContent || '';
}

function setEditorHtml(content) {
  if (!content) {
    editor.innerHTML = '';
    return;
  }
  if (!content.includes('<')) {
    editor.innerHTML = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  } else {
    editor.innerHTML = content;
  }
}

function triggerSave() {
  clearTimeout(saveTimer);
  statusEl.textContent = '保存中...';
  statusEl.classList.remove('saved');
  saveTimer = setTimeout(saveNotes, 400);
}

function execFormat(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  triggerSave();
}

function bindFormatBar() {
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      const value = btn.dataset.value || null;
      execFormat(cmd, value);
    });
  });

  editor.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); execFormat('bold'); }
      if (e.key === 'i') { e.preventDefault(); execFormat('italic'); }
      if (e.key === 'u') { e.preventDefault(); execFormat('underline'); }
    }
  });
}

function loadEditorContent() {
  const notes = settings.notes || {};
  setEditorHtml(notes[activeTab] || '');
  resetSearch();
}

function bindEvents() {
  editor.addEventListener('input', triggerSave);

  opacitySlider.addEventListener('input', (e) => {
    const transparency = parseFloat(e.target.value);
    const bgOpacity = 1 - transparency;
    updateOpacityLabel(transparency);
    applyBgOpacity(bgOpacity);
    window.api.setBgOpacity(bgOpacity);
  });

  btnPin.addEventListener('click', togglePin);
  document.getElementById('btn-add-tab').addEventListener('click', addCategory);
  document.getElementById('btn-hide').addEventListener('click', hideToEdge);
  document.getElementById('btn-min').addEventListener('click', () => window.api.minimizeWindow());
  document.getElementById('btn-close').addEventListener('click', () => window.api.closeWindow());

  searchInput.addEventListener('input', () => runSearch(true));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.shiftKey ? gotoPrevMatch() : gotoNextMatch();
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      resetSearch();
    }
  });
  document.getElementById('search-prev').addEventListener('click', gotoPrevMatch);
  document.getElementById('search-next').addEventListener('click', gotoNextMatch);

  bindEdgeDrag();

  window.api.onSettingsUpdated((data) => {
    if ('alwaysOnTop' in data) {
      isPinned = data.alwaysOnTop;
      btnPin.classList.toggle('active', isPinned);
    }
  });

  window.api.onEdgeState((data) => setCollapsed(data.collapsed, data.edge));
}

function runSearch(resetIndex) {
  const query = searchInput.value.trim();
  searchMatches = [];

  if (!query) {
    resetSearch();
    return;
  }

  const text = getEditorPlainText();
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;

  while (pos < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    searchMatches.push({ start: idx, end: idx + query.length });
    pos = idx + 1;
  }

  if (searchMatches.length === 0) {
    searchIndex = -1;
    searchCount.textContent = '无结果';
    return;
  }

  if (resetIndex || searchIndex >= searchMatches.length) {
    searchIndex = 0;
  }

  highlightMatch();
}

function resetSearch() {
  searchMatches = [];
  searchIndex = -1;
  searchCount.textContent = '';
}

function highlightMatch() {
  if (searchIndex < 0 || !searchMatches.length) return;
  const query = searchInput.value.trim();
  if (!query) return;

  editor.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);
  sel.addRange(range);

  let found = false;
  for (let i = 0; i <= searchIndex; i++) {
    found = window.find(query, false, false, false, false, true, false);
    if (!found) break;
  }

  if (found) {
    const activeRange = sel.getRangeAt(0);
    const rect = activeRange.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    if (rect.top < editorRect.top) {
      editor.scrollTop -= editorRect.top - rect.top + 8;
    } else if (rect.bottom > editorRect.bottom) {
      editor.scrollTop += rect.bottom - editorRect.bottom + 8;
    }
  }

  searchCount.textContent = `${searchIndex + 1}/${searchMatches.length}`;
}

function scrollToSelection() {}

function gotoNextMatch() {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + 1) % searchMatches.length;
  highlightMatch();
}

function gotoPrevMatch() {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
  highlightMatch();
}

async function addCategory() {
  const name = await showPrompt('请输入分类名称：');
  if (!name) return;

  saveNotesSync();
  const id = `cat_${Date.now()}`;
  settings.categories.push({ id, name });
  settings.notes[id] = '';
  await persistSettings({ categories: settings.categories, notes: settings.notes, activeTab: id });
  activeTab = id;
  renderTabs();
  loadEditorContent();
}

async function renameCategory(id) {
  const cat = settings.categories.find(c => c.id === id);
  if (!cat) return;
  const name = await showPrompt('重命名分类：', cat.name);
  if (!name || name === cat.name) return;

  cat.name = name;
  await persistSettings({ categories: settings.categories });
  renderTabs();
}

async function deleteCategory(id) {
  if (settings.categories.length <= 1) return;

  const cat = settings.categories.find(c => c.id === id);
  const content = settings.notes[id] || '';
  const plain = content.replace(/<[^>]+>/g, '').trim();
  const message = plain
    ? `确定删除分类「${cat.name}」？其中的内容将一并删除。`
    : `确定删除分类「${cat.name}」？`;

  const confirmed = await showConfirm('删除分类', message);
  if (!confirmed) return;

  saveNotesSync();
  settings.categories = settings.categories.filter(c => c.id !== id);
  delete settings.notes[id];

  if (activeTab === id) {
    activeTab = settings.categories[0].id;
  }

  await persistSettings({
    categories: settings.categories,
    notes: settings.notes,
    activeTab
  });
  renderTabs();
  loadEditorContent();
}

function updateOpacityLabel(transparency) {
  opacityValue.textContent = `${Math.round(transparency * 100)}%`;
}

function setCollapsed(collapsed, edge = 'right') {
  app.classList.toggle('collapsed', collapsed);
  app.classList.toggle('left-edge', collapsed && edge === 'left');
  document.getElementById('btn-hide').textContent = collapsed ? '▶' : '◀';
  document.getElementById('btn-hide').title = collapsed ? '展开便签' : '收起到边缘';
  const edgeTab = document.getElementById('edge-tab-inline');
  edgeTab.title = collapsed ? '拖动调整位置，单击展开' : '';
}

let edgeDrag = null;

function bindEdgeDrag() {
  const edgeTab = document.getElementById('edge-tab-inline');

  edgeTab.addEventListener('mousedown', async (e) => {
    if (e.button !== 0 || !app.classList.contains('collapsed')) return;
    e.preventDefault();
    const bounds = await window.api.getWindowBounds();
    edgeDrag = {
      startScreenY: e.screenY,
      startWindowY: bounds.y,
      moved: false
    };
  });

  document.addEventListener('mousemove', (e) => {
    if (!edgeDrag) return;
    const dy = e.screenY - edgeDrag.startScreenY;
    if (Math.abs(dy) > 3) edgeDrag.moved = true;
    if (edgeDrag.moved) {
      window.api.setCollapsedPosition(edgeDrag.startWindowY + dy);
    }
  });

  document.addEventListener('mouseup', () => {
    if (!edgeDrag) return;
    const wasDrag = edgeDrag.moved;
    edgeDrag = null;
    if (!wasDrag && app.classList.contains('collapsed')) {
      showFromEdge();
    }
  });
}

function rgb(r, g, b) {
  return `rgb(${r}, ${g}, ${b})`;
}

function applyBgOpacity(val) {
  const alpha = Math.max(0, Math.min(1, val));
  const transparency = 1 - alpha;

  app.style.setProperty('--bg-opacity', alpha);
  app.style.setProperty('--border-alpha', (alpha * 0.06).toFixed(3));
  app.style.setProperty('--shadow-alpha', (alpha * 0.12).toFixed(3));
  app.style.setProperty('--blur', `${Math.round(alpha * 16)}px`);
  app.classList.toggle('bg-clear', alpha <= 0.02);
  app.classList.toggle('text-light', transparency >= 0.55);

  const theme = settings.theme || 'warm';
  const accents = { warm: [232, 168, 73], cool: [91, 141, 239], green: [82, 183, 136] };
  const [ar, ag, ab] = accents[theme];
  const accentAlpha = (0.15 * alpha).toFixed(3);
  app.style.setProperty('--accent-soft', `rgba(${ar}, ${ag}, ${ab}, ${accentAlpha})`);

  if (transparency >= 0.55) {
    app.style.setProperty('--text', '#ffffff');
    app.style.setProperty('--text-muted', 'rgba(255, 255, 255, 0.82)');
    app.style.setProperty('--placeholder', 'rgba(255, 255, 255, 0.55)');
    app.style.setProperty('--accent', rgb(ar, ag, ab));
    app.style.setProperty('--text-shadow', transparency >= 0.75 ? '0 1px 1px rgba(0,0,0,0.85)' : 'none');
  } else {
    app.style.setProperty('--text', '#2c2c2c');
    app.style.setProperty('--text-muted', '#8a8a8a');
    app.style.setProperty('--placeholder', '#999999');
    app.style.setProperty('--accent', rgb(ar, ag, ab));
    app.style.setProperty('--text-shadow', 'none');
  }
}

async function switchTab(tab) {
  if (tab === activeTab) return;
  saveNotesSync();
  activeTab = tab;
  renderTabs();
  loadEditorContent();
  await window.api.saveSettings({ activeTab: tab });
}

function saveNotesSync() {
  const notes = { ...(settings.notes || {}) };
  notes[activeTab] = getEditorHtml();
  settings.notes = notes;
}

async function saveNotes() {
  saveNotesSync();
  await window.api.saveSettings({ notes: settings.notes });
  statusEl.textContent = '已保存';
  statusEl.classList.add('saved');
}

async function persistSettings(data) {
  settings = await window.api.saveSettings(data);
}

async function togglePin() {
  isPinned = !isPinned;
  btnPin.classList.toggle('active', isPinned);
  await window.api.setAlwaysOnTop(isPinned);
}

async function hideToEdge() {
  const collapsed = !app.classList.contains('collapsed');
  await window.api.toggleEdge(collapsed);
}

async function showFromEdge() {
  await window.api.toggleEdge(false);
}

init();
