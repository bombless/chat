(() => {
  const TOOL_PANEL_ID = '__tools_panel';
  const TOOL_BUTTON_ID = '__tools_button';
  const TOOL_STYLE_ID = '__tools_style';
  const tools = new Map();

  function esc(value) {
    return String(value ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[c]);
  }
  function normalizeTool(tool) {
    const fn = tool?.function || tool;
    if (!fn?.name) return null;
    return { name: fn.name, description: fn.description || '无描述', parameters: fn.parameters || null };
  }
  function collectTools(list) {
    tools.clear();
    if (Array.isArray(list)) list.forEach((tool) => { const normalized = normalizeTool(tool); if (normalized) tools.set(normalized.name, normalized); });
    renderTools();
  }
  function parameterText(parameters) {
    const props = parameters?.properties || {}; const required = new Set(parameters?.required || []); const entries = Object.entries(props);
    if (!entries.length) return '无参数';
    return entries.map(([name, schema]) => `${name}${required.has(name) ? ' *' : ''}: ${schema?.type || 'any'}`).join(' · ');
  }
  function installStyle() {
    if (document.getElementById(TOOL_STYLE_ID)) return;
    const style = document.createElement('style'); style.id = TOOL_STYLE_ID;
    style.textContent = `
      #${TOOL_BUTTON_ID} { padding:7px 11px; border:1px solid #2a4a6a; border-radius:10px; background:#16213e; color:#dce6f5; cursor:pointer; font-size:12px; white-space:nowrap; }
      #${TOOL_BUTTON_ID}:hover { background:#21364a; }
      #${TOOL_PANEL_ID} { position:fixed; inset:0; z-index:9998; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.68); }
      #${TOOL_PANEL_ID}.open { display:flex; }
      #${TOOL_PANEL_ID} .tools-dialog { width:min(720px,calc(100vw - 32px)); max-height:min(720px,calc(100vh - 48px)); overflow:hidden; display:flex; flex-direction:column; background:#16213e; border:1px solid #2a4a6a; border-radius:14px; box-shadow:0 20px 70px rgba(0,0,0,.7); }
      #${TOOL_PANEL_ID} .tools-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:17px 20px; border-bottom:1px solid #2a3a5a; }
      #${TOOL_PANEL_ID} h3 { margin:0; font-size:17px; }
      #${TOOL_PANEL_ID} .tools-count { color:#8899bb; font-size:12px; margin-left:7px; }
      #${TOOL_PANEL_ID} .tools-close { border:0; border-radius:8px; padding:6px 10px; background:#2a3a5a; color:#e0e0e0; cursor:pointer; }
      #${TOOL_PANEL_ID} .tools-list { padding:14px; overflow:auto; display:flex; flex-direction:column; gap:9px; }
      #${TOOL_PANEL_ID} .tool-card { padding:12px 14px; border:1px solid #2a3a5a; border-radius:10px; background:#1a2a3a; }
      #${TOOL_PANEL_ID} .tool-name { font-family:monospace; color:#e5edf8; font-size:13px; font-weight:600; }
      #${TOOL_PANEL_ID} .tool-desc { margin-top:6px; color:#aab7cc; font-size:12px; line-height:1.55; }
      #${TOOL_PANEL_ID} .tool-params { margin-top:7px; color:#7185a4; font-size:11px; font-family:monospace; }
      #${TOOL_PANEL_ID} .tools-empty { padding:28px 18px; color:#8899bb; text-align:center; font-size:13px; line-height:1.6; }
    `;
    document.head.appendChild(style);
  }
  function renderTools() {
    const list = document.querySelector(`#${TOOL_PANEL_ID} .tools-list`); const count = document.querySelector(`#${TOOL_PANEL_ID} .tools-count`); if (!list) return;
    const values = Array.from(tools.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (count) count.textContent = `${values.length} 个`;
    if (!values.length) { list.innerHTML = '<div class="tools-empty">当前没有可用工具定义。</div>'; return; }
    list.innerHTML = values.map((tool) => `<div class="tool-card"><div class="tool-name">${esc(tool.name)}</div><div class="tool-desc">${esc(tool.description)}</div><div class="tool-params">参数：${esc(parameterText(tool.parameters))}</div></div>`).join('');
  }
  async function loadTools() {
    try { const response = await fetch('/api/chat-tools', { headers: { 'Content-Type': 'application/json' } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `请求失败: ${response.status}`); collectTools(data.tools); }
    catch (e) { console.error('加载工具定义失败:', e); }
  }
  function createUI() {
    installStyle();
    if (document.getElementById(TOOL_PANEL_ID)) return;
    const headerActions = document.querySelector('.header-actions'); if (!headerActions) return;
    const button = document.createElement('button'); button.id = TOOL_BUTTON_ID; button.textContent = '🧰 工具'; headerActions.insertBefore(button, headerActions.firstChild);
    const panel = document.createElement('div'); panel.id = TOOL_PANEL_ID; panel.innerHTML = `<div class="tools-dialog"><div class="tools-head"><div><h3>当前可用工具 <span class="tools-count">0 个</span></h3></div><button class="tools-close">关闭</button></div><div class="tools-list"></div></div>`; document.body.appendChild(panel);
    button.onclick = async () => { await loadTools(); renderTools(); panel.classList.add('open'); };
    panel.querySelector('.tools-close').onclick = () => panel.classList.remove('open'); panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); }); renderTools();
  }
  function boot() { createUI(); loadTools(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
