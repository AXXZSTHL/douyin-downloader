/* ============================================================
   dou+ v3 — Renderer Logic
   ============================================================ */
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => (p || document).querySelectorAll(s);

const D = {
  tbMin: $('#tb-min'), tbMax: $('#tb-max'), tbClose: $('#tb-close'),
  avatar: $('#user-avatar'), avatarPh: $('#user-avatar-placeholder'),
  nickname: $('#user-nickname'), statFlw: $('#stat-following'), statFlr: $('#stat-follower'), statAwm: $('#stat-aweme'),
  btnLogin: $('#btn-login'), btnRefresh: $('#btn-refresh-user'),
  settingPath: $('#setting-path'), settingThr: $('#setting-threads'),
  inputUrl: $('#input-url'), btnPaste: $('#btn-paste'), btnResolve: $('#btn-resolve'),
  progWrap: $('#progress-bar-wrap'), progBar: $('#progress-bar-inner'), progText: $('#progress-text'), btnStop: $('#btn-stop'),
  toast: $('#toast'),
  pages: { home: $('#page-home'), following: $('#page-following'), tasks: $('#page-tasks'), collections: $('#page-collections'), settings: $('#page-settings') },
  flwGrid: $('#following-grid'), flwLoading: $('#following-loading'), flwSearch: $('#following-search'),
  userDetail: $('#user-detail'), detailAv: $('#detail-avatar'), detailName: $('#detail-name'), detailId: $('#detail-id'),
  postsGrid: $('#posts-grid'), postsLoading: $('#posts-loading'), btnPostsMore: $('#btn-posts-more'),
  postsBatchBar: $('#posts-batch-bar'),
  hotList: $('#hot-trends-list'),
};

/* State */
let currentMode = 'post', threadCount = 5, currentPage = 'home';
let isDownloading = false, pollingTimer = null, jobId = null;
let activeJobs = [];
let followingUsers = [], flwMinTime = 0, flwHasMore = false, flwLoading = false;
let detailUser = null, detailPosts = [], detailCursor = 0, detailHasMore = false, detailLoading = false;
let selectedPosts = new Set();
let resolvedUser = null, resolvedPosts = [], resolvedCursor = 0;
let resolvedHasMore = false, resolvedLoading = false, resolvedMode = 'post';
let resolvingSelected = new Set();

