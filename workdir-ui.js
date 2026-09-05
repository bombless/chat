(() => {
  const STYLE_ID = '__workdir_style';
  const PANEL_ID = '__workdir_panel';

  function esc(value) {
    return String(value ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[c]);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败: ${response.status}`);
    return data;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #__workdir_bar { display:flex; align-items:center; gap:8px; width:100%; padding:8px 20px; background:#102a4a; border-bottom:1px solid #1a4a7a; }
      #__workdir_bar .wd-label { color:#8899bb; font-size:12px; }
      #__workdir_current { flex:1; min-width:0; background:#1a1a2e; color:#e0e0e0; border:1px solid #2a3a5a; border-radius:10px; padding:7px 10px; font-size:12px; }
      #__workdir_add { padding:7px 12px; border:0; border-radius:10px; background:#1a4a7a; color:#e0e0e0; cursor:pointer; }
      #__workdir_add:hover { background:#2a5a8a; }
      #${PANEL_ID} { position:fixed; inset:0; z-index:9999; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.65); }
      #${PANEL_ID}.open { display:flex; }
      #${PANEL_ID} .wd-dialog { width:min(620px,calc(100vw - 32px)); background:#16213e; border:1px solid #2a4a6a; border-radius:14px; padding:18px; box-shadow:0 20px 60px rgba(0,0,0,.6); }
      #${PANEL_ID} h3 { margin-bottom:12px; font-size:16px; }
      #${PANEL_ID} .wd-help { color:#8899bb; font-size:12px; margin-bottom:10px; line-height:1.5; }
      #${PANEL_ID} input { width:100%; padding:10px 12px; background:#1a1a2e; border:1px solid #3a5a7a; color:#e0e0e0; border-radius:9px; outline:none; }
      #${PANEL_ID} .wd-list { margin:12px 0; max-height:220px; overflow:auto; display:flex; flex-direction:column; gap:6px; }
      #${PANEL_ID} .wd-item { display:flex; gap:8px; align-items:center; padding:9px 10px; background:#1a2a3a; border-radius:9px; cursor:pointer; }
      #${PANEL_ID} .wd-item:hover { background:#21364a; }
      #${PANEL_ID} .wd-item.active { border:1px solid #4a8aaa; }
      #${PANEL_ID} .wd-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
      #${PANEL_ID} .wd-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
      #${PANEL_ID} button { border:0; border-radius:9px; padding:8px 13px; color:#e0e0e0; background:#2a3a5a; cursor:pointer; }
      #${PANEL_ID} .wd-primary { background:#1a4a7a; }
      #${PANEL_ID} .wd-error { color:#e06a6a; min-height:18px; margin-top:8px; font-size:12px; }
    `;
    document.head.appendChild(style);
  }

  function createUI() {
    installStyle();
    const header = document.querySelector('.header');
    if (!header || document.getElementById('__workdir_bar')) return;

    const bar = document.createElement('div');
    bar.id = '__workdir_bar';
    bar.innerHTML = `<span class="wd-label">工作目录</span><select id="__workdir_current"></select><button id="__workdir_add">＋ 添加目录</button>`;
    header.insertAdjacentElement('afterend', bar);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `<div class="wd-dialog"><h3>添加工作目录</h3><div class="wd-help">输入运行 Chat 服务的机器上的目录绝对路径，例如 /home/user/project 或 D:\\projects\\demo。</div><input id="__workdir_input" placeholder="/path/to/project" /><div id="__workdir_list" class="wd-list"></div><div id="__workdir_error" class="wd-error"></div><div class="wd-actions"><button id="__workdir_cancel">取消</button><button id="__workdir_save" class="wd-primary">添加并切换</button></div></div>`;
    document.body.appendChild(panel);

    document.getElementById('__workdir_add').onclick = () => {
      document.getElementById('__workdir_error').textContent = '';
      document.getElementById('__workdir_input').value = '';
      panel.classList.add('open');
      document.getElementById('__workdir_input').focus();
    };
    document.getElementById('__workdir_cancel').onclick = () => panel.classList.remove('open');
    panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
    document.getElementById('__workdir_save').onclick = addWorkdir;
    document.getElementById('__workdir_input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWorkdir(); });
    document.getElementById('__workdir_current').onchange = async (e) => {
      try {
        await api('/api/workdir', { method: 'POST', body: JSON.stringify({ path: e.target.value }) });
        window.location.reload();
      } catch (error) {
        alert(error.message);
        await loadWorkdirs();
      }
    };
  }

  async function loadWorkdirs() {
    const data = await api('/api/workdirs');
    const select = document.getElementById('__workdir_current');
    if (!select) return;
    select.innerHTML = data.workdirs.map((item) => `<option value="${esc(item.path)}" ${item.active ? 'selected' : ''}>${esc(item.name)} — ${esc(item.path)}</option>`).join('');
    select.title = data.current || '';
    const list = document.getElementById('__workdir_list');
    if (list) {
      list.innerHTML = data.workdirs.map((item) => `<div class="wd-item ${item.active ? 'active' : ''}" data-path="${esc(item.path)}"><span class="wd-path">${esc(item.path)}</span>${item.active ? '<span>当前</span>' : ''}</div>`).join('');
      list.querySelectorAll('.wd-item').forEach((el) => el.onclick = () => {
        document.getElementById('__workdir_current').value = el.dataset.path;
        document.getElementById('__workdir_current').dispatchEvent(new Event('change'));
      });
    }
  }

  async function addWorkdir() {
    const input = document.getElementById('__workdir_input');
    const error = document.getElementById('__workdir_error');
    const button = document.getElementById('__workdir_save');
    const value = input.value.trim();
    if (!value) { error.textContent = '请输入目录路径'; return; }
    button.disabled = true;
    error.textContent = '正在验证并切换工作目录…';
    try {
      await api('/api/workdirs', { method: 'POST', body: JSON.stringify({ path: value }) });
      window.location.reload();
    } catch (e) {
      error.textContent = e.message;
      button.disabled = false;
    }
  }

  async function boot() {
    try {
      createUI();
      await loadWorkdirs();
    } catch (e) {
      console.error('工作目录功能初始化失败:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
