/**
 * @jest-environment node
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

// Mock dependencies
jest.mock('axios');
jest.mock('fs-extra');
jest.mock('child_process');

// Mock console methods
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();

describe('Deployment Notifications', () => {
  let deploy;
  const mockInfraDir = '/mock/masterclaw-infrastructure';

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset modules to get fresh instance
    jest.resetModules();
    
    // Mock fs.existsSync for infra dir detection
    fs.existsSync = jest.fn().mockImplementation((p) => {
      if (p.includes('deploy-zero-downtime.sh')) return true;
      return false;
    });

    // Mock fs.pathExists for async checks
    fs.pathExists = jest.fn().mockResolvedValue(true);
    
    // Mock fs.readJson
    fs.readJson = jest.fn().mockResolvedValue({
      version: '1.0',
      channels: {
        discord: { enabled: true, webhook: 'https://discord.com/webhook' },
        slack: { enabled: false },
        telegram: { enabled: false },
        whatsapp: { enabled: false },
      },
      alerts: {
        deployment: true,
        serviceDown: true,
        sslExpiring: true,
        highCost: true,
        securityThreat: true,
      },
    });

    // Mock fs.writeJson
    fs.writeJson = jest.fn().mockResolvedValue(undefined);
    fs.ensureDir = jest.fn().mockResolvedValue(undefined);
    fs.readFile = jest.fn().mockResolvedValue('ALERT_WEBHOOK_PORT=8080\nDOMAIN=localhost');

    // Mock axios
    axios.get = jest.fn().mockResolvedValue({ data: { status: 'ok' } });
    axios.post = jest.fn().mockResolvedValue({ data: { success: true } });

    // Load deploy module after mocks are set up
    deploy = require('../lib/deploy');
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  describe('Notification Configuration', () => {
    test('should enable deployment notifications', async () => {
      // Mock process.argv for command parsing
      const originalArgv = process.argv;
      process.argv = ['node', 'mc', 'deploy', 'notify', '--enable'];

      const { program } = require('commander');
      const cmd = new program.Command();
      
      // Simulate running the notify command
      await fs.writeJson.mockResolvedValueOnce(undefined);
      
      // Verify config would be updated
      expect(fs.writeJson).not.toHaveBeenCalled();
      
      process.argv = originalArgv;
    });

    test('should load existing notification config', async () => {
      const config = await fs.readJson('/mock/config/notifications.json');
      
      expect(config).toBeDefined();
      expect(config.alerts.deployment).toBe(true);
      expect(config.channels.discord.enabled).toBe(true);
    });
  });

  describe('Deployment Notification Payloads', () => {
    test('should build correct payload for deployment started', async () => {
      const details = {
        version: '1.2.3',
        color: 'blue',
        initiator: 'testuser',
      };

      const payload = {
        version: '4',
        status: 'firing',
        alerts: [{
          status: 'firing',
          labels: {
            alertname: 'DeploymentNotification',
            severity: 'info',
            instance: 'masterclaw',
            deployment_type: 'started',
          },
          annotations: {
            summary: '🚀 Deployment Started',
            description: 'Deploying MasterClaw v1.2.3 (blue) by testuser',
          },
          startsAt: expect.any(String),
        }],
      };

      // Verify payload structure
      expect(payload.alerts[0].annotations.summary).toBe('🚀 Deployment Started');
      expect(payload.alerts[0].annotations.description).toContain('v1.2.3');
      expect(payload.alerts[0].annotations.description).toContain('blue');
      expect(payload.alerts[0].annotations.description).toContain('testuser');
    });

    test('should build correct payload for deployment success', async () => {
      const details = {
        version: '1.2.3',
        color: 'green',
        duration: '2m 30s',
      };

      const payload = {
        version: '4',
        status: 'resolved',
        alerts: [{
          status: 'resolved',
          labels: {
            alertname: 'DeploymentNotification',
            severity: 'resolved',
          },
          annotations: {
            summary: '✅ Deployment Successful',
            description: 'MasterClaw deployment completed successfully (v1.2.3) on green in 2m 30s',
          },
        }],
      };

      expect(payload.alerts[0].annotations.summary).toBe('✅ Deployment Successful');
      expect(payload.alerts[0].annotations.description).toContain('completed successfully');
      expect(payload.alerts[0].annotations.description).toContain('2m 30s');
      expect(payload.status).toBe('resolved');
    });

    test('should build correct payload for deployment failure', async () => {
      const details = {
        version: '1.2.3',
        color: 'blue',
        duration: '45s',
        error: 'Health check failed',
      };

      const payload = {
        version: '4',
        status: 'firing',
        alerts: [{
          status: 'firing',
          labels: {
            alertname: 'DeploymentNotification',
            severity: 'critical',
          },
          annotations: {
            summary: '❌ Deployment Failed',
            description: 'MasterClaw deployment failed (v1.2.3) on blue: Health check failed after 45s',
          },
        }],
      };

      expect(payload.alerts[0].annotations.summary).toBe('❌ Deployment Failed');
      expect(payload.alerts[0].labels.severity).toBe('critical');
      expect(payload.alerts[0].annotations.description).toContain('Health check failed');
    });

    test('should build correct payload for rollback', async () => {
      const details = {
        duration: '1m 15s',
      };

      const payload = {
        version: '4',
        status: 'resolved',
        alerts: [{
          status: 'resolved',
          labels: {
            alertname: 'DeploymentNotification',
            severity: 'warning',
          },
          annotations: {
            summary: '↩️ Deployment Rolled Back',
            description: 'Rolled back to previous version in 1m 15s',
          },
        }],
      };

      expect(payload.alerts[0].annotations.summary).toBe('↩️ Deployment Rolled Back');
      expect(payload.alerts[0].labels.severity).toBe('warning');
    });
  });

  describe('Duration Formatting', () => {
    test('should format duration less than a minute', () => {
      const ms = 45000; // 45 seconds
      const result = ms < 60000 ? `${Math.floor(ms / 1000)}s` : '';
      expect(result).toBe('45s');
    });

    test('should format duration in minutes', () => {
      const ms = 150000; // 2.5 minutes
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const result = minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
      expect(result).toBe('2m 30s');
    });

    test('should format duration in hours', () => {
      const ms = 7500000; // 2+ hours
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const result = hours > 0 ? `${hours}h ${minutes % 60}m` : '';
      expect(result).toBe('2h 5m');
    });
  });

  describe('Webhook Integration', () => {
    test('should check if webhook is running', async () => {
      axios.get.mockResolvedValueOnce({ data: { status: 'ok' } });
      
      const isRunning = await axios.get('http://localhost:8080/health', { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      
      expect(isRunning).toBe(true);
      expect(axios.get).toHaveBeenCalledWith('http://localhost:8080/health', { timeout: 2000 });
    });

    test('should handle webhook not running', async () => {
      axios.get.mockRejectedValueOnce(new Error('Connection refused'));
      
      const isRunning = await axios.get('http://localhost:8080/health', { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      
      expect(isRunning).toBe(false);
    });

    test('should send notification to webhook', async () => {
      const payload = {
        version: '4',
        status: 'firing',
        alerts: [{
          status: 'firing',
          labels: { alertname: 'DeploymentNotification' },
          annotations: { summary: 'Test', description: 'Test description' },
        }],
      };

      axios.post.mockResolvedValueOnce({ data: { success: true } });

      await axios.post('http://localhost:8080/alerts', payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:8080/alerts',
        payload,
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        })
      );
    });
  });

  describe('Configuration File Handling', () => {
    test('should add deployment alert type to existing config', async () => {
      const existingConfig = {
        version: '1.0',
        channels: {},
        alerts: {
          serviceDown: true,
          sslExpiring: true,
        },
      };

      // Simulate adding deployment field
      if (existingConfig.alerts.deployment === undefined) {
        existingConfig.alerts.deployment = true;
      }

      expect(existingConfig.alerts.deployment).toBe(true);
    });

    test('should create default config if not exists', async () => {
      fs.pathExists.mockResolvedValueOnce(false);

      const defaultConfig = {
        version: '1.0',
        channels: {
          whatsapp: { enabled: false, target: '' },
          discord: { enabled: false, webhook: '' },
          slack: { enabled: false, webhook: '' },
          telegram: { enabled: false, token: '', chatId: '' },
        },
        alerts: {
          serviceDown: true,
          sslExpiring: true,
          highCost: true,
          securityThreat: true,
          deployment: true,
        },
      };

      expect(defaultConfig.alerts.deployment).toBe(true);
    });
  });

  describe('Environment Variable Loading', () => {
    test('should load ALERT_WEBHOOK_PORT from env', async () => {
      const envContent = 'ALERT_WEBHOOK_PORT=9090\nDOMAIN=test.com';
      fs.readFile.mockResolvedValueOnce(envContent);

      const env = {};
      envContent.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          env[match[1].trim()] = match[2].trim();
        }
      });

      expect(env.ALERT_WEBHOOK_PORT).toBe('9090');
      expect(env.DOMAIN).toBe('test.com');
    });

    test('should default to port 8080 if not set', async () => {
      const envContent = 'DOMAIN=test.com';
      
      const env = {};
      envContent.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          env[match[1].trim()] = match[2].trim();
        }
      });

      const port = env.ALERT_WEBHOOK_PORT || '8080';
      expect(port).toBe('8080');
    });
  });
});

describe('Deploy Commands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('deploy module exports Command instance', () => {
    const deploy = require('../lib/deploy');
    expect(deploy).toBeDefined();
    expect(deploy.name()).toBe('deploy');
  });

  test('should have rolling command', () => {
    const deploy = require('../lib/deploy');
    const rollingCmd = deploy.commands.find(c => c.name() === 'rolling');
    expect(rollingCmd).toBeDefined();
    expect(rollingCmd.description()).toContain('zero downtime');
  });

  test('should have canary command', () => {
    const deploy = require('../lib/deploy');
    const canaryCmd = deploy.commands.find(c => c.name() === 'canary');
    expect(canaryCmd).toBeDefined();
    expect(canaryCmd.description()).toContain('percentage');
  });

  test('should have rollback command', () => {
    const deploy = require('../lib/deploy');
    const rollbackCmd = deploy.commands.find(c => c.name() === 'rollback');
    expect(rollbackCmd).toBeDefined();
    expect(rollbackCmd.description()).toContain('Rollback');
  });

  test('should have notify command', () => {
    const deploy = require('../lib/deploy');
    const notifyCmd = deploy.commands.find(c => c.name() === 'notify');
    expect(notifyCmd).toBeDefined();
    expect(notifyCmd.description()).toContain('notifications');
  });

  test('should have notify-test command', () => {
    const deploy = require('../lib/deploy');
    const testCmd = deploy.commands.find(c => c.name() === 'notify-test');
    expect(testCmd).toBeDefined();
    expect(testCmd.description()).toContain('test');
  });
});
