const chalk = require('chalk');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// Service configuration
const SERVICES = {
  interface: { port: 3000, name: 'Interface', url: 'http://localhost:3000' },
  backend: { port: 3001, name: 'Backend API', url: 'http://localhost:3001' },
  core: { port: 8000, name: 'AI Core', url: 'http://localhost:8000' },
  gateway: { port: 3000, name: 'Gateway', url: 'http://localhost:3000' },
};

// Check if a service is running
async function checkService(name, config) {
  try {
    const response = await axios.get(`${config.url}/health`, { 
      timeout: 3000,
      validateStatus: () => true
    });
    return {
      name: config.name,
      status: response.status === 200 ? 'healthy' : 'unhealthy',
      port: config.port,
      url: config.url,
      responseTime: response.headers['x-response-time'] || 'unknown',
    };
  } catch (error) {
    return {
      name: config.name,
      status: 'down',
      port: config.port,
      url: config.url,
      error: error.code,
    };
  }
}

// Check Docker containers
async function checkDockerContainers() {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['ps', '--format', '{{.Names}}|{{.Status}}']);
    let output = '';
    
    docker.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    docker.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      
      const containers = output.trim().split('\n').map(line => {
        const [name, status] = line.split('|');
        return { name, status };
      }).filter(c => c.name && c.name.startsWith('mc-'));
      
      resolve(containers);
    });
  });
}

// Get all service statuses
async function getAllStatuses() {
  const results = [];
  
  for (const [key, config] of Object.entries(SERVICES)) {
    const status = await checkService(key, config);
    results.push(status);
  }
  
  return results;
}

// Run Docker Compose command
async function runDockerCompose(args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const compose = spawn('docker-compose', args, { 
      cwd,
      stdio: 'pipe'
    });
    
    let stdout = '';
    let stderr = '';
    
    compose.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    compose.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    compose.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Docker Compose failed: ${stderr || stdout}`));
      }
    });
  });
}

// Find infrastructure directory
async function findInfraDir() {
  const possiblePaths = [
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '../masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];
  
  for (const dir of possiblePaths) {
    if (await fs.pathExists(path.join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }
  
  return null;
}

module.exports = {
  SERVICES,
  checkService,
  checkDockerContainers,
  getAllStatuses,
  runDockerCompose,
  findInfraDir,
  chalk,
  axios,
};