/* API */
const api = window.electronAPI;
var API = 'http://127.0.0.1:18080';
async function GET(e) {
  try { var r = await fetch(API + e); return await r.json(); } catch (_) { return null; }
}
async function POST(e, b) {
  try {
    var r = await fetch(API + e, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return await r.json();
  } catch (_) { return null; }
}

/* Toast */
let _tt;
function toast(msg, type) { if (type === void 0) type = 'info';
  clearTimeout(_tt); D.toast.textContent = msg; D.toast.className = type + ' show';
  _tt = setTimeout(() => D.toast.classList.remove('show'), 2500);
}
function fmt(n) { if (!n) return '0'; if (n >= 10000) return (n / 10000).toFixed(1) + 'w'; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }

/* ============================== NAV ============================== */
function switchPage(name) {
  currentPage = name;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  Object.keys(D.pages).forEach(k => D.pages[k].classList.toggle('active', k === name));
  if (name === 'following' && followingUsers.length === 0) loadFollowing();
  if (name === 'home') loadHotTrends();
}

/* ============================== USER ============================== */
async function loadUserInfo() {
  var d = await GET('/api/v1/user');
  if (!d || !d.ok) {
    D.nickname.textContent = '未登录'; D.statFlw.textContent = '-'; D.statFlr.textContent = '-'; D.statAwm.textContent = '-';
    D.avatar.style.display = 'none'; D.avatarPh.style.display = ''; D.btnLogin.style.display = ''; D.btnRefresh.style.display = 'none';
    if (d && d.error) toast('加载用户信息失败: ' + d.error, 'err');
    return;
  }
  D.nickname.textContent = d.nickname || '?'; D.statFlw.textContent = fmt(d.following_count);
  D.statFlr.textContent = fmt(d.follower_count); D.statAwm.textContent = fmt(d.aweme_count);
  var av = ''; if (typeof d.avatar === 'string') av = d.avatar;
  else if (d.avatar && d.avatar.url_list) av = d.avatar.url_list[0] || '';
  if (av) { D.avatar.src = av; D.avatar.style.display = ''; D.avatarPh.style.display = 'none'; }
  else { D.avatar.style.display = 'none'; D.avatarPh.style.display = ''; }
  D.btnLogin.style.display = 'none'; D.btnRefresh.style.display = ''; toast('已登录: ' + d.nickname, 'ok');
}
async function triggerLogin() {
  D.btnLogin.disabled = true; D.btnLogin.textContent = '正在打开登录窗口...';
  toast('请在弹出的窗口中扫码登录抖音', 'info');
  var d = await api.login();
  D.btnLogin.disabled = false; D.btnLogin.textContent = '浏览器登录';
  if (d && d.ok) { toast('登录成功!', 'ok'); await loadUserInfo(); return; }
  toast('登录失败: ' + ((d && d.error) || '登录窗口已关闭'), 'err');
}

/* ============================== HOT TRENDS ============================== */
async function loadHotTrends() {
  var d = await GET('/api/v1/hot-board?limit=15');
  if (!d || !d.ok) { D.hotList.innerHTML = '<span style="color:#666;font-size:12px">加载失败</span>'; return; }
  var items = d.items || [];
  D.hotList.innerHTML = items.map((item, i) =>
    '<span class="hot-item" data-idx="' + i + '"><span class="idx">' + (i + 1) + '</span>' + (item.word || item.title || '') + '</span>'
  ).join('');
  // Click to search
  $$('.hot-item').forEach(el => {
    el.addEventListener('click', () => {
      D.inputUrl.value = 'https://www.douyin.com/search/' + encodeURIComponent(el.textContent.replace(/^\d+/, '').trim());
      doResolve();
    });
  });
}

/* ============================== TASK PANEL ============================== */
function addTask(jobId, url, extra) {
  if (extra === void 0) extra = {};
  activeJobs.unshift({
    id: jobId, url: url, status: 'running', success: 0, failed: 0, skipped: 0,
    mode: currentMode, author_name: extra.author || '', titles: extra.titles || [],
  });
  if (activeJobs.length > 50) activeJobs.length = 50;
  renderTasks();
}
function updateTask(jobId, data) {
  var j = activeJobs.find(j => j.id === jobId);
  if (!j) return;
  j.status = data.status === 'success' ? 'done' : (data.status === 'failed' ? 'fail' : 'running');
  j.success = data.success || 0; j.failed = data.failed || 0; j.skipped = data.skipped || 0;
  j.total = data.total || j.total || 0;
  j.author_name = data.author_name || j.author_name || '';
  j.save_path = data.save_path || j.save_path || '';
  if (data.items && data.items.length) j.items = data.items;
  renderTasks();
}
function taskHtml(j) {
  var isRunning = j.status === 'running' || j.status === 'pending';
  var isDone = j.status === 'done';
  var isFail = j.status === 'fail';
  var statusClass = isDone ? 'done' : (isFail ? 'fail' : 'running');
  var statusText = isDone ? '已完成' : (isFail ? '失败' : '下载中');
  var total = j.total || j.titles.length || 0;
  var done = (j.success || 0) + (j.failed || 0) + (j.skipped || 0);
  var pct = total > 0 ? Math.round(done / total * 100) : 0;
  var author = j.author_name || '';
  var modeLabel = ({ post: '作品', like: '喜欢', mix: '合集', music: '音乐', collect: '收藏' })[j.mode] || '作品';
  var displayName = (author ? author + ' · ' : '') + modeLabel;

  var html = '<div class="task-item" data-jobid="' + j.job_id + '">' +
    '<div class="t-header">' +
      '<div style="flex:1;min-width:0">' +
        '<div class="t-author">' + displayName + '</div>' +
      '</div>' +
      '<span class="t-status ' + statusClass + '">' + statusText + '</span>' +
    '</div>';

  if (isRunning) {
    html += '<div class="t-progress"><div class="t-progress-bar" style="width:' + pct + '%"></div></div>';
    html += '<div class="t-stats"><span>' + done + ' / ' + total + '</span>';
    if (total > 0) html += '<span>' + pct + '%</span>';
    html += '</div>';
  } else if (isDone) {
    html += '<div class="t-stats"><span style="color:#2ecc71">成功 ' + (j.success || total) + ' 项</span></div>';
  } else if (isFail) {
    html += '<div class="t-stats"><span style="color:#e74c3c">失败 ' + (j.failed || 0) + ' / 总计 ' + total + '</span></div>';
  }

  var titles = j.titles || [];
  if (titles.length > 0) {
    html += '<div class="t-items">';
    titles.slice(0, 8).forEach(function (t) {
      html += '<div class="t-item"><span class="t-item-title">' + t + '</span></div>';
    });
    if (titles.length > 8) html += '<div class="t-item"><span style="color:#666;font-size:11px">...还有 ' + (titles.length - 8) + ' 个</span></div>';
    html += '</div>';
  }

  if (j.save_path && isDone) {
    html += '<button class="btn-open-folder" data-path="' + j.save_path + '">📂 打开文件夹</button>';
  }
  html += '</div>';
  return html;
}
var taskFilter = 'running'; // 'running' | 'done' | 'all'
function renderTasks() {
  var running = activeJobs.filter(function (j) { return j.status === 'running' || j.status === 'pending'; });
  var done = activeJobs.filter(function (j) { return j.status === 'done' || j.status === 'fail'; });
  // Auto-switch: if current filter empty, fall back
  if (taskFilter === 'running' && running.length === 0) taskFilter = 'all';
  if (taskFilter === 'done' && done.length === 0) taskFilter = 'all';
  var filtered = taskFilter === 'running' ? running : (taskFilter === 'done' ? done : activeJobs);

  var pg = $('#task-page-list');
  if (pg) {
    pg.innerHTML = filtered.map(taskHtml).join('');
    $('#task-page-empty').style.display = activeJobs.length === 0 ? '' : 'none';
    $$('.btn-open-folder', pg).forEach(function (b) {
      b.addEventListener('click', function () { api.openPath(b.dataset.path); });
    });
  }
  // Update counts and active state
  var rn = $('#tf-running'); if (rn) rn.textContent = '下载中 (' + running.length + ')';
  var dn = $('#tf-done'); if (dn) dn.textContent = '已完成 (' + done.length + ')';
  var an = $('#tf-all'); if (an) an.textContent = '全部 (' + activeJobs.length + ')';
  $$('.task-filter-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.filter === taskFilter);
  });
}

