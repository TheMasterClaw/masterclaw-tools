const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');

// Import for security validation
const { validateWorkingDirectory } = require('./docker');

// =============================================================================
// Security Constants
// =============================================================================

/** Dangerous environment variable keys that could enable prototype pollution */
const DANGEROUS_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Maximum .env file size to prevent DoS (1MB) */
const MAX_ENV_FILE_SIZE = 1024 * 1024;

/** Maximum number of lines in .env file to prevent DoS */
const MAX_ENV_FILE_LINES = 10000;

// Required environment variables for production deployment
const REQUIRED_ENV_VARS = [
  'DOMAIN',
  'ACME_EMAIL',
  'GATEWAY_TOKEN',
];

// Optional but recommended environment variables
const RECOMMENDED_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

// Required ports for MasterClaw services
const REQUIRED_PORTS = [80, 443];

// Optional ports that may be used in development
const OPTIONAL_PORTS = [3000, 3001, 8000, 9090, 3003];

/**
 * Validation error types
 */
const ValidationErrorType = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * Check if a port is available
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} - True if port is available
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    
    server.listen(port);
  });
}

/**
 * Check if Docker is installed and running
 * @returns {Promise<Object>} - Docker status
 */
async function checkDocker() {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['version', '--format', '{{.Server.Version}}']);
    let version = '';
    let error = '';
    
    docker.stdout.on('data', (data) => {
      version += data.toString().trim();
    });
    
    docker.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    docker.on('close', (code) => {
      if (code === 0 && version) {
        resolve({
          installed: true,
          running: true,
          version: version,
        });
      } else {
        resolve({
          installed: error.includes('command not found') ? false : true,
          running: false,
          version: null,
          error: error || 'Docker daemon not running',
        });
      }
    });
    
    docker.on('error', () => {
      resolve({
        installed: false,
        running: false,
        version: null,
        error: 'Docker not installed',
      });
    });
  });
}

/**
 * Check if Docker Compose is installed
 * @returns {Promise<Object>} - Docker Compose status
 */
async function checkDockerCompose() {
  return new Promise((resolve) => {
    const compose = spawn('docker-compose', ['version', '--short']);
    let version = '';
    
    compose.stdout.on('data', (data) => {
      version += data.toString().trim();
    });
    
    compose.on('close', (code) => {
      if (code === 0 && version) {
        resolve({
          installed: true,
          version: version,
        });
      } else {
        resolve({
          installed: false,
          version: null,
        });
      }
    });
    
    compose.on('error', () => {
      resolve({
        installed: false,
        version: null,
      });
    });
  });
}

/**
 * Checks if an environment variable key is dangerous (could enable prototype pollution)
 * @param {string} key - Key to check
 * @returns {boolean} - True if key is dangerous
 */
function isDangerousEnvKey(key) {
  return DANGEROUS_ENV_KEYS.has(key);
}

/**
 * Parse .env file and return key-value pairs with prototype pollution protection
 * Security: Skips dangerous keys (__proto__, constructor, prototype)
 * Security: Limits file size and line count to prevent DoS
 * @param {string} envPath - Path to .env file
 * @returns {Promise<Object>} - Environment variables
 * @throws {Error} - If file exceeds size limits or contains too many lines
 */
