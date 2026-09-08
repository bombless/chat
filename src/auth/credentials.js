const keytar = require('keytar');

const SERVICE = __dirname;

async function getCredentials() {
  const [url, key, model, modelsUrl] = await Promise.all([
    keytar.getPassword(SERVICE, 'URL'),
    keytar.getPassword(SERVICE, 'KEY'),
    keytar.getPassword(SERVICE, 'MODEL'),
    keytar.getPassword(SERVICE, 'MODELS_URL'),
  ]);
  return { url, key, model, modelsUrl };
}

async function getCredential(name) { return keytar.getPassword(SERVICE, name); }
async function setCredential(name, value) { return keytar.setPassword(SERVICE, name, value); }
async function deleteCredential(name) { return keytar.deletePassword(SERVICE, name); }

module.exports = { getCredentials, getCredential, setCredential, deleteCredential };