/* ============================== DOWNLOAD ============================== */
async function startDownload(opts) {
  if (opts === void 0) opts = {};
  var url = D.inputUrl.value.trim();
  if (!url) { toast('请先粘贴链接', 'info'); return; }
  isDownloading = true;
  D.progWrap.style.display = ''; D.progBar.style.width = '0%'; D.progText.style.display = ''; D.progText.textContent = '提交中...'; D.btnStop.style.display = '';
  var path = D.settingPath.value;
  if (!path || path === '.') path = './Downloaded/';
  path = path.replace(/\\/g, '/');
  if (!path.endsWith('/')) path += '/';
  var body = { url: url, mode: currentMode, number: 0, path: path, thread: threadCount };

  // Use direct fetch, not Electron IPC, for reliability
  var d;
  try {
    var res = await fetch('http://127.0.0.1:18080/api/v1/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    d = await res.json();
  } catch (e) {
    resetDownloadUI();
    toast('网络错误: ' + e.message, 'err');
    return;
  }

  if (!d || !d.job_id) { resetDownloadUI(); toast('任务创建失败', 'err'); return; }
  jobId = d.job_id;
  addTask(jobId, url, { author: opts.author || '', titles: opts.titles || [] });
  pollJobStatus();
  toast('下载任务已创建', 'ok');
}
async function pollJobStatus() {
  if (!jobId || !isDownloading) return;
  var d = await GET('/api/v1/jobs/' + jobId);
  if (!d) { resetDownloadUI(); toast('状态获取失败', 'err'); return; }
  updateTask(jobId, d);
  if (d.status === 'running' || d.status === 'pending') {
    D.progText.textContent = d.status === 'pending' ? '等待...' : '下载中...';
    if (d.total > 0) { var p = Math.round((d.success + d.failed + d.skipped) / d.total * 100); D.progBar.style.width = Math.min(p, 100) + '%'; D.progText.textContent = '✓' + d.success + ' ✗' + d.failed + ' ○' + d.skipped; }
    pollingTimer = setTimeout(pollJobStatus, 1000); return;
  }
  D.progBar.style.width = '100%'; D.progText.textContent = (d.status === 'success' ? '完成!' : '部分完成') + ' 总计' + d.total + ' 成功' + d.success + ' 失败' + d.failed;
  toast(d.status === 'success' ? '下载完成! ' + d.success + ' 项成功' : '部分失败，' + d.success + ' 项成功', d.status === 'success' ? 'ok' : 'err');
  resetDownloadUI(false);
}
function stopDownload() { isDownloading = false; clearTimeout(pollingTimer); pollingTimer = null; jobId = null; resetDownloadUI(true); toast('已停止', 'info'); }
function resetDownloadUI(clear) { if (clear === void 0) clear = true;
  isDownloading = false;
  if (clear) { D.progWrap.style.display = 'none'; D.progBar.style.width = '0%'; D.progText.style.display = 'none'; D.btnStop.style.display = 'none'; }
  clearTimeout(pollingTimer); pollingTimer = null;
}

/* ============================== RESOLVE ============================== */
function extractDouyinLink(text) {
  var patterns = [/https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+\/?/, /https?:\/\/www\.douyin\.com\/[^\s]+/, /https?:\/\/v\.iesdouyin\.com\/[A-Za-z0-9]+\/?/];
  for (var i = 0; i < patterns.length; i++) { var m = text.match(patterns[i]); if (m) return m[0].replace(/\/$/, ''); }
  return null;
}
async function doResolve() {
  var url = D.inputUrl.value.trim();
  if (!url) { toast('请先粘贴链接', 'info'); return; }
  var link = extractDouyinLink(url);
  if (!link) { toast('未识别到抖音链接', 'err'); return; }
  D.inputUrl.value = link; toast('正在解析...', 'info');
  var data = await GET('/api/v1/resolve?url=' + encodeURIComponent(link));
  if (!data || !data.ok) { toast('解析失败: ' + (data ? data.error : '网络错误'), 'err'); return; }
  if (data.type === 'user' && data.user) showResolvedUser(data);
  else if (data.type === 'video' || data.type === 'note') { D.inputUrl.value = data.resolved; startDownload(); }
  else toast('暂不支持此链接类型', 'info');
}

/* ============================== RESOLVED VIEW ============================== */
function showResolvedUser(data) {
  resolvedUser = data.user; resolvedPosts = data.posts || []; resolvedCursor = data.max_cursor || 0; resolvedHasMore = data.has_more || false; resolvingSelected.clear();
  $('#hero-area').style.display = 'none'; $('#hot-trends').style.display = 'none';
  var rv = $('#resolved-view');
  if (!rv) {
    rv = document.createElement('div'); rv.id = 'resolved-view';
    rv.style.cssText = 'width:100%;max-width:700px;margin:0 auto';
    rv.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<button class="btn-text-only" id="btn-resolved-back" style="font-size:13px">&larr; 返回</button>' +
        '<img id="resolved-avatar" style="width:40px;height:40px;border-radius:50%;object-fit:cover;background:#1a1a1a" />' +
        '<div><div id="resolved-name" style="font-size:15px;font-weight:700"></div><div id="resolved-followers" style="font-size:11px;color:#666"></div></div>' +
      '</div>' +
      '<div id="resolved-mode-row">' +
        '<span style="font-size:11px;color:#666;margin-right:4px">模式:</span>' +
        '<button class="mode-chip active" data-rmode="post">作品</button>' +
        '<button class="mode-chip" data-rmode="like">喜欢</button>' +
        '<button class="mode-chip" data-rmode="mix">合集</button>' +
        '<button class="mode-chip" data-rmode="music">音乐</button>' +
        '<div style="margin-left:auto;display:flex;gap:8px">' +
          '<button id="btn-resolved-dl-all" style="padding:7px 18px;border:none;border-radius:20px;background:var(--pink);color:#fff;font-size:12px;font-weight:600;cursor:pointer">下载全部</button>' +
          '<button id="btn-resolved-dl-sel" style="padding:7px 18px;border:1px solid var(--pink);border-radius:20px;background:none;color:var(--pink);font-size:12px;font-weight:600;cursor:pointer;display:none">下载选中</button>' +
        '</div>' +
      '</div>' +
      '<div id="resolved-posts-grid"></div>' +
      '<div id="resolved-posts-more" style="text-align:center;padding:16px;color:#666;font-size:12px;display:none">滚动加载更多...</div>' +
      '<div id="resolved-batch-bar" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111;border:1px solid #333;border-radius:24px;padding:12px 24px;display:none;align-items:center;gap:16px;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:100">' +
        '<span id="resolved-batch-count">已选 0 个</span><button id="btn-resolved-batch-dl" style="padding:7px 18px;border:none;border-radius:20px;background:var(--pink);color:#fff;font-size:12px;font-weight:600;cursor:pointer">下载选中</button><button id="btn-resolved-batch-clear" style="padding:6px 14px;border:1px solid #333;border-radius:20px;background:none;color:#999;font-size:12px;cursor:pointer">取消</button>' +
      '</div>';
    $('#home-center').appendChild(rv);
    $('#btn-resolved-back', rv).addEventListener('click', hideResolvedView);
    $('#btn-resolved-dl-all', rv).addEventListener('click', () => {
      if (resolvedUser) { var u = resolvedUser.sec_uid; var name = resolvedUser.nickname; var names = resolvedPosts.map(function (p) { return p.desc || p.aweme_id; }); currentMode = resolvedMode; hideResolvedView(); D.inputUrl.value = 'https://www.douyin.com/user/' + u; startDownload({ author: name, titles: names }); }
    });
    $('#btn-resolved-dl-sel', rv).addEventListener('click', () => {
      if (resolvingSelected.size) {
        var titleMap = {}; resolvedPosts.forEach(function (p) { titleMap[p.aweme_id] = p.desc || p.aweme_id; });
        downloadSelectedAwemes(Array.from(resolvingSelected), titleMap);
      }
    });
    $('#btn-resolved-batch-dl', rv).addEventListener('click', () => {
      if (resolvingSelected.size) {
        var titleMap = {}; resolvedPosts.forEach(function (p) { titleMap[p.aweme_id] = p.desc || p.aweme_id; });
        downloadSelectedAwemes(Array.from(resolvingSelected), titleMap);
      }
    });
    $('#btn-resolved-batch-clear', rv).addEventListener('click', () => { resolvingSelected.clear(); updateResolvedBatch(); renderResolvedPosts(); });
    $$('[data-rmode]', rv).forEach(c => c.addEventListener('click', () => { $$('[data-rmode]', rv).forEach(x => x.classList.remove('active')); c.classList.add('active'); resolvedMode = c.dataset.rmode; }));
    $('#home-center').addEventListener('scroll', checkResolvedScroll);
  }
  rv.style.display = '';
  // Observe "load more" indicator for infinite scroll
  setupResolvedObserver();
  $('#resolved-name', rv).textContent = resolvedUser.nickname || '?';
  $('#resolved-followers', rv).textContent =
    (resolvedUser.follower_count ? fmt(resolvedUser.follower_count) + ' 粉丝 · ' : '') +
    (resolvedUser.aweme_count ? '共 ' + resolvedUser.aweme_count + ' 个作品' : '');
  $('#resolved-avatar', rv).src = resolvedUser.avatar || '';
  renderResolvedPosts();
}
function hideResolvedView() {
  var rv = $('#resolved-view'); if (rv) rv.style.display = 'none';
  var ha = $('#hero-area'); if (ha) ha.style.display = '';
  var ht = $('#hot-trends'); if (ht) ht.style.display = '';
  resolvedUser = null; resolvedPosts = []; resolvingSelected.clear();
}
async function downloadSelectedAwemes(ids, titleMap) {
  if (titleMap === void 0) titleMap = {};
  var author = resolvedUser ? resolvedUser.nickname : '';
  hideResolvedView(); resolvingSelected.clear();
  var path = D.settingPath.value || './Downloaded/';
  toast('提交 ' + ids.length + ' 个视频下载...', 'info');
  for (var i = 0; i < ids.length; i++) {
    var url = 'https://www.douyin.com/video/' + ids[i];
    var d = await POST('/api/v1/download', { url: url, mode: 'post', number: 1, path: path, thread: 5 });
    if (d && d.job_id) {
      addTask(d.job_id, url, { author: author, titles: [titleMap[ids[i]] || '视频 ' + ids[i]] });
      pollSingleJob(d.job_id);
    } else {
      toast('第 ' + (i + 1) + ' 个视频提交失败', 'err');
    }
    await new Promise(function (r) { return setTimeout(r, 800); });
  }
  toast('已提交 ' + ids.length + ' 个下载任务', 'ok');
}
function pollSingleJob(tid) {
  setTimeout(async function () {
    var dd = await GET('/api/v1/jobs/' + tid);
    if (!dd) return;
    updateTask(tid, dd);
    // Also update home progress bar
    var total = dd.total || 0;
    var done = (dd.success || 0) + (dd.failed || 0) + (dd.skipped || 0);
    if (total > 0) {
      D.progWrap.style.display = '';
      D.progBar.style.width = Math.min(Math.round(done / total * 100), 100) + '%';
      D.progText.style.display = '';
      D.progText.textContent = done + ' / ' + total;
    }
    if (dd.status !== 'running' && dd.status !== 'pending') {
      if (dd.status === 'success') { D.progBar.style.width = '100%'; D.progText.textContent = '完成 ' + total + ' 项'; }
      setTimeout(function () { D.progWrap.style.display = 'none'; D.progText.style.display = 'none'; }, 2000);
      return;
    }
    pollSingleJob(tid);
  }, 800);
}
function renderResolvedPosts() {
  var grid = $('#resolved-posts-grid'); if (!grid) return; grid.innerHTML = '';
  resolvedPosts.forEach(p => {
    var card = document.createElement('div');
    card.style.cssText = 'position:relative;border-radius:14px;overflow:hidden;cursor:pointer;aspect-ratio:3/4;background:#1a1a1a;border:2px solid ' + (resolvingSelected.has(p.aweme_id) ? 'var(--pink)' : 'transparent');
    card.innerHTML =
      (p.cover ? '<img src="' + p.cover + '" style="width:100%;height:100%;object-fit:cover" />' : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555">无封面</div>') +
      '<div style="position:absolute;bottom:0;left:0;right:0;padding:8px;background:linear-gradient(transparent,rgba(0,0,0,0.8))"><div style="font-size:11px;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4">' + (p.desc || '(无描述)') + '</div></div>' +
      (p.duration ? '<div style="position:absolute;bottom:8px;right:8px;font-size:10px;color:#fff;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px">' + Math.floor(p.duration / 60) + ':' + String(p.duration % 60).padStart(2, '0') + '</div>' : '') +
      '<div class="post-check" style="position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;border:2px solid ' + (resolvingSelected.has(p.aweme_id) ? 'var(--pink)' : '#fff') + ';background:' + (resolvingSelected.has(p.aweme_id) ? 'var(--pink)' : 'rgba(0,0,0,0.4)') + ';display:flex;align-items:center;justify-content:center">' + (resolvingSelected.has(p.aweme_id) ? '<span style="color:#fff;font-size:12px;font-weight:700">✓</span>' : '') + '</div>';
    card.addEventListener('click', () => toggleResolvedPost(p.aweme_id, card));
    grid.appendChild(card);
  });
  $('#resolved-posts-more').style.display = resolvedHasMore ? '' : 'none';
  updateResolvedBatch();
}
function toggleResolvedPost(aid, card) {
  if (resolvingSelected.has(aid)) resolvingSelected.delete(aid); else resolvingSelected.add(aid);
  var s = resolvingSelected.has(aid);
  if (card) { card.style.borderColor = s ? 'var(--pink)' : 'transparent'; var ck = card.querySelector('.post-check');
    if (ck) { ck.style.borderColor = s ? 'var(--pink)' : '#fff'; ck.style.background = s ? 'var(--pink)' : 'rgba(0,0,0,0.4)'; ck.innerHTML = s ? '<span style="color:#fff;font-size:12px;font-weight:700">✓</span>' : ''; } }
  updateResolvedBatch();
}
function updateResolvedBatch() {
  var n = resolvingSelected.size; var bar = $('#resolved-batch-bar'); if (!bar) return;
  bar.style.display = n > 0 ? 'flex' : 'none'; if (n > 0) $('#resolved-batch-count').textContent = '已选 ' + n + ' 个';
  $('#btn-resolved-dl-sel').style.display = n > 0 ? '' : 'none';
}
function checkResolvedScroll() {
  if (resolvedUser && resolvedHasMore && !resolvedLoading) {
    var el = $('#home-center');
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 300) loadMoreResolved();
  }
}
var resolvedObserver = null;
function setupResolvedObserver() {
  if (resolvedObserver) resolvedObserver.disconnect();
  var sentinel = $('#resolved-posts-more');
  if (!sentinel) return;
  resolvedObserver = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting && resolvedHasMore && !resolvedLoading) loadMoreResolved();
  }, { root: $('#home-center'), threshold: 0.1 });
  resolvedObserver.observe(sentinel);
}
async function loadMoreResolved() {
  if (!resolvedUser || resolvedLoading) return; resolvedLoading = true;
  var moreEl = $('#resolved-posts-more'); if (moreEl) moreEl.textContent = '加载中...';
  var d = await GET('/api/v1/user/posts?sec_uid=' + resolvedUser.sec_uid + '&max_cursor=' + resolvedCursor + '&count=18');
  resolvedLoading = false;
  if (d && d.ok) {
    var newPosts = d.posts || [];
    if (newPosts.length > 0) {
      resolvedPosts = resolvedPosts.concat(newPosts);
      resolvedCursor = d.max_cursor || 0;
      resolvedHasMore = d.has_more || false;
      renderResolvedPosts();
      setupResolvedObserver(); // re-observe new sentinel
    } else {
      resolvedHasMore = false;
    }
  }
  if (moreEl) {
    if (resolvedHasMore) {
      moreEl.innerHTML = '<button class="btn-primary-sm" onclick="loadMoreResolved()">加载更多</button>';
      moreEl.style.display = '';
    } else {
      moreEl.textContent = '已加载全部';
    }
  }
}

