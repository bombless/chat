(function () {
    'use strict';

    function config() {
        try { return JSON.parse(window.ChatApp?.getConfig?.() || '{}'); } catch (_) { return {}; }
    }

    function saveConfig(next) {
        window.ChatApp?.setConfig?.(JSON.stringify(next));
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
        if (url === '/api/models' || url.startsWith('/api/models?')) {
            const c = config();
            if (!c.url || !c.apiKey) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const provider = new ChatCore.OpenAICompatibleProvider({
                http: ChatCore.createFetchHttp(), url: c.url, modelsUrl: c.modelsUrl, apiKey: c.apiKey
            });
            const data = await provider.models('');
            const models = data?.output?.models || data?.data || [];
            return new Response(JSON.stringify({ data: models.map(m => ({ ...m, id: m.model || m.id })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return nativeFetch(input, init);
    };

    function addConfigButton() {
        const kb = document.getElementById('btnKb'); if (kb) kb.style.display = 'none';\n        const actions = document.querySelector('.header-actions');
        if (!actions || document.getElementById('btnConfig')) return;
        const btn = document.createElement('button');
        btn.className = 'btn btn-warning';
        btn.id = 'btnConfig';
        btn.title = '配置本地 Provider';
        btn.textContent = '⚙️ 配置';
        btn.onclick = configure;
        actions.insertBefore(btn, actions.firstChild);
    }

    document.addEventListener('DOMContentLoaded', addConfigButton);
    if (document.readyState !== 'loading') addConfigButton();
})();

