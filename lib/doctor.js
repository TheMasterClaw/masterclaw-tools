/**
 * MasterClaw Doctor - Comprehensive diagnostic and troubleshooting tool
 * 
 * Runs a full system health check covering:
 * - System resources (disk, memory, CPU)
 * - Docker environment
 * - MasterClaw services health
 * - Configuration validation
 * - Network connectivity
 * - Security checks
 * - Common issue detection with auto-fix suggestions
 */

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const net = require('net');

const { findInfraDir } = require('./services');
const config = require('./config');
const { validateWorkingDirectory } = require('./docker');

// =============================================================================
// Diagnostic Categories
// =============================================================================

const CATEGORIES = {
  SYSTEM: 'system',
  DOCKER: 'docker',
  SERVICES: 'services',
  CONFIG: 'config',
  NETWORK: 'network',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
};

// =============================================================================
// Issue Severity Levels
// =============================================================================

const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

// =============================================================================
// Doctor Class
// =============================================================================

class MasterClawDoctor {
  constructor(options = {}) {
    this.options = {
      verbose: options.verbose || false,
      fix: options.fix || false,
      category: options.category || null,
      json: options.json || false,
    };
    this.issues = [];
    this.checks = [];
    this.startTime = Date.now();
  }

  /**
   * Add an issue to the report
   */
  addIssue(category, severity, title, description, fix = null) {
    this.issues.push({
      category,
      severity,
      title,
      description,
      fix,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Add a check result
   */
  addCheck(category, name, passed, details = '') {
    this.checks.push({
      category,
      name,
      passed,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Run all diagnostics
   */
  async run() {
    const categories = this.options.category 
      ? [this.options.category]
      : Object.values(CATEGORIES);

    for (const category of categories) {
      switch (category) {
        case CATEGORIES.SYSTEM:
          await this.checkSystem();
          break;
        case CATEGORIES.DOCKER:
          await this.checkDocker();
          break;
        case CATEGORIES.SERVICES:
          await this.checkServices();
          break;
        case CATEGORIES.CONFIG:
          await this.checkConfig();
          break;
        case CATEGORIES.NETWORK:
          await this.checkNetwork();
          break;
        case CATEGORIES.SECURITY:
          await this.checkSecurity();
          break;
        case CATEGORIES.PERFORMANCE:
          await this.checkPerformance();
          break;
      }
    }

    return this.generateReport();
  }

  // ===========================================================================
  // System Checks
  // ===========================================================================

  async checkSystem() {
    this.addCheck(CATEGORIES.SYSTEM, 'Starting system checks', true);

    // Disk space check
    try {
      const diskInfo = await this.getDiskSpace();
      const freePercent = (diskInfo.free / diskInfo.total) * 100;
      
      if (freePercent < 5) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.CRITICAL,
          ' critically low disk space',
          `Only ${freePercent.toFixed(1)}% disk space remaining (${this.formatBytes(diskInfo.free)} free)`,
          'Free up disk space immediately: mc logs clean, docker system prune'
        );
      } else if (freePercent < 15) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.HIGH,
          'Low disk space',
          `Only ${freePercent.toFixed(1)}% disk space remaining (${this.formatBytes(diskInfo.free)} free)`,
          'Consider cleaning up: mc logs clean, docker system prune'
        );
      }
      
      this.addCheck(CATEGORIES.SYSTEM, 'Disk space', true, `${freePercent.toFixed(1)}% free`);
    } catch (err) {
      this.addCheck(CATEGORIES.SYSTEM, 'Disk space', false, err.message);
    }

    // Memory check
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
      
      if (usedPercent > 95) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.CRITICAL,
          ' critically high memory usage',
          `System memory usage is at ${usedPercent.toFixed(1)}%`,
          'Close unnecessary applications or upgrade RAM'
        );
      } else if (usedPercent > 85) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.HIGH,
          'High memory usage',
          `System memory usage is at ${usedPercent.toFixed(1)}%`,
          'Consider restarting services or reducing workload'
        );
      }
      
      this.addCheck(CATEGORIES.SYSTEM, 'Memory usage', true, `${usedPercent.toFixed(1)}% used`);
    } catch (err) {
      this.addCheck(CATEGORIES.SYSTEM, 'Memory usage', false, err.message);
    }

    // Load average check
    try {
      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      const loadPercent = (loadAvg[0] / cpuCount) * 100;
      
      if (loadPercent > 90) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.HIGH,
          'High CPU load',
          `System load average is ${loadAvg[0].toFixed(2)} (${loadPercent.toFixed(0)}% per CPU)`,
          'Reduce workload or upgrade CPU'
        );
      }
      
      this.addCheck(CATEGORIES.SYSTEM, 'CPU load', true, `${loadAvg[0].toFixed(2)} avg`);
    } catch (err) {
      this.addCheck(CATEGORIES.SYSTEM, 'CPU load', false, err.message);
    }

    // Node.js version check
    try {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
      
      if (majorVersion < 18) {
        this.addIssue(
          CATEGORIES.SYSTEM,
          SEVERITY.MEDIUM,
          'Outdated Node.js version',
          `Running Node.js ${nodeVersion}, minimum recommended is v18`,
          'Upgrade Node.js to v18 or later'
        );
      }
      
      this.addCheck(CATEGORIES.SYSTEM, 'Node.js version', true, nodeVersion);
    } catch (err) {
      this.addCheck(CATEGORIES.SYSTEM, 'Node.js version', false, err.message);
    }
  }

  // ===========================================================================
  // Docker Checks
  // ===========================================================================

  async checkDocker() {
    this.addCheck(CATEGORIES.DOCKER, 'Starting Docker checks', true);

    // Docker daemon running
    try {
      execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'pipe' });
      this.addCheck(CATEGORIES.DOCKER, 'Docker daemon', true);
    } catch (err) {
      this.addIssue(
        CATEGORIES.DOCKER,
        SEVERITY.CRITICAL,
        'Docker daemon not running',
        'Docker daemon is not accessible',
        'Start Docker: sudo systemctl start docker'
      );
      this.addCheck(CATEGORIES.DOCKER, 'Docker daemon', false, 'Not running');
      return; // Skip further Docker checks
    }

    // Docker Compose availability
    try {
      const composeVersion = execSync('docker-compose --version || docker compose version', { 
        encoding: 'utf8',
        stdio: 'pipe' 
      }).trim();
      this.addCheck(CATEGORIES.DOCKER, 'Docker Compose', true, composeVersion.split(' ')[2] || 'available');
    } catch (err) {
      this.addIssue(
        CATEGORIES.DOCKER,
        SEVERITY.CRITICAL,
        'Docker Compose not found',
        'docker-compose command is not available',
        'Install Docker Compose: https://docs.docker.com/compose/install/'
      );
      this.addCheck(CATEGORIES.DOCKER, 'Docker Compose', false);
    }

    // Docker disk usage
    try {
      const dockerSystemDf = execSync('docker system df --format "{{.Size}}"', { 
        encoding: 'utf8',
        stdio: 'pipe' 
      }).trim().split('\n');
      
      const imagesSize = this.parseDockerSize(dockerSystemDf[0] || '0B');
      const containersSize = this.parseDockerSize(dockerSystemDf[1] || '0B');
      const volumesSize = this.parseDockerSize(dockerSystemDf[2] || '0B');
      
      const totalDockerSize = imagesSize + containersSize + volumesSize;
      
      if (totalDockerSize > 50 * 1024 * 1024 * 1024) { // 50GB
        this.addIssue(
          CATEGORIES.DOCKER,
          SEVERITY.MEDIUM,
          'High Docker disk usage',
          `Docker is using ${this.formatBytes(totalDockerSize)} of disk space`,
          'Clean up: docker system prune -a, mc cleanup'
        );
      }
      
      this.addCheck(CATEGORIES.DOCKER, 'Disk usage', true, this.formatBytes(totalDockerSize));
    } catch (err) {
      this.addCheck(CATEGORIES.DOCKER, 'Disk usage', false, err.message);
    }

    // Check for unhealthy containers
    try {
      const unhealthyContainers = execSync(
        'docker ps --filter "health=unhealthy" --format "{{.Names}}" 2>/dev/null || true',
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      
      if (unhealthyContainers) {
        const containers = unhealthyContainers.split('\n').filter(Boolean);
        this.addIssue(
          CATEGORIES.DOCKER,
          SEVERITY.HIGH,
          'Unhealthy containers detected',
          `Containers with failing health checks: ${containers.join(', ')}`,
          'Check logs: mc logs <service>, then restart: mc revive'
        );
      }
      
      this.addCheck(CATEGORIES.DOCKER, 'Container health', !unhealthyContainers);
    } catch (err) {
      this.addCheck(CATEGORIES.DOCKER, 'Container health', false, err.message);
    }
  }

  // ===========================================================================
  // Services Checks
  // ===========================================================================

  async checkServices() {
    this.addCheck(CATEGORIES.SERVICES, 'Starting services checks', true);

    const services = [
      { name: 'mc-core', port: 8000, path: '/health' },
      { name: 'mc-backend', port: 3001, path: '/health' },
      { name: 'mc-gateway', port: 3000, path: '/' },
      { name: 'mc-chroma', port: 8000, path: '/api/v1/heartbeat' },
    ];

    for (const service of services) {
      try {
        // Check if container is running
        const containerRunning = execSync(
          `docker ps --filter "name=${service.name}" --filter "status=running" --format "{{.Names}}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        ).trim();

        if (!containerRunning) {
          this.addIssue(
            CATEGORIES.SERVICES,
            SEVERITY.HIGH,
            `${service.name} is not running`,
            `The ${service.name} container is stopped or not found`,
            'Start services: mc revive'
          );
          this.addCheck(CATEGORIES.SERVICES, service.name, false, 'Not running');
          continue;
        }

        // Check health endpoint
        try {
          const healthCheck = execSync(
            `docker exec ${service.name} wget -qO- --timeout=5 http://localhost:${service.port}${service.path} 2>/dev/null || echo "{\\"status\\": \\"unknown\\"}"`,
            { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }
          ).trim();
          
          const health = JSON.parse(healthCheck);
          
          if (health.status === 'healthy' || health.status === 'running' || health.status === 'ok') {
            this.addCheck(CATEGORIES.SERVICES, service.name, true, 'Healthy');
          } else {
            this.addCheck(CATEGORIES.SERVICES, service.name, false, 'Unhealthy response');
          }
        } catch (err) {
          this.addCheck(CATEGORIES.SERVICES, service.name, true, 'Running (health check failed)');
        }
      } catch (err) {
        this.addCheck(CATEGORIES.SERVICES, service.name, false, err.message);
      }
    }

    // Check for restart loops
    try {
      const restartCounts = execSync(
        'docker ps --filter "name=mc-" --format "{{.Names}}:{{.RestartCount}}"',
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      const highRestartContainers = restartCounts
        .split('\n')
        .filter(line => {
          const [, count] = line.split(':');
          return parseInt(count, 10) > 5;
        })
        .map(line => line.split(':')[0]);

      if (highRestartContainers.length > 0) {
        this.addIssue(
          CATEGORIES.SERVICES,
          SEVERITY.HIGH,
          'Services restarting frequently',
          `Containers with high restart counts: ${highRestartContainers.join(', ')}`,
          'Check logs for errors: mc logs <service>'
        );
      }
    } catch (err) {
      // Ignore - restart count check is optional
    }
  }

  // ===========================================================================
  // Configuration Checks
  // ===========================================================================

  async checkConfig() {
    this.addCheck(CATEGORIES.CONFIG, 'Starting configuration checks', true);

    try {
      const infraDir = findInfraDir();
      
      // Check .env file exists
      const envPath = path.join(infraDir, '.env');
      if (!await fs.pathExists(envPath)) {
        this.addIssue(
          CATEGORIES.CONFIG,
          SEVERITY.CRITICAL,
          'Missing .env file',
          'No .env configuration file found',
          'Create from template: cp .env.example .env'
        );
        this.addCheck(CATEGORIES.CONFIG, 'Environment file', false);
        return;
      }

      const envContent = await fs.readFile(envPath, 'utf8');
      
      // Check required variables
      const requiredVars = ['DOMAIN', 'ACME_EMAIL', 'GATEWAY_TOKEN'];
      const missingVars = [];
      
      for (const varName of requiredVars) {
        const regex = new RegExp(`^${varName}=.+`, 'm');
        if (!regex.test(envContent) || envContent.includes(`${varName}=your_`)) {
          missingVars.push(varName);
        }
      }
      
      if (missingVars.length > 0) {
        this.addIssue(
          CATEGORIES.CONFIG,
          SEVERITY.CRITICAL,
          'Missing required environment variables',
          `Required variables not set: ${missingVars.join(', ')}`,
          'Edit .env file and set all required variables'
        );
      }
      
      this.addCheck(CATEGORIES.CONFIG, 'Required variables', missingVars.length === 0);

      // Check for placeholder values
      const placeholderPatterns = [
        /your_domain\.com/,
        /your@email\.com/,
        /your_token_here/,
        /changeme/,
        /REPLACE_WITH_/,
      ];
      
      const hasPlaceholders = placeholderPatterns.some(pattern => pattern.test(envContent));
      
      if (hasPlaceholders) {
        this.addIssue(
          CATEGORIES.CONFIG,
          SEVERITY.HIGH,
          'Placeholder values detected',
          '.env file contains placeholder values that need to be replaced',
          'Edit .env and replace all placeholder values'
        );
      }
      
      this.addCheck(CATEGORIES.CONFIG, 'Placeholder check', !hasPlaceholders);

      // Check file permissions
      const stats = await fs.stat(envPath);
      const mode = stats.mode & parseInt('777', 8);
      
      if (mode & parseInt('044', 8)) { // Group or others can read
        this.addIssue(
          CATEGORIES.CONFIG,
          SEVERITY.MEDIUM,
          'Insecure .env file permissions',
          '.env file is readable by group or others',
          'Fix permissions: chmod 600 .env'
        );
      }
      
      this.addCheck(CATEGORIES.CONFIG, 'File permissions', !(mode & parseInt('044', 8)));

    } catch (err) {
      this.addCheck(CATEGORIES.CONFIG, 'Configuration', false, err.message);
    }
  }

  // ===========================================================================
  // Network Checks
  // ===========================================================================

  async checkNetwork() {
    this.addCheck(CATEGORIES.NETWORK, 'Starting network checks', true);

    // Check port availability
    const criticalPorts = [80, 443, 3000, 3001, 8000];
    
    for (const port of criticalPorts) {
      const isAvailable = await this.isPortAvailable(port);
      if (!isAvailable) {
        // Check if it's our service using it
        try {
          const usingProcess = execSync(
            `lsof -i :${port} -t 2>/dev/null || netstat -tlnp 2>/dev/null | grep ":${port} " || echo ""`,
            { encoding: 'utf8', stdio: 'pipe' }
          ).trim();
          
          if (!usingProcess.includes('docker') && !usingProcess.includes('mc-')) {
            this.addIssue(
              CATEGORIES.NETWORK,
              SEVERITY.HIGH,
              `Port ${port} is in use`,
              `Port ${port} is being used by another process`,
              `Identify and stop the conflicting process: lsof -i :${port}`
            );
          }
        } catch (err) {
          // Ignore lsof errors
        }
      }
    }
    
    this.addCheck(CATEGORIES.NETWORK, 'Port availability', true);

    // Check DNS resolution
    try {
      const dns = require('dns').promises;
      await dns.lookup('google.com');
      this.addCheck(CATEGORIES.NETWORK, 'DNS resolution', true);
    } catch (err) {
      this.addIssue(
        CATEGORIES.NETWORK,
        SEVERITY.HIGH,
        'DNS resolution failing',
        'Cannot resolve external hostnames',
        'Check network connection and DNS configuration'
      );
      this.addCheck(CATEGORIES.NETWORK, 'DNS resolution', false);
    }

    // Check internet connectivity
    try {
      await Promise.race([
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
        new Promise((resolve) => {
          const req = require('https').get('https://1.1.1.1', (res) => {
            resolve(res.statusCode === 200 || res.statusCode === 301);
          });
          req.on('error', () => resolve(false));
        })
      ]);
      this.addCheck(CATEGORIES.NETWORK, 'Internet connectivity', true);
    } catch (err) {
      this.addIssue(
        CATEGORIES.NETWORK,
        SEVERITY.MEDIUM,
        'Internet connectivity issues',
        'Limited or no internet access',
        'Check network connection'
      );
      this.addCheck(CATEGORIES.NETWORK, 'Internet connectivity', false);
    }
  }

  // ===========================================================================
  // Security Checks
  // ===========================================================================

  async checkSecurity() {
    this.addCheck(CATEGORIES.SECURITY, 'Starting security checks', true);

    try {
      const infraDir = findInfraDir();
      
      // Check for exposed sensitive files
      const sensitiveFiles = ['.env', '.env.backup', '.env.local'];
      const exposedFiles = [];
      
      for (const file of sensitiveFiles) {
        const filePath = path.join(infraDir, file);
        if (await fs.pathExists(filePath)) {
          const stats = await fs.stat(filePath);
          const mode = stats.mode & parseInt('777', 8);
          
          if (mode & parseInt('044', 8)) {
            exposedFiles.push(file);
          }
        }
      }
      
      if (exposedFiles.length > 0) {
        this.addIssue(
          CATEGORIES.SECURITY,
          SEVERITY.HIGH,
          'Exposed sensitive files',
          `Files readable by others: ${exposedFiles.join(', ')}`,
          'Fix permissions: chmod 600 ' + exposedFiles.join(' ')
        );
      }
      
      this.addCheck(CATEGORIES.SECURITY, 'File permissions', exposedFiles.length === 0);

      // Check for weak gateway token
      try {
        const envPath = path.join(infraDir, '.env');
        const envContent = await fs.readFile(envPath, 'utf8');
        const tokenMatch = envContent.match(/GATEWAY_TOKEN=(.+)/);
        
        if (tokenMatch) {
          const token = tokenMatch[1].trim();
          
          if (token.length < 16 || /^[a-z]+$/.test(token) || /^[0-9]+$/.test(token)) {
            this.addIssue(
              CATEGORIES.SECURITY,
              SEVERITY.HIGH,
              'Weak gateway token detected',
              'GATEWAY_TOKEN is too short or easily guessable',
              'Generate a strong token: openssl rand -hex 32'
            );
          }
        }
      } catch (err) {
        // Ignore token check errors
      }

      // Check Docker socket exposure
      try {
        const composePath = path.join(infraDir, 'docker-compose.yml');
        if (await fs.pathExists(composePath)) {
          const composeContent = await fs.readFile(composePath, 'utf8');
          
          if (composeContent.includes('/var/run/docker.sock') && 
              !composeContent.includes(':ro')) {
            this.addIssue(
              CATEGORIES.SECURITY,
              SEVERITY.MEDIUM,
              'Docker socket not read-only',
              'A service has read-write access to the Docker socket',
              'Add :ro to Docker socket mounts in docker-compose.yml'
            );
          }
        }
      } catch (err) {
        // Ignore compose check errors
      }

      this.addCheck(CATEGORIES.SECURITY, 'Docker socket', true);

    } catch (err) {
      this.addCheck(CATEGORIES.SECURITY, 'Security checks', false, err.message);
    }
  }

  // ===========================================================================
  // Performance Checks
  // ===========================================================================

  async checkPerformance() {
    this.addCheck(CATEGORIES.PERFORMANCE, 'Starting performance checks', true);

    // Check log file sizes
    try {
      const infraDir = findInfraDir();
      const logsPath = path.join(infraDir, 'data', 'logs');
      
      if (await fs.pathExists(logsPath)) {
        const logFiles = await fs.readdir(logsPath);
        let totalLogSize = 0;
        
        for (const file of logFiles) {
          const filePath = path.join(logsPath, file);
          const stats = await fs.stat(filePath);
          totalLogSize += stats.size;
        }
        
        if (totalLogSize > 1024 * 1024 * 1024) { // 1GB
          this.addIssue(
            CATEGORIES.PERFORMANCE,
            SEVERITY.MEDIUM,
            'Large log files',
            `Log files are consuming ${this.formatBytes(totalLogSize)}`,
            'Clean up logs: mc logs clean'
          );
        }
        
        this.addCheck(CATEGORIES.PERFORMANCE, 'Log sizes', totalLogSize < 1024 * 1024 * 1024);
      }
    } catch (err) {
      this.addCheck(CATEGORIES.PERFORMANCE, 'Log sizes', false, err.message);
    }

    // Check for old backups
    try {
      const infraDir = findInfraDir();
      const backupsPath = path.join(infraDir, 'backups');
      
      if (await fs.pathExists(backupsPath)) {
        const backups = await fs.readdir(backupsPath);
        const backupCount = backups.filter(f => f.startsWith('backup_')).length;
        
        if (backupCount > 30) {
          this.addIssue(
            CATEGORIES.PERFORMANCE,
            SEVERITY.LOW,
            'Many backup files',
            `${backupCount} backup files found`,
            'Clean old backups: ls -lt backups/ | tail -n +31 | awk "{print \$9}" | xargs rm'
          );
        }
        
        this.addCheck(CATEGORIES.PERFORMANCE, 'Backup count', backupCount <= 30, `${backupCount} backups`);
      }
    } catch (err) {
      this.addCheck(CATEGORIES.PERFORMANCE, 'Backup count', false, err.message);
    }

    // Check response times
    try {
      const services = [
        { name: 'mc-core', port: 8000 },
        { name: 'mc-backend', port: 3001 },
      ];

      for (const service of services) {
        const startTime = Date.now();
        try {
          execSync(
            `docker exec ${service.name} wget -qO- --timeout=3 http://localhost:${service.port}/health 2>/dev/null || true`,
            { stdio: 'pipe', timeout: 5000 }
          );
          const responseTime = Date.now() - startTime;
          
          if (responseTime > 5000) {
            this.addIssue(
              CATEGORIES.PERFORMANCE,
              SEVERITY.MEDIUM,
              `${service.name} slow response`,
              `Health check took ${responseTime}ms`,
              'Check resource usage: mc exec ' + service.name + ' "top -n 1"'
            );
          }
        } catch (err) {
          // Ignore timing errors
        }
      }
      
      this.addCheck(CATEGORIES.PERFORMANCE, 'Response times', true);
    } catch (err) {
      this.addCheck(CATEGORIES.PERFORMANCE, 'Response times', false, err.message);
    }
  }

  // ===========================================================================
  // Report Generation
  // ===========================================================================

  generateReport() {
    const duration = Date.now() - this.startTime;
    
    // Count issues by severity
    const counts = {
      critical: this.issues.filter(i => i.severity === SEVERITY.CRITICAL).length,
      high: this.issues.filter(i => i.severity === SEVERITY.HIGH).length,
      medium: this.issues.filter(i => i.severity === SEVERITY.MEDIUM).length,
      low: this.issues.filter(i => i.severity === SEVERITY.LOW).length,
      info: this.issues.filter(i => i.severity === SEVERITY.INFO).length,
    };

    const totalIssues = Object.values(counts).reduce((a, b) => a + b, 0);
    const passedChecks = this.checks.filter(c => c.passed).length;
    const totalChecks = this.checks.length;

    return {
      duration,
      summary: {
        checksPassed: passedChecks,
        checksTotal: totalChecks,
        issuesFound: totalIssues,
        issuesBySeverity: counts,
        healthy: counts.critical === 0 && counts.high === 0,
      },
      issues: this.issues,
      checks: this.checks,
    };
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  async getDiskSpace() {
    const stats = await fs.statfs('/');
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    return { total, free, used: total - free };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  parseDockerSize(sizeStr) {
    const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
    const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?B)$/i);
    if (!match) return 0;
    return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
  }

  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  }
}