/* ============================== FOLLOWING ============================== */
async function loadFollowing(append) { if (append === void 0) append = false;
  if (!append) { followingUsers = []; flwMinTime = 0; flwHasMore = false; D.flwGrid.innerHTML = ''; D.flwLoading.style.display = 'block'; }
  if (flwLoading) return; flwLoading = true;
  var d = await GET('/api/v1/following?max_time=' + flwMinTime + '&count=20');
  flwLoading = false; D.flwLoading.style.display = 'none';
  if (!d || !d.ok) { toast('加载失败: ' + (d ? d.error : ''), 'err'); return; }
  flwHasMore = d.has_more; flwMinTime = d.min_time || 0;
  if (!append) followingUsers = d.users || []; else followingUsers = followingUsers.concat(d.users || []);
  renderFollowing();
}
function renderFollowing() {
  var q = (D.flwSearch.value || '').trim().toLowerCase();
  var filtered = q ? followingUsers.filter(u => (u.nickname || '').toLowerCase().includes(q)) : followingUsers;
  D.flwGrid.innerHTML = '';
  filtered.forEach(u => {
    var card = document.createElement('div'); card.className = 'user-card-item';
    card.innerHTML = (u.avatar ? '<img class="user-card-avatar" src="' + u.avatar + '" />' : '<div class="user-card-avatar-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/></svg></div>') +
      '<div class="user-card-name">' + (u.nickname || '?') + '</div>' + (u.follower_count ? '<div class="user-card-followers">' + fmt(u.follower_count) + ' 粉丝</div>' : '');
    card.addEventListener('click', () => openUserDetail(u));
    D.flwGrid.appendChild(card);
  });
  if (flwHasMore && !q) { var m = document.createElement('div'); m.style.cssText = 'text-align:center;padding:16px;grid-column:1/-1;'; m.innerHTML = '<span style="color:#666;font-size:12px">滚动加载更多...</span>'; D.flwGrid.appendChild(m); }
}
async function openUserDetail(u) {
  detailUser = u; detailPosts = []; detailCursor = 0; detailHasMore = false; selectedPosts.clear();
  D.userDetail.style.display = 'flex'; D.flwGrid.style.display = 'none'; D.flwLoading.style.display = 'none';
  D.detailAv.src = u.avatar || ''; D.detailName.textContent = u.nickname || '?'; D.detailId.textContent = u.unique_id ? '@' + u.unique_id : '';
  D.postsGrid.innerHTML = ''; await loadUserPosts();
}
async function loadUserPosts() {
  if (!detailUser || detailLoading) return; detailLoading = true;
  D.postsLoading.style.display = 'block'; D.btnPostsMore.style.display = 'none';
  var d = await GET('/api/v1/user/posts?sec_uid=' + detailUser.sec_uid + '&max_cursor=' + detailCursor + '&count=18');
  detailLoading = false; D.postsLoading.style.display = 'none';
  if (!d || !d.ok) { toast('加载作品失败', 'err'); return; }
  detailPosts = detailCursor === 0 ? (d.posts || []) : detailPosts.concat(d.posts || []);
  detailCursor = d.max_cursor || 0; detailHasMore = d.has_more || false;
  renderPosts();
}
function renderPosts() {
  D.postsGrid.innerHTML = '';
  detailPosts.forEach(p => {
    var card = document.createElement('div');
    card.style.cssText = 'position:relative;border-radius:14px;overflow:hidden;cursor:pointer;aspect-ratio:3/4;background:#1a1a1a;border:2px solid ' + (selectedPosts.has(p.aweme_id) ? 'var(--pink)' : 'transparent');
    card.innerHTML =
      (p.cover ? '<img src="' + p.cover + '" style="width:100%;height:100%;object-fit:cover" />' : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555">无封面</div>') +
      '<div style="position:absolute;bottom:0;left:0;right:0;padding:8px;background:linear-gradient(transparent,rgba(0,0,0,0.8))"><div style="font-size:11px;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4">' + (p.desc || '(无描述)') + '</div></div>' +
      (p.duration ? '<div style="position:absolute;bottom:8px;right:8px;font-size:10px;color:#fff;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px">' + Math.floor(p.duration / 60) + ':' + String(p.duration % 60).padStart(2, '0') + '</div>' : '') +
      '<div class="post-check" style="position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;border:2px solid ' + (selectedPosts.has(p.aweme_id) ? 'var(--pink)' : '#fff') + ';background:' + (selectedPosts.has(p.aweme_id) ? 'var(--pink)' : 'rgba(0,0,0,0.4)') + ';display:flex;align-items:center;justify-content:center">' + (selectedPosts.has(p.aweme_id) ? '<span style="color:#fff;font-size:12px;font-weight:700">✓</span>' : '') + '</div>';
    card.addEventListener('click', () => togglePost(p.aweme_id, card));
    D.postsGrid.appendChild(card);
  });
  if (detailHasMore) { var m = document.createElement('div'); m.style.cssText = 'text-align:center;padding:16px;grid-column:1/-1;'; m.innerHTML = '<span style="color:#666;font-size:12px">滚动加载更多...</span>'; D.postsGrid.appendChild(m); }
  updatePostsBatch();
}
function togglePost(aid, card) {
  if (selectedPosts.has(aid)) selectedPosts.delete(aid); else selectedPosts.add(aid);
  var s = selectedPosts.has(aid);
  if (card) { card.style.borderColor = s ? 'var(--pink)' : 'transparent'; var ck = card.querySelector('.post-check');
    if (ck) { ck.style.borderColor = s ? 'var(--pink)' : '#fff'; ck.style.background = s ? 'var(--pink)' : 'rgba(0,0,0,0.4)'; ck.innerHTML = s ? '<span style="color:#fff;font-size:12px;font-weight:700">✓</span>' : ''; } }
  updatePostsBatch();
}
function updatePostsBatch() { var n = selectedPosts.size; D.postsBatchBar.style.display = n > 0 ? 'flex' : 'none'; if (n > 0) $('#posts-batch-count').textContent = '已选 ' + n + ' 个'; }
async function downloadSelectedPosts() {
  if (selectedPosts.size === 0) return;
  var ids = Array.from(selectedPosts);
  var titleMap = {}; detailPosts.forEach(function (p) { titleMap[p.aweme_id] = p.desc || p.aweme_id; });
  switchPage('home'); selectedPosts.clear(); updatePostsBatch();
  await downloadSelectedAwemes(ids, titleMap);
}

/* ============================== EVENTS ============================== */
D.tbMin.addEventListener('click', () => api.minimize()); D.tbMax.addEventListener('click', () => api.maximize()); D.tbClose.addEventListener('click', () => api.close());
D.btnLogin.addEventListener('click', triggerLogin); D.btnRefresh.addEventListener('click', loadUserInfo);
D.settingThr.textContent = threadCount;
$$('.stepper-btn').forEach(b => b.addEventListener('click', () => { threadCount += b.dataset.action === 'up' ? 1 : -1; threadCount = Math.max(1, Math.min(20, threadCount)); D.settingThr.textContent = threadCount; }));
$$('.nav-btn').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));
D.btnStop.addEventListener('click', stopDownload);
D.btnResolve.addEventListener('click', doResolve);
D.inputUrl.addEventListener('keydown', e => { if (e.key === 'Enter') doResolve(); });
D.btnPaste.addEventListener('click', async () => { try { var t = await navigator.clipboard.readText(); if (t) { D.inputUrl.value = t.trim(); var l = extractDouyinLink(t); if (l) doResolve(); } } catch (_) { toast('剪贴板读取失败', 'info'); } });
D.flwSearch.addEventListener('input', () => { renderFollowing(); if (flwHasMore && D.flwSearch.value.trim()) autoLoadAllFollowing(); });
async function autoLoadAllFollowing() { while (flwHasMore && !flwLoading) { await loadFollowing(true); } renderFollowing(); }
$('#btn-back-following').addEventListener('click', () => { D.userDetail.style.display = 'none'; D.flwGrid.style.display = ''; selectedPosts.clear(); updatePostsBatch(); });
$('#btn-detail-dl-all').addEventListener('click', () => {
  if (detailUser) { var u = detailUser.sec_uid; var names = detailPosts.map(function (p) { return p.desc || p.aweme_id; }); switchPage('home'); D.inputUrl.value = 'https://www.douyin.com/user/' + u; startDownload({ author: detailUser.nickname, titles: names }); }
});
D.btnPostsMore.addEventListener('click', () => loadUserPosts());
$('#btn-posts-batch-dl').addEventListener('click', downloadSelectedPosts);
$('#btn-posts-batch-clear').addEventListener('click', () => { selectedPosts.clear(); updatePostsBatch(); renderPosts(); });
$('#btn-browse-path').addEventListener('click', async () => { var dir = await api.openDirectory(); if (dir) { D.settingPath.value = dir; localStorage.setItem('dlPath', dir); } });
$('#btn-logout').addEventListener('click', async () => {
  var d = await POST('/api/v1/logout');
  if (d && d.ok) {
    D.nickname.textContent = '未登录'; D.statFlw.textContent = '-'; D.statFlr.textContent = '-'; D.statAwm.textContent = '-';
    D.avatar.style.display = 'none'; D.avatarPh.style.display = '';
    D.btnLogin.style.display = ''; D.btnRefresh.style.display = 'none';
    toast('已退出登录', 'ok');
  } else { toast('退出失败', 'err'); }
});
D.pages.following.addEventListener('scroll', () => { var el = D.pages.following; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && flwHasMore && !flwLoading && !(D.flwSearch.value || '').trim()) loadFollowing(true); });
D.userDetail.addEventListener('scroll', () => { if (D.userDetail.scrollTop + D.userDetail.clientHeight >= D.userDetail.scrollHeight - 200 && detailHasMore && !detailLoading) loadUserPosts(); });

