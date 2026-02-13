const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Config paths
const CONFIG_DIR = path.join(os.homedir(), '.masterclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Secure file permissions (owner read/write only)
const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

/**
 * Set secure file permissions (owner read/write only)
 * Prevents other users from accessing sensitive configuration
 */
async function setSecureFilePermissions(filePath) {
  try {
    await fs.chmod(filePath, SECURE_FILE_MODE);
  } catch (err) {
    console.warn(`[Security] Could not set secure permissions on ${filePath}:`, err.message);
  }
}

/**
 * Set secure directory permissions (owner read/write/execute only)
 */
async function setSecureDirPermissions(dirPath) {
  try {
    await fs.chmod(dirPath, SECURE_DIR_MODE);
  } catch (err) {
    console.warn(`[Security] Could not set secure permissions on ${dirPath}:`, err.message);
  }
}

/**
 * Check if config file has secure permissions
 * Returns security audit result
 */
async function checkConfigPermissions() {
  const result = {
    secure: true,
    issues: [],
    warnings: [],
  };

  try {
    // Check config directory permissions
    if (await fs.pathExists(CONFIG_DIR)) {
      const dirStats = await fs.stat(CONFIG_DIR);
      const dirMode = dirStats.mode & 0o777;
      if (dirMode !== SECURE_DIR_MODE) {
        result.secure = false;
        result.issues.push(`Config directory has permissive permissions: ${dirMode.toString(8)} (expected ${SECURE_DIR_MODE.toString(8)})`);
      }
    }

    // Check config file permissions
    if (await fs.pathExists(CONFIG_FILE)) {
      const fileStats = await fs.stat(CONFIG_FILE);
      const fileMode = fileStats.mode & 0o777;
      if (fileMode !== SECURE_FILE_MODE) {
        result.secure = false;
        result.issues.push(`Config file has permissive permissions: ${fileMode.toString(8)} (expected ${SECURE_FILE_MODE.toString(8)})`);
      }

      // Warn if config is readable by group or others
      if (fileMode & 0o044) {
        result.warnings.push('Config file may be readable by other users');
      }
      if (fileMode & 0o022) {
        result.warnings.push('Config file may be writable by other users');
      }
    }
  } catch (err) {
    result.warnings.push(`Could not check permissions: ${err.message}`);
  }

  return result;
}

/**
 * Run a security audit on the configuration
 * Returns detailed security report
 */
async function securityAudit() {
  const audit = {
    secure: true,
    timestamp: new Date().toISOString(),
    checks: {},
    issues: [],
    recommendations: [],
  };

  // Check file permissions
  const permCheck = await checkConfigPermissions();
  audit.checks.permissions = permCheck;
  if (!permCheck.secure) {
    audit.secure = false;
    audit.issues.push(...permCheck.issues);
  }
  if (permCheck.warnings.length > 0) {
    audit.recommendations.push(...permCheck.warnings.map(w => `Warning: ${w}`));
  }

  // Check for sensitive values in config
  try {
    const config = await loadConfig();
    const sensitiveKeys = ['token', 'api_key', 'apikey', 'password', 'secret'];
    const configStr = JSON.stringify(config).toLowerCase();
    
    for (const key of sensitiveKeys) {
      if (configStr.includes(key)) {
        audit.checks.hasSensitiveData = true;
        break;
      }
    }
    
    if (audit.checks.hasSensitiveData && !permCheck.secure) {
      audit.recommendations.push('Config contains sensitive data but file permissions are not secure. Run: mc config fix-permissions');
    }
  } catch (err) {
    audit.warnings = audit.warnings || [];
    audit.warnings.push(`Could not check config contents: ${err.message}`);
  }

  return audit;
}

/**
 * Fix config file and directory permissions to be secure
 */
async function fixPermissions() {
  const results = [];

  try {
    if (await fs.pathExists(CONFIG_DIR)) {
      await setSecureDirPermissions(CONFIG_DIR);
      results.push({ path: CONFIG_DIR, status: 'fixed', mode: SECURE_DIR_MODE.toString(8) });
    }

    if (await fs.pathExists(CONFIG_FILE)) {
      await setSecureFilePermissions(CONFIG_FILE);
      results.push({ path: CONFIG_FILE, status: 'fixed', mode: SECURE_FILE_MODE.toString(8) });
    }

    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

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

// Ensure config directory exists with secure permissions
async function ensureConfigDir() {
  await fs.ensureDir(CONFIG_DIR);
  // Always ensure secure permissions on config directory
  await setSecureDirPermissions(CONFIG_DIR);
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

// Save config with secure permissions
async function saveConfig(config) {
  await ensureConfigDir();
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
  // Ensure config file has secure permissions (owner read/write only)
  await setSecureFilePermissions(CONFIG_FILE);
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
  securityAudit,
  fixPermissions,
  checkConfigPermissions,
};