async function parseEnvFile(envPath) {
  // Create a prototype-pollution-safe object with null prototype
  const vars = Object.create(null);
  
  if (!await fs.pathExists(envPath)) {
    return vars;
  }

  // Security: Check file size to prevent DoS
  const stats = await fs.stat(envPath);
  if (stats.size > MAX_ENV_FILE_SIZE) {
    throw new Error(
      `Env file size (${stats.size} bytes) exceeds maximum allowed (${MAX_ENV_FILE_SIZE} bytes)`
    );
  }
  
  const content = await fs.readFile(envPath, 'utf8');
  const lines = content.split('\n');
  
  // Security: Check line count to prevent DoS
  if (lines.length > MAX_ENV_FILE_LINES) {
    throw new Error(
      `Env file line count (${lines.length}) exceeds maximum allowed (${MAX_ENV_FILE_LINES})`
    );
  }
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Parse KEY=VALUE format
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      
      // Security: Skip dangerous keys that could pollute prototype
      if (isDangerousEnvKey(key)) {
        console.warn(chalk.yellow(`[Security] Skipping dangerous env key: ${key}`));
        continue;
      }
      
      // Remove quotes if present
      vars[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  
  return vars;
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate domain format
 * @param {string} domain - Domain to validate
 * @returns {boolean} - True if valid
 */
function isValidDomain(domain) {
  // Allow localhost for development
  if (domain === 'localhost') {
    return true;
  }
  
  // Basic domain validation
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
  return domainRegex.test(domain);
}

/**
 * Validate a token/password strength
 * @param {string} token - Token to validate
 * @returns {Object} - Validation result
 */
function validateTokenStrength(token) {
  if (!token || token.length < 16) {
    return {
      valid: false,
      strength: 'weak',
      message: 'Token should be at least 16 characters',
    };
  }
  
  if (token.length >= 32 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) {
    return {
      valid: true,
      strength: 'strong',
      message: 'Token strength is good',
    };
  }
  
  return {
    valid: true,
    strength: 'medium',
    message: 'Consider using a longer token with mixed case and numbers',
  };
}

/**
 * Check system resources
 * @returns {Promise<Object>} - Resource status
 */
async function checkSystemResources() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = (usedMem / totalMem) * 100;
  
  // Check disk space (Linux/Mac only)
  let diskInfo = null;
  try {
    const { stdout } = await require('util').promisify(require('child_process').exec)('df -h . | tail -1');
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 5) {
      diskInfo = {
        usage: parts[4],
        available: parts[3],
      };
    }
  } catch {
    // Ignore disk check errors
  }
  
  return {
    totalMemoryGB: (totalMem / 1024 / 1024 / 1024).toFixed(2),
    freeMemoryGB: (freeMem / 1024 / 1024 / 1024).toFixed(2),
    memoryUsagePercent: memUsagePercent.toFixed(1),
    diskInfo,
  };
}

/**
 * Run complete environment validation
 * @param {Object} options - Validation options
 * @returns {Promise<Object>} - Validation results
 */
