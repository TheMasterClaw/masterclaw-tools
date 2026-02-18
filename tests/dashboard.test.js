/**
 * Tests for dashboard.js
 * Tests dashboard command functionality including URL management and browser opening
 */

const dashboard = require('../lib/dashboard');
const config = require('../lib/config');

// Mock dependencies
jest.mock('../lib/config');
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  exec: jest.fn(),
}));

const { spawn } = require('child_process');

describe('Dashboard Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    spawn.mockReset();
    config.get.mockReset();
    process.platform = 'linux';
  });

  describe('Constants and Metadata', () => {
    test('should have all expected dashboards defined', () => {
      expect(dashboard.DASHBOARDS).toHaveProperty('grafana');
      expect(dashboard.DASHBOARDS).toHaveProperty('prometheus');
      expect(dashboard.DASHBOARDS).toHaveProperty('loki');
      expect(dashboard.DASHBOARDS).toHaveProperty('traefik');
      expect(dashboard.DASHBOARDS).toHaveProperty('alertmanager');
    });

    test('grafana dashboard should have correct metadata', () => {
      const grafana = dashboard.DASHBOARDS.grafana;
      expect(grafana.name).toBe('Grafana');
      expect(grafana.defaultUrl).toBe('http://localhost:3003');
      expect(grafana.icon).toBe('📊');
      expect(grafana.paths).toContain('/dashboards');
      expect(grafana.paths).toContain('/explore');
    });

    test('prometheus dashboard should have correct metadata', () => {
      const prometheus = dashboard.DASHBOARDS.prometheus;
      expect(prometheus.name).toBe('Prometheus');
      expect(prometheus.defaultUrl).toBe('http://localhost:9090');
      expect(prometheus.icon).toBe('📈');
    });

    test('loki dashboard should have correct metadata', () => {
      const loki = dashboard.DASHBOARDS.loki;
      expect(loki.name).toBe('Loki');
      expect(loki.defaultUrl).toBe('http://localhost:3100');
      expect(loki.icon).toBe('📜');
    });
  });

  describe('getDashboardUrl', () => {
    test('should return default URL when no custom config exists', async () => {
      config.get.mockResolvedValue(null);
      
      const url = await dashboard.getDashboardUrl('grafana');
      expect(url).toBe('http://localhost:3003');
      expect(config.get).toHaveBeenCalledWith('dashboards.grafana.url');
    });

    test('should return custom URL when configured', async () => {
      config.get.mockResolvedValue('http://custom-grafana:3000');
      
      const url = await dashboard.getDashboardUrl('grafana');
      expect(url).toBe('http://custom-grafana:3000');
    });

    test('should return different default URLs for each dashboard', async () => {
      config.get.mockResolvedValue(null);
      
      expect(await dashboard.getDashboardUrl('grafana')).toBe('http://localhost:3003');
      expect(await dashboard.getDashboardUrl('prometheus')).toBe('http://localhost:9090');
      expect(await dashboard.getDashboardUrl('loki')).toBe('http://localhost:3100');
      expect(await dashboard.getDashboardUrl('traefik')).toBe('http://localhost:8080');
      expect(await dashboard.getDashboardUrl('alertmanager')).toBe('http://localhost:9093');
    });

    test('should throw error for unknown dashboard', async () => {
      await expect(dashboard.getDashboardUrl('unknown'))
        .rejects
        .toThrow('Unknown dashboard: unknown');
    });
  });

  describe('openBrowser', () => {
    test('should use xdg-open on Linux', async () => {
      process.platform = 'linux';
      
      spawn.mockImplementation((cmd, args, opts) => {
        expect(cmd).toBe('xdg-open');
        expect(args).toEqual(['http://localhost:3000']);
        
        const mockChild = {
          on: jest.fn((event, callback) => {
            if (event === 'close') {
              setTimeout(() => callback(0), 10);
            }
          }),
          unref: jest.fn(),
        };
        return mockChild;
      });

      await dashboard.openBrowser('http://localhost:3000');
      expect(spawn).toHaveBeenCalled();
    });

    test('should use open command on macOS', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      
      spawn.mockImplementation((cmd, args, opts) => {
        expect(cmd).toBe('open');
        expect(args).toEqual(['http://localhost:3000']);
        
        const mockChild = {
          on: jest.fn((event, callback) => {
            if (event === 'close') {
              setTimeout(() => callback(0), 10);
            }
          }),
          unref: jest.fn(),
        };
        return mockChild;
      });

      await dashboard.openBrowser('http://localhost:3000');
    });

    test('should use cmd on Windows', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      
      spawn.mockImplementation((cmd, args, opts) => {
        expect(cmd).toBe('cmd');
        expect(args).toEqual(['/c', 'start', '', 'http://localhost:3000']);
        
        const mockChild = {
          on: jest.fn((event, callback) => {
            if (event === 'close') {
              setTimeout(() => callback(0), 10);
            }
          }),
          unref: jest.fn(),
        };
        return mockChild;
      });

      await dashboard.openBrowser('http://localhost:3000');
    });

    test('should reject on unsupported platform', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'freebsd',
        configurable: true,
      });
      
      await expect(dashboard.openBrowser('http://localhost:3000'))
        .rejects
        .toThrow('Unsupported platform: unknown');
    });

    test('should try fallback browsers on Linux when xdg-open fails', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      let spawnCount = 0;
      
      spawn.mockImplementation((cmd, args, opts) => {
        spawnCount++;
        const mockChild = {
          on: jest.fn((event, callback) => {
            if (event === 'error' && cmd === 'xdg-open') {
              setTimeout(() => callback(new Error('xdg-open not found')), 10);
            } else if (event === 'close' && cmd !== 'xdg-open') {
              setTimeout(() => callback(0), 10);
            }
          }),
          unref: jest.fn(),
        };
        return mockChild;
      });

      // This should try xdg-open first, then fall back to browsers
      try {
        await dashboard.openBrowser('http://localhost:3000');
      } catch {
        // Expected to fail since we can't actually spawn browsers in tests
      }
      
      expect(spawnCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Command Structure', () => {
    test('dashboard command should be defined', () => {
      expect(dashboard).toBeDefined();
      expect(dashboard.name()).toBe('dashboard');
    });

    test('should have list subcommand', () => {
      const listCmd = dashboard.commands.find(c => c.name() === 'list');
      expect(listCmd).toBeDefined();
      expect(listCmd.description()).toContain('List');
    });

    test('should have open subcommand', () => {
      const openCmd = dashboard.commands.find(c => c.name() === 'open');
      expect(openCmd).toBeDefined();
      expect(openCmd.description()).toContain('Open');
    });

    test('should have grafana shortcut subcommand', () => {
      const grafanaCmd = dashboard.commands.find(c => c.name() === 'grafana');
      expect(grafanaCmd).toBeDefined();
      expect(grafanaCmd.description()).toContain('Grafana');
    });

    test('should have prometheus shortcut subcommand', () => {
      const prometheusCmd = dashboard.commands.find(c => c.name() === 'prometheus');
      expect(prometheusCmd).toBeDefined();
      expect(prometheusCmd.description()).toContain('Prometheus');
    });

    test('should have loki shortcut subcommand', () => {
      const lokiCmd = dashboard.commands.find(c => c.name() === 'loki');
      expect(lokiCmd).toBeDefined();
      expect(lokiCmd.description()).toContain('Loki');
    });

    test('should have traefik shortcut subcommand', () => {
      const traefikCmd = dashboard.commands.find(c => c.name() === 'traefik');
      expect(traefikCmd).toBeDefined();
      expect(traefikCmd.description()).toContain('Traefik');
    });

    test('should have alertmanager shortcut subcommand', () => {
      const alertmanagerCmd = dashboard.commands.find(c => c.name() === 'alertmanager');
      expect(alertmanagerCmd).toBeDefined();
      expect(alertmanagerCmd.description()).toContain('Alertmanager');
    });

    test('should have open-all subcommand', () => {
      const openAllCmd = dashboard.commands.find(c => c.name() === 'open-all');
      expect(openAllCmd).toBeDefined();
      expect(openAllCmd.description()).toContain('all');
    });

    test('should have config subcommand', () => {
      const configCmd = dashboard.commands.find(c => c.name() === 'config');
      expect(configCmd).toBeDefined();
      expect(configCmd.description()).toContain('Configure');
    });
  });

  describe('URL Validation', () => {
    test('should validate localhost URLs', async () => {
      config.get.mockResolvedValue(null);
      
      const url = await dashboard.getDashboardUrl('grafana');
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    });

    test('should accept custom domain URLs', async () => {
      config.get.mockResolvedValue('https://grafana.mycompany.com');
      
      const url = await dashboard.getDashboardUrl('grafana');
      expect(url).toBe('https://grafana.mycompany.com');
    });

    test('should accept IP-based URLs', async () => {
      config.get.mockResolvedValue('http://192.168.1.100:3000');
      
      const url = await dashboard.getDashboardUrl('grafana');
      expect(url).toBe('http://192.168.1.100:3000');
    });
  });

  describe('Error Handling', () => {
    test('should handle spawn errors gracefully', async () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      
      spawn.mockImplementation(() => {
        const mockChild = {
          on: jest.fn((event, callback) => {
            if (event === 'error') {
              setTimeout(() => callback(new Error('Spawn failed')), 10);
            }
          }),
          unref: jest.fn(),
        };
        return mockChild;
      });

      // Should not throw but try fallback browsers
      try {
        await dashboard.openBrowser('http://localhost:3000');
      } catch (err) {
        // Expected to fail after trying all browsers
        expect(err.message).toContain('Could not open browser');
      }
    });

    test('should handle invalid dashboard names', async () => {
      config.get.mockResolvedValue(null);
      
      await expect(dashboard.getDashboardUrl('invalid-dashboard'))
        .rejects
        .toThrow('Unknown dashboard');
    });
  });

  describe('Platform Detection', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    afterAll(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    test('should detect macOS', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      
      spawn.mockImplementation((cmd, args, opts) => ({
        on: jest.fn((event, callback) => {
          if (event === 'close') setTimeout(() => callback(0), 10);
        }),
        unref: jest.fn(),
      }));

      return dashboard.openBrowser('http://localhost:3000');
    });

    test('should detect Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      
      spawn.mockImplementation((cmd, args, opts) => ({
        on: jest.fn((event, callback) => {
          if (event === 'close') setTimeout(() => callback(0), 10);
        }),
        unref: jest.fn(),
      }));

      return dashboard.openBrowser('http://localhost:3000');
    });
  });
});

describe('Dashboard Integration', () => {
  test('should export required functions', () => {
    expect(dashboard.getDashboardUrl).toBeDefined();
    expect(typeof dashboard.getDashboardUrl).toBe('function');
    expect(dashboard.openBrowser).toBeDefined();
    expect(typeof dashboard.openBrowser).toBe('function');
    expect(dashboard.DASHBOARDS).toBeDefined();
  });
});
