// Runtime-neutral configuration normalization.
// Secrets and environment access belong to the host adapter.
function createConfig (input = {}) {
  return Object.freeze({
    url: input.url,
    modelsUrl: input.modelsUrl,
    apiKey: input.apiKey,
    model: input.model,
    maxHistory: input.maxHistory ?? 200,
    headers: { ...(input.headers || {}) }
  })
}

module.exports = { createConfig }
