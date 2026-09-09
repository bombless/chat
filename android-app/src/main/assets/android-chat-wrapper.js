class Chat {
    constructor(opts = {}) {
        const saved = window.ChatApp ? JSON.parse(window.ChatApp.getConfig() || '{}') : {};
        const cfg = { ...saved, ...opts };
        if (!cfg.url || !cfg.apiKey) throw new Error('Android 本地模式尚未配置 Provider URL / API Key，请先配置。');
        this.core = ChatCore.createBrowserChat({
            url: cfg.url,
            modelsUrl: cfg.modelsUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            maxHistory: cfg.maxHistory ?? 200,
            headers: cfg.headers,
            system: cfg.system,
            tools: []
        });
    }
    get messages() { return this.core.messages; }
    set messages(value) { this.core.messages = value; }
    reset() { return this.core.reset(); }
    async models(name) {
        const data = await this.core.models(name || '');
        const models = data?.output?.models || data?.data || [];
        return { data: models.map(m => ({ ...m, id: m.model || m.id })) };
    }
    request(signal) { return this.core.request(signal); }
    ask(prompt, signal) { return this.core.ask(prompt, signal); }
    reportCalls(calls, signal) { return this.core.reportCalls(calls, signal); }
}

