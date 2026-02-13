const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Config paths
const CONFIG_DIR = path.join(os.homedir(), '.masterclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Default config
const DEFAULT_CONFIG = {
  infraDir: null,
  gateway: {
    url: 'http://localhost:3000',
    token: null,
  },
  api: {
    url: 'http://localhost:3001',
  },
  core: {
    url: 'http://localhost:8000',
  },
  defaults: {
    backupRetention: 7,
    autoUpdate: true,
  },
};

// Ensure config directory exists
async function ensureConfigDir() {
  await fs.ensureDir(CONFIG_DIR);
}

// Load config
async function loadConfig() {
  await ensureConfigDir();
  
  if (await fs.pathExists(CONFIG_FILE)) {
    const config = await fs.readJson(CONFIG_FILE);
    return { ...DEFAULT_CONFIG, ...config };
  }
  
  return DEFAULT_CONFIG;
}

// Save config
async function saveConfig(config) {
  await ensureConfigDir();
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
}

// Get a config value
async function get(key) {
  const config = await loadConfig();
  const keys = key.split('.');
  let value = config;
  
  for (const k of keys) {
    if (value && typeof value === 'object') {
      value = value[k];
    } else {
      return undefined;
    }
  }
  
  return value;
}

// Set a config value
async function set(key, value) {
  const config = await loadConfig();
  const keys = key.split('.');
  let target = config;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!target[k] || typeof target[k] !== 'object') {
      target[k] = {};
    }
    target = target[k];
  }
  
  target[keys[keys.length - 1]] = value;
  await saveConfig(config);
  return true;
}

// List all config
async function list() {
  return await loadConfig();
}

// Reset config
async function reset() {
  await saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  get,
  set,
  list,
  reset,
};