async function validate(options = {}) {
  const results = {
    passed: true,
    errors: [],
    warnings: [],
    info: [],
    checks: {},
  };
  
  const infraDir = options.infraDir || process.cwd();
  
  // Validate working directory
  try {
    validateWorkingDirectory(infraDir);
  } catch (err) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: `Invalid infrastructure directory: ${err.message}`,
    });
    return results;
  }
  
  // Check Docker
  results.checks.docker = await checkDocker();
  if (!results.checks.docker.installed) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: 'Docker is not installed. Install from https://docs.docker.com/get-docker/',
    });
  } else if (!results.checks.docker.running) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: 'Docker daemon is not running. Start Docker Desktop or run: sudo systemctl start docker',
    });
  } else {
    results.info.push({
      type: ValidationErrorType.INFO,
      message: `Docker version: ${results.checks.docker.version}`,
    });
  }
  
  // Check Docker Compose
  results.checks.dockerCompose = await checkDockerCompose();
  if (!results.checks.dockerCompose.installed) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: 'Docker Compose is not installed',
    });
  } else {
    results.info.push({
      type: ValidationErrorType.INFO,
      message: `Docker Compose version: ${results.checks.dockerCompose.version}`,
    });
  }
  
  // Check .env file
  const envPath = path.join(infraDir, '.env');
  const envExamplePath = path.join(infraDir, '.env.example');
  
  if (!await fs.pathExists(envPath)) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: `.env file not found at ${envPath}`,
    });
    
    if (await fs.pathExists(envExamplePath)) {
      results.info.push({
        type: ValidationErrorType.INFO,
        message: 'Found .env.example - copy it to .env and configure: cp .env.example .env',
      });
    }
  } else {
    // Parse and validate .env contents
    const envVars = await parseEnvFile(envPath);
    results.checks.envVars = envVars;
    
    // Check required variables
    for (const varName of REQUIRED_ENV_VARS) {
      if (!envVars[varName] || envVars[varName].trim() === '') {
        results.passed = false;
        results.errors.push({
          type: ValidationErrorType.CRITICAL,
          message: `Required environment variable missing: ${varName}`,
        });
      }
    }
    
    // Check recommended variables
    for (const varName of RECOMMENDED_ENV_VARS) {
      if (!envVars[varName] || envVars[varName].trim() === '') {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `Recommended environment variable missing: ${varName} (needed for AI features)`,
        });
      }
    }
    
    // Validate DOMAIN format
    if (envVars.DOMAIN) {
      if (!isValidDomain(envVars.DOMAIN)) {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `DOMAIN '${envVars.DOMAIN}' may not be a valid domain format`,
        });
      } else if (envVars.DOMAIN === 'localhost' && !options.dev) {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: 'DOMAIN is set to "localhost" - SSL certificates will not work in production',
        });
      }
    }
    
    // Validate ACME_EMAIL format
    if (envVars.ACME_EMAIL) {
      if (!isValidEmail(envVars.ACME_EMAIL)) {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `ACME_EMAIL '${envVars.ACME_EMAIL}' is not a valid email format`,
        });
      }
    }
    
    // Validate GATEWAY_TOKEN strength
    if (envVars.GATEWAY_TOKEN) {
      const tokenValidation = validateTokenStrength(envVars.GATEWAY_TOKEN);
      if (tokenValidation.strength === 'weak') {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `GATEWAY_TOKEN is too short (${envVars.GATEWAY_TOKEN.length} chars). ${tokenValidation.message}`,
        });
      }
    }
    
    // Check for example/default values
    const exampleValues = ['your-domain.com', 'admin@example.com', 'your-token-here', 'changeme'];
    for (const [key, value] of Object.entries(envVars)) {
      if (exampleValues.some(ex => value.toLowerCase().includes(ex.toLowerCase()))) {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `${key} appears to contain a placeholder value: "${value}"`,
        });
      }
    }
  }
  
  // Check for docker-compose.yml
  const composePath = path.join(infraDir, 'docker-compose.yml');
  if (!await fs.pathExists(composePath)) {
    results.passed = false;
    results.errors.push({
      type: ValidationErrorType.CRITICAL,
      message: `docker-compose.yml not found at ${composePath}`,
    });
  }
  
  // Check ports (only if not in dev mode with custom ports)
  if (!options.skipPorts) {
    for (const port of REQUIRED_PORTS) {
      const available = await isPortAvailable(port);
      if (!available) {
        results.warnings.push({
          type: ValidationErrorType.WARNING,
          message: `Port ${port} is already in use. This may conflict with MasterClaw services.`,
        });
      }
    }
  }
  
  // Check system resources
  results.checks.resources = await checkSystemResources();
  const minMemoryGB = 4;
  if (parseFloat(results.checks.resources.freeMemoryGB) < minMemoryGB) {
    results.warnings.push({
      type: ValidationErrorType.WARNING,
      message: `Free memory (${results.checks.resources.freeMemoryGB}GB) is low. Recommended: at least ${minMemoryGB}GB free`,
    });
  }
  
  // Check for data directory permissions
  const dataDir = path.join(infraDir, 'data');
  try {
    await fs.ensureDir(dataDir);
    const testFile = path.join(dataDir, '.write-test');
    await fs.writeFile(testFile, '');
    await fs.remove(testFile);
  } catch (err) {
    results.warnings.push({
      type: ValidationErrorType.WARNING,
      message: `Data directory ${dataDir} is not writable: ${err.message}`,
    });
  }
  
  return results;
}