// =============================================================================
// CLI Integration
// =============================================================================

async function runDoctor(options = {}) {
  const doctor = new MasterClawDoctor(options);
  
  if (!options.json) {
    console.log(chalk.blue('🩺 MasterClaw Doctor'));
    console.log(chalk.gray('   Running comprehensive diagnostics...\n'));
  }

  const report = await doctor.run();

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  // Print issues by severity
  const severityOrder = [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW, SEVERITY.INFO];
  const severityColors = {
    [SEVERITY.CRITICAL]: chalk.red,
    [SEVERITY.HIGH]: chalk.red,
    [SEVERITY.MEDIUM]: chalk.yellow,
    [SEVERITY.LOW]: chalk.gray,
    [SEVERITY.INFO]: chalk.blue,
  };
  const severityIcons = {
    [SEVERITY.CRITICAL]: '🔴',
    [SEVERITY.HIGH]: '🟠',
    [SEVERITY.MEDIUM]: '🟡',
    [SEVERITY.LOW]: '🔵',
    [SEVERITY.INFO]: 'ℹ️',
  };

  if (report.issues.length > 0) {
    console.log(chalk.cyan('Issues Found:'));
    console.log('');

    for (const severity of severityOrder) {
      const issues = report.issues.filter(i => i.severity === severity);
      if (issues.length === 0) continue;

      console.log(severityColors[severity](`${severityIcons[severity]} ${severity.toUpperCase()} (${issues.length})`));
      
      for (const issue of issues) {
        console.log(`  ${chalk.bold(issue.title)}`);
        console.log(chalk.gray(`    ${issue.description}`));
        if (issue.fix) {
          console.log(chalk.cyan(`    💡 Fix: ${issue.fix}`));
        }
        console.log('');
      }
    }
  }

  // Summary
  console.log(chalk.cyan('Summary:'));
  console.log(`  Checks passed: ${chalk.green(report.summary.checksPassed)}/${report.summary.checksTotal}`);
  
  if (report.summary.issuesFound > 0) {
    const issueSummary = [];
    if (report.summary.issuesBySeverity.critical > 0) {
      issueSummary.push(chalk.red(`${report.summary.issuesBySeverity.critical} critical`));
    }
    if (report.summary.issuesBySeverity.high > 0) {
      issueSummary.push(chalk.red(`${report.summary.issuesBySeverity.high} high`));
    }
    if (report.summary.issuesBySeverity.medium > 0) {
      issueSummary.push(chalk.yellow(`${report.summary.issuesBySeverity.medium} medium`));
    }
    if (report.summary.issuesBySeverity.low > 0) {
      issueSummary.push(chalk.gray(`${report.summary.issuesBySeverity.low} low`));
    }
    console.log(`  Issues found: ${issueSummary.join(', ') || 'none'}`);
  } else {
    console.log(`  Issues found: ${chalk.green('None')} ✅`);
  }

  console.log(chalk.gray(`  Duration: ${report.duration}ms`));
  console.log('');

  // Health status
  if (report.summary.healthy) {
    console.log(chalk.green('✅ System is healthy'));
  } else {
    console.log(chalk.red('❌ System has issues that need attention'));
    
    if (report.summary.issuesBySeverity.critical > 0) {
      console.log(chalk.red('\n🔴 Critical issues require immediate action!'));
    }
  }

  // Fix suggestions
  if (!report.summary.healthy && options.fix) {
    console.log('');
    console.log(chalk.cyan('🔧 Auto-fix not yet implemented.'));
    console.log(chalk.gray('   Run the suggested fix commands manually.'));
  }

  return report;
}

module.exports = {
  MasterClawDoctor,
  runDoctor,
  CATEGORIES,
  SEVERITY,
};
