(function () {
    'use strict';

    function config() {
        try { return JSON.parse(window.ChatApp?.getConfig?.() || '{}'); } catch (_) { return {}; }
    }
    function saveConfig(next) { window.ChatApp?.setConfig?.(JSON.stringify(next)); }

    async function showTransferDiagnostics() {
        const text = window.ChatApp?.getTransferDebugLog?.() || '此版本尚未提供应用内诊断功能。';
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.58);padding:20px;display:flex;align-items:center;box-sizing:border-box;';
        const panel = document.createElement('section');
        panel.style.cssText = 'width:100%;max-height:90vh;background:#fff;border-radius:12px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;color:#172033;';
        const title = document.createElement('strong'); title.textContent = '配置迁移诊断';
        const output = document.createElement('pre'); output.textContent = text; output.style.cssText = 'margin:0;white-space:pre-wrap;overflow:auto;flex:1;padding:12px;background:#f5f7fa;border-radius:8px;font:12px/1.5 monospace;user-select:text;';
        const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;';
        const copy = document.createElement('button'); copy.className = 'btn btn-warning'; copy.textContent = '复制日志'; copy.style.flex = '1';
        copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; } catch (_) { output.focus(); } };
        const clear = document.createElement('button'); clear.className = 'btn'; clear.textContent = '清空日志'; clear.style.flex = '1';
        clear.onclick = () => { window.ChatApp?.clearTransferDebugLog?.(); output.textContent = '诊断日志已清空。'; };
        const close = document.createElement('button'); close.className = 'btn'; close.textContent = '关闭'; close.style.flex = '1'; close.onclick = () => overlay.remove();
        actions.append(copy, clear, close); panel.append(title, output, actions); overlay.append(panel); overlay.onclick = e => { if (e.target === overlay) overlay.remove(); }; document.body.append(overlay);
    }

    async function configure() {
        const old = config();
        const url = prompt('Chat Completions URL', old.url || '');
        if (url === null) return;
        const modelsUrl = prompt('Models URL（可留空）', old.modelsUrl || '');
        if (modelsUrl === null) return;
        const apiKey = prompt('API Key', old.apiKey || '');
        if (apiKey === null) return;
        const model = prompt('默认模型', old.model || '');
        if (model === null) return;
        saveConfig({ url: url.trim(), modelsUrl: modelsUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
        location.reload();
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url || '';
        console.log('[AndroidFetch] request', (init?.method || 'GET'), url);
        // The Android UI is loaded from file://, so relative server routes
        // must be sent to the configured provider instead of file:///api/*.
        if (url === '/api/chat' || url.startsWith('/api/chat?') || url === '/api/revise' || url.startsWith('/api/revise?')) {
            const c = config();
            if (!c.url || !c.apiKey) throw new Error('Provider URL / API Key 未配置');
            input = c.url;
            init = { ...(init || {}), headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' } };
            console.log('[AndroidFetch] rewrote provider URL', input, 'apiKeyPresent', !!c.apiKey);
        }
        if (url === '/api/models' || url.startsWith('/api/models?')) {
            const c = config();
            if (!c.url || !c.apiKey) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const provider = new ChatCore.OpenAICompatibleProvider({ http: ChatCore.createFetchHttp(), url: c.url, modelsUrl: c.modelsUrl, apiKey: c.apiKey });
            const data = await provider.models('');
            const models = data?.output?.models || data?.data || [];
            return new Response(JSON.stringify({ data: models.map(m => ({ ...m, id: m.model || m.id })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        try {
            const response = await nativeFetch(input, init);
            console.log('[AndroidFetch] response', response.status, url);
            return response;
        } catch (error) {
            console.error('[AndroidFetch] failed', url, error?.name, error?.message, config());
            throw error;
        }
    };

    function addConfigButtons() {
        const kb = document.getElementById('btnKb'); if (kb) kb.style.display = 'none';
        const exportBtn = document.getElementById('btnConfigExport'); if (exportBtn) exportBtn.style.display = 'none';
        const actions = document.querySelector('.header-actions');
        if (!actions) return;

        // Keep Android configuration actions in a dedicated row. The normal
        // header is intentionally compact and may clip/overflow on phones.
        let configBar = document.getElementById('androidConfigBar');
        if (!configBar) {
            configBar = document.createElement('div');
            configBar.id = 'androidConfigBar';
            configBar.style.cssText = 'display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-color,#ddd);background:var(--bg-color,#fff);position:relative;z-index:10;box-sizing:border-box;';
            actions.parentNode.insertBefore(configBar, actions.nextSibling);
        }
        if (document.getElementById('btnConfig')) return;

        const configBtn = document.createElement('button');
        configBtn.className = 'btn btn-warning';
        configBtn.id = 'btnConfig';
        configBtn.title = '配置本地 Provider';
        configBtn.textContent = '⚙️ 配置';
        configBtn.style.cssText = 'flex:1;min-height:42px;white-space:nowrap;';
        configBtn.onclick = configure;
        configBar.appendChild(configBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'btn btn-warning';
        importBtn.id = 'btnConfigImport';
        importBtn.title = '从电脑导入 Provider 配置';
        importBtn.textContent = '📥 导入配置';
        importBtn.style.cssText = 'flex:1;min-height:42px;white-space:nowrap;';
        importBtn.onclick = () => window.ChatApp?.importConfig?.();
        configBar.appendChild(importBtn);

        const diagnosticsBtn = document.createElement('button');
        diagnosticsBtn.className = 'btn';
        diagnosticsBtn.id = 'btnConfigDiagnostics';
        diagnosticsBtn.title = '查看配置迁移诊断日志';
        diagnosticsBtn.textContent = '🧪 诊断';
        diagnosticsBtn.style.cssText = 'flex:1;min-height:42px;white-space:nowrap;';
        diagnosticsBtn.onclick = showTransferDiagnostics;
        configBar.appendChild(diagnosticsBtn);
    }

    document.addEventListener('DOMContentLoaded', addConfigButtons);
    if (document.readyState !== 'loading') addConfigButtons();
})();