/**
 * Print validation results
 * @param {Object} results - Validation results
 * @param {Object} options - Print options
 */
function printResults(results, options = {}) {
  console.log(chalk.blue('🐾 MasterClaw Environment Validation\n'));
  
  // Print errors
  if (results.errors.length > 0) {
    console.log(chalk.red('❌ Critical Issues:'));
    results.errors.forEach((err, i) => {
      console.log(`   ${i + 1}. ${err.message}`);
    });
    console.log('');
  }
  
  // Print warnings
  if (results.warnings.length > 0) {
    console.log(chalk.yellow('⚠️  Warnings:'));
    results.warnings.forEach((warn, i) => {
      console.log(`   ${i + 1}. ${warn.message}`);
    });
    console.log('');
  }
  
  // Print info
  if (results.info.length > 0 && !options.quiet) {
    console.log(chalk.cyan('ℹ️  Info:'));
    results.info.forEach((info, i) => {
      console.log(`   ${i + 1}. ${info.message}`);
    });
    console.log('');
  }
  
  // Print resource summary
  if (results.checks.resources && !options.quiet) {
    console.log(chalk.gray('System Resources:'));
    console.log(`   Memory: ${results.checks.resources.freeMemoryGB}GB free / ${results.checks.resources.totalMemoryGB}GB total (${results.checks.resources.memoryUsagePercent}% used)`);
    if (results.checks.resources.diskInfo) {
      console.log(`   Disk: ${results.checks.resources.diskInfo.usage} used, ${results.checks.resources.diskInfo.available} available`);
    }
    console.log('');
  }
  
  // Final status
  if (results.passed) {
    console.log(chalk.green('✅ Validation passed! Ready for deployment.'));
    if (results.warnings.length > 0) {
      console.log(chalk.yellow('   Note: Address warnings for optimal performance.'));
    }
  } else {
    console.log(chalk.red('❌ Validation failed. Fix critical issues before deploying.'));
    console.log(chalk.gray('\nRun "mc validate --fix-suggestions" for remediation steps.'));
  }
}

/**
 * Get remediation steps for common issues
 * @returns {string} - Remediation guide
 */
function getRemediationSteps() {
  return `
${chalk.blue('🔧 Remediation Steps')}

${chalk.cyan('Docker not installed:')}
   Ubuntu/Debian:  sudo apt-get install docker.io docker-compose
   macOS:          brew install docker docker-compose
   Windows:        https://docs.docker.com/desktop/install/windows/

${chalk.cyan('Docker daemon not running:')}
   Linux:          sudo systemctl start docker
   macOS/Windows:  Start Docker Desktop application

${chalk.cyan('.env file missing:')}
   cp .env.example .env
   # Edit .env with your configuration

${chalk.cyan('Port conflicts:')}
   sudo lsof -i :80    # Find process using port 80
   sudo lsof -i :443   # Find process using port 443
   # Stop conflicting services or change MasterClaw ports in docker-compose.yml

${chalk.cyan('Low memory:')}
   - Close unnecessary applications
   - Increase swap space: sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   - Upgrade server memory

${chalk.cyan('Weak GATEWAY_TOKEN:')}
   # Generate a strong token:
   openssl rand -hex 32
`;
}

module.exports = {
  validate,
  printResults,
  getRemediationSteps,
  ValidationErrorType,
  isPortAvailable,
  checkDocker,
  checkDockerCompose,
  parseEnvFile,
  isValidEmail,
  isValidDomain,
  validateTokenStrength,
  checkSystemResources,
  REQUIRED_ENV_VARS,
  RECOMMENDED_ENV_VARS,
  REQUIRED_PORTS,
  // Security exports
  DANGEROUS_ENV_KEYS,
  MAX_ENV_FILE_SIZE,
  MAX_ENV_FILE_LINES,
  isDangerousEnvKey,
};
