(function () {
    'use strict';

    function config() {
        try { return JSON.parse(window.ChatApp?.getConfig?.() || '{}'); } catch (_) { return {}; }
    }
    function saveConfig(next) { window.ChatApp?.setConfig?.(JSON.stringify(next)); }

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
        if (url === '/api/models' || url.startsWith('/api/models?')) {
            const c = config();
            if (!c.url || !c.apiKey) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const provider = new ChatCore.OpenAICompatibleProvider({ http: ChatCore.createFetchHttp(), url: c.url, modelsUrl: c.modelsUrl, apiKey: c.apiKey });
            const data = await provider.models('');
            const models = data?.output?.models || data?.data || [];
            return new Response(JSON.stringify({ data: models.map(m => ({ ...m, id: m.model || m.id })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return nativeFetch(input, init);
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
    }

    document.addEventListener('DOMContentLoaded', addConfigButtons);
    if (document.readyState !== 'loading') addConfigButtons();
})();
