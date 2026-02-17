/**
 * Tests for the info module
 */

const info = require('../lib/info');
const config = require('../lib/config');
const { findInfraDir } = require('../lib/services');

// Mock dependencies
jest.mock('../lib/config');
jest.mock('../lib/services');
jest.mock('axios');

const axios = require('axios');

describe('Info Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCliInfo', () => {
    it('should return CLI version and Node info', async () => {
      const result = await info.getCliInfo();
      
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('nodeVersion');
      expect(result).toHaveProperty('platform');
      expect(result).toHaveProperty('arch');
      expect(result.nodeVersion).toBe(process.version);
    });
  });

  describe('getSystemInfo', () => {
    it('should return system information', async () => {
      const result = await info.getSystemInfo();
      
      expect(result).toHaveProperty('hostname');
      expect(result).toHaveProperty('platform');
      expect(result).toHaveProperty('release');
      expect(result).toHaveProperty('arch');
      expect(result).toHaveProperty('cpus');
      expect(result).toHaveProperty('totalMemory');
      expect(result).toHaveProperty('freeMemory');
      expect(result).toHaveProperty('uptime');
      
      expect(typeof result.cpus).toBe('number');
      expect(result.cpus).toBeGreaterThan(0);
    });
  });

  describe('getApiInfo', () => {
    it('should return API info when available', async () => {
      config.get = jest.fn().mockResolvedValue('http://localhost:8000');
      axios.get = jest.fn().mockResolvedValue({
        data: {
          version: '1.0.0',
          status: 'running',
        },
      });

      const result = await info.getApiInfo();
      
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.0.0');
      expect(result.status).toBe('running');
    });

    it('should handle API unavailable', async () => {
      config.get = jest.fn().mockResolvedValue('http://localhost:8000');
      axios.get = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const result = await info.getApiInfo();
      
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getInfraInfo', () => {
    it('should return infrastructure info when found', async () => {
      findInfraDir.mockResolvedValue('/path/to/infra');
      
      const result = await info.getInfraInfo();
      
      expect(result.found).toBe(true);
      expect(result.path).toBe('/path/to/infra');
      expect(result).toHaveProperty('hasDockerCompose');
      expect(result).toHaveProperty('hasEnv');
      expect(result).toHaveProperty('hasMakefile');
      expect(result).toHaveProperty('hasMonitoring');
    });

    it('should handle missing infrastructure', async () => {
      findInfraDir.mockResolvedValue(null);
      
      const result = await info.getInfraInfo();
      
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
    });
  });

  describe('getConfigSummary', () => {
    it('should return config summary', async () => {
      config.list = jest.fn().mockResolvedValue({
        'core.url': 'http://localhost:8000',
        'gateway.url': 'http://localhost:3000',
      });
      config.getConfigPath = jest.fn().mockReturnValue('/home/user/.masterclaw/config.json');

      const result = await info.getConfigSummary();
      
      expect(result.configured).toBe(true);
      expect(result.keys).toEqual(['core.url', 'gateway.url']);
      expect(result.configPath).toBe('/home/user/.masterclaw/config.json');
    });

    it('should handle unconfigured state', async () => {
      config.list = jest.fn().mockRejectedValue(new Error('Config not found'));

      const result = await info.getConfigSummary();
      
      expect(result.configured).toBe(false);
      expect(result.error).toBe('Config not found');
    });
  });

  describe('getFeatureInfo', () => {
    it('should check feature availability', async () => {
      findInfraDir.mockResolvedValue('/path/to/infra');
      
      const result = await info.getFeatureInfo();
      
      expect(result).toHaveProperty('monitoring');
      expect(result).toHaveProperty('ssl');
      expect(result).toHaveProperty('backup');
      expect(result).toHaveProperty('canaryDeploy');
      expect(typeof result.monitoring).toBe('boolean');
    });

    it('should return all false when no infra', async () => {
      findInfraDir.mockResolvedValue(null);
      
      const result = await info.getFeatureInfo();
      
      expect(result.monitoring).toBe(false);
      expect(result.ssl).toBe(false);
      expect(result.backup).toBe(false);
      expect(result.canaryDeploy).toBe(false);
    });
  });

  describe('showInfo', () => {
    let consoleSpy;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      findInfraDir.mockResolvedValue(null);
      config.list = jest.fn().mockResolvedValue({});
      config.getConfigPath = jest.fn().mockReturnValue('/test/config.json');
      config.get = jest.fn().mockResolvedValue(null);
      axios.get = jest.fn().mockRejectedValue(new Error('Unavailable'));
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should output pretty format by default', async () => {
      await info.showInfo();
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('MasterClaw System Information'));
    });

    it('should output JSON when requested', async () => {
      await info.showInfo({ json: true });
      
      const output = consoleSpy.mock.calls.find(call => {
        try {
          JSON.parse(call[0]);
          return true;
        } catch {
          return false;
        }
      });
      
      expect(output).toBeDefined();
      
      const parsed = JSON.parse(output[0]);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('cli');
      expect(parsed).toHaveProperty('system');
      expect(parsed).toHaveProperty('api');
    });

    it('should return info object', async () => {
      const result = await info.showInfo();
      
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('cli');
      expect(result).toHaveProperty('system');
      expect(result).toHaveProperty('api');
      expect(result).toHaveProperty('infrastructure');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('docker');
      expect(result).toHaveProperty('features');
    });
  });
});