/* Task filter tabs */
$$('.task-filter-btn').forEach(function (b) {
  b.addEventListener('click', function () { taskFilter = b.dataset.filter; renderTasks(); });
});
$('#btn-clear-tasks').addEventListener('click', async function () {
  await POST('/api/v1/jobs/clear', {});
  activeJobs = activeJobs.filter(function (j) { return j.status === 'running' || j.status === 'pending'; });
  taskFilter = 'running';
  renderTasks();
  toast('已清空已完成的任务', 'ok');
});

/* Clipboard poll */
var _lastClip = '';
setInterval(async () => { try { var t = await navigator.clipboard.readText(); if (t && t !== _lastClip) { _lastClip = t; var l = extractDouyinLink(t); if (l && currentPage === 'home') { D.inputUrl.value = l; doResolve(); } } } catch (_) {} }, 1500);

/* Load past tasks */
async function loadTaskHistory() {
  var d = await GET('/api/v1/jobs');
  if (d && d.jobs) {
    activeJobs = d.jobs.map(function (j) {
      j.id = j.job_id || j.id; j.mode = j.mode || 'post'; return j;
    });
    renderTasks();
  }
}

/* ============================== AUTO UPDATE ============================== */
var updateStatusEl = $('#update-status'), updateBtnEl = $('#btn-check-update');
function showUpdateStatus(type, msg) {
  if (!updateStatusEl) return;
  updateStatusEl.style.display = ''; updateStatusEl.textContent = msg;
  updateStatusEl.className = type === 'downloading' ? 'update-downloading' : (type === 'ready' ? 'update-ready' : '');
  if (updateBtnEl) updateBtnEl.style.display = (type === 'none' || type === 'error') ? '' : 'none';
}
api.onUpdateStatus(function (info) {
  switch (info.type) {
    case 'available': showUpdateStatus('available', '发现新版本 v' + info.version + '，正在等待确认...'); break;
    case 'downloading': showUpdateStatus('downloading', '正在下载更新... ' + (info.percent || 0) + '%'); break;
    case 'downloaded': showUpdateStatus('ready', '更新已下载，重启后生效'); break;
    case 'none': showUpdateStatus('none', '已是最新版本'); break;
    case 'error': showUpdateStatus('error', '检查更新失败: ' + (info.message || '')); break;
  }
});
if (updateBtnEl) updateBtnEl.addEventListener('click', function () { showUpdateStatus('downloading', '正在检查...'); api.checkUpdate(); });
// Show check button and version for packaged app
api.isPackaged().then(function (p) {
  if (p && updateBtnEl) updateBtnEl.style.display = '';
});
api.getVersion().then(function (v) { var el = $('#app-version'); if (el) el.textContent = v || '3.0.0'; });

/* INIT */
api.getDownloadsPath().then(p => { var saved = localStorage.getItem('dlPath'); D.settingPath.value = saved || (p + (navigator.platform.includes('Win') ? '\\' : '/')); });
switchPage('home'); setTimeout(loadUserInfo, 1500); setTimeout(loadHotTrends, 2000); setTimeout(loadTaskHistory, 2500);
