const { spawn } = require('child_process');
const path = require('path');

// Check if Docker is available
async function isDockerAvailable() {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['--version']);
    docker.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

// Check if Docker Compose is available
async function isComposeAvailable() {
  return new Promise((resolve) => {
    const compose = spawn('docker-compose', ['--version']);
    compose.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

// Run Docker Compose
async function compose(args, options = {}) {
  const { cwd, verbose = false } = options;
  
  return new Promise((resolve, reject) => {
    const composeCmd = spawn('docker-compose', args, {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
    });
    
    let stdout = '';
    let stderr = '';
    
    if (!verbose) {
      composeCmd.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      composeCmd.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }
    
    composeCmd.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr || stdout || `Docker Compose exited with code ${code}`));
      }
    });
  });
}

// Get container logs
async function logs(containerName, options = {}) {
  const { follow = false, tail = 100 } = options;
  
  const args = ['logs'];
  if (follow) args.push('-f');
  if (tail) args.push('--tail', tail.toString());
  args.push(containerName);
  
  return new Promise((resolve, reject) => {
    const logsCmd = spawn('docker', args, {
      stdio: follow ? 'inherit' : 'pipe',
    });
    
    if (follow) {
      // For follow mode, we don't resolve - just let it run
      return;
    }
    
    let output = '';
    logsCmd.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    logsCmd.stderr.on('data', (data) => {
      output += data.toString();
    });
    
    logsCmd.on('close', () => {
      resolve(output);
    });
  });
}

// Restart services
async function restart(services = [], options = {}) {
  const { cwd } = options;
  const args = ['restart'];
  if (services.length > 0) {
    args.push(...services);
  }
  return compose(args, { cwd });
}

// Pull latest images
async function pull(options = {}) {
  const { cwd } = options;
  return compose(['pull'], { cwd });
}

// Get service status
async function ps(options = {}) {
  const { cwd } = options;
  return compose(['ps'], { cwd });
}

module.exports = {
  isDockerAvailable,
  isComposeAvailable,
  compose,
  logs,
  restart,
  pull,
  ps,
};
