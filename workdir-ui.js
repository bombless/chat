(() => {
  const STYLE_ID = '__workdir_style';
  const PANEL_ID = '__workdir_panel';
  const APPROVAL_ID = '__workdir_approval';

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
      #${APPROVAL_ID} { position:fixed; inset:0; z-index:10000; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.72); }
      #${APPROVAL_ID}.open { display:flex; }
      #${APPROVAL_ID} .wd-approval-dialog { width:min(560px,calc(100vw - 32px)); background:#16213e; border:1px solid #7a6a2a; border-radius:14px; padding:20px; box-shadow:0 20px 70px rgba(0,0,0,.7); }
      #${APPROVAL_ID} h3 { margin:0 0 10px; font-size:17px; }
      #${APPROVAL_ID} .wd-approval-help { color:#aab7cc; font-size:13px; line-height:1.6; }
      #${APPROVAL_ID} .wd-approval-path { margin-top:12px; padding:11px 12px; border-radius:9px; background:#1a1a2e; border:1px solid #3a4a5a; color:#e8edf5; font-family:monospace; font-size:13px; word-break:break-all; }
      #${APPROVAL_ID} .wd-approval-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
      #${APPROVAL_ID} button { border:0; border-radius:9px; padding:9px 15px; color:#e0e0e0; cursor:pointer; }
      #${APPROVAL_ID} .wd-deny { background:#6b2a3a; }
      #${APPROVAL_ID} .wd-approve { background:#2a6a4a; }
      #${APPROVAL_ID} button:disabled { opacity:.5; cursor:not-allowed; }
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

  // 模型调用 add_working_directory 时弹出确认框。
  // 返回值会作为 tool result 写回模型，因此“拒绝”也是明确的工具结果，而不是静默中断。
  async function requestWorkingDirectoryApproval(workdir) {
    installStyle();
    createUI();

    let request;
    try {
      request = await api('/api/workdir-requests', {
        method: 'POST',
        body: JSON.stringify({ path: workdir }),
      });
    } catch (e) {
      return { approved: false, path: workdir, error: e.message || String(e) };
    }

    const old = document.getElementById(APPROVAL_ID);
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = APPROVAL_ID;
    modal.className = 'open';
    modal.innerHTML = `
      <div class="wd-approval-dialog">
        <h3>🔐 请求添加工作目录</h3>
        <div class="wd-approval-help">AI 请求将当前项目工作目录切换到下面的路径。只有你点击“允许”后才会真正添加并切换。</div>
        <div class="wd-approval-path"></div>
        <div class="wd-approval-actions">
          <button class="wd-deny">否决</button>
          <button class="wd-approve">允许添加</button>
        </div>
      </div>`;
    modal.querySelector('.wd-approval-path').textContent = request.path;
    document.body.appendChild(modal);

    return new Promise((resolve) => {
      let settled = false;
      const finish = async (approved) => {
        if (settled) return;
        settled = true;
        const buttons = modal.querySelectorAll('button');
        buttons.forEach((button) => { button.disabled = true; });
        try {
          const result = await api('/api/workdir-requests/' + encodeURIComponent(request.id), {
            method: 'POST',
            body: JSON.stringify({ approved }),
          });
          modal.remove();
          if (approved) await loadWorkdirs();
          resolve(result);
        } catch (e) {
          settled = false;
          buttons.forEach((button) => { button.disabled = false; });
          resolve({ approved: false, path: request.path, error: e.message || String(e) });
        }
      };
      modal.querySelector('.wd-approve').onclick = () => finish(true);
      modal.querySelector('.wd-deny').onclick = () => finish(false);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(false);
      });
    });
  }

  // 将工具定义注入现有页面，不需要改动主聊天页面的 CHAT_TOOLS 常量。
  const WORKDIR_TOOL = {
    type: 'function',
    function: {
      name: 'add_working_directory',
      description: '请求将 AI 项目的工作目录添加并切换到指定的绝对路径。此操作需要网页用户明确批准；如果用户拒绝，必须继续使用当前工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '运行 Chat 服务的机器上的工作目录绝对路径，例如 /home/user/project 或 D:\\projects\\demo' }
        },
        required: ['path']
      }
    }
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      if ((url === '/api/chat' || url === '/api/revise') && options?.body && typeof options.body === 'string') {
        const payload = JSON.parse(options.body);
        const tools = Array.isArray(payload.tools) ? payload.tools.slice() : [];
        if (!tools.some((tool) => tool?.function?.name === WORKDIR_TOOL.function.name)) tools.push(WORKDIR_TOOL);
        payload.tools = tools;
        options = { ...options, body: JSON.stringify(payload) };
      }
    } catch (_) {}
    return nativeFetch(input, options);
  };

  // executeTool 定义在 index.html 中；保存原实现后只接管新增工具。
  const originalExecuteTool = window.executeTool;
  window.executeTool = async function (call) {
    if (call?.name === 'add_working_directory') {
      const requestedPath = String(call.arguments?.path || '').trim();
      if (!requestedPath) return '用户拒绝：工作目录路径为空。';
      const result = await requestWorkingDirectoryApproval(requestedPath);
      if (result.approved) {
        return `用户已批准添加并切换工作目录：${result.path}`;
      }
      return result.error
        ? `用户未批准添加工作目录 ${result.path || requestedPath}：${result.error}`
        : `用户已否决添加工作目录：${result.path || requestedPath}`;
    }
    if (typeof originalExecuteTool === 'function') return originalExecuteTool(call);
    return '未知工具: ' + (call?.name || '');
  };

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
