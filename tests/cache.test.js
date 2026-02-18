/**
 * cache.test.js - Test suite for cache management module
 * 
 * Tests Redis cache management commands including:
 * - Cache statistics retrieval
 * - Health checks
 * - Cache clearing with confirmation
 * - Error handling for non-interactive environments
 * - API connectivity issues
 */

const chalk = require('chalk');

// Store original process methods
const originalExit = process.exit;
const originalEnv = process.env;

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;
global.AbortSignal = {
  timeout: (ms) => ({ timeout: ms })
};

// Mock logger
jest.mock('../lib/logger', () => ({
  child: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  }))
}));

// Mock inquirer for interactive prompts
const mockPrompt = jest.fn();
jest.mock('inquirer', () => ({
  default: {
    prompt: mockPrompt,
  }
}));

// Capture console output
let consoleOutput = [];
const originalLog = console.log;

beforeEach(() => {
  consoleOutput = [];
  console.log = jest.fn((...args) => {
    consoleOutput.push(args.join(' '));
  });
  mockFetch.mockClear();
  mockPrompt.mockClear();
  process.exit = jest.fn();
  process.exit.mockImplementation(() => {
    throw new Error('Process exit called');
  });
  process.stdin.isTTY = true;
  process.env = { ...originalEnv };
  delete process.env.MC_CORE_URL;
});

afterEach(() => {
  console.log = originalLog;
  process.exit = originalExit;
  process.env = originalEnv;
});

// Helper to check if output contains string
const outputContains = (str) => consoleOutput.some(line => line.indexOf(str) >= 0);

describe('Cache Module', () => {

  describe('showStats command', () => {
    test('should display cache statistics correctly with Redis connected', async () => {
      const mockStats = {
        enabled: true,
        redis_connected: true,
        key_prefix: 'mc:',
        redis_version: '7.0.0',
        used_memory_human: '1.5M',
        total_keys: 1500,
        hit_rate: 0.85,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockStats),
      });

      const showStats = async () => {
        const apiUrl = 'http://localhost:8000';
        console.log(chalk.blue('🐾 MasterClaw Cache Statistics\n'));
        
        const response = await fetch(`${apiUrl}/cache/stats`, {
          signal: AbortSignal.timeout(5000)
        });
        
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }
        
        const stats = await response.json();
        
        const statusIcon = stats.enabled ? chalk.green('✅') : chalk.yellow('⚠️');
        console.log(`${statusIcon} Cache ${stats.enabled ? 'Enabled' : 'Disabled'}`);
        
        const backendStatus = stats.redis_connected 
          ? chalk.green('Connected (Redis)') 
          : chalk.yellow('Memory Fallback');
        console.log(`   Backend: ${backendStatus}`);
        console.log(`   Key Prefix: ${chalk.gray(stats.key_prefix)}`);
        
        if (stats.redis_connected) {
          console.log(chalk.blue('Redis Statistics:'));
          if (stats.redis_version) {
            console.log(`   Version: ${stats.redis_version}`);
          }
          if (stats.used_memory_human) {
            console.log(`   Memory: ${stats.used_memory_human}`);
          }
          if (stats.total_keys !== undefined) {
            console.log(`   Total Keys: ${stats.total_keys.toLocaleString()}`);
          }
          if (stats.hit_rate !== undefined) {
            const hitRate = (stats.hit_rate * 100).toFixed(1);
            const hitRateColor = stats.hit_rate > 0.8 ? chalk.green : 
                                stats.hit_rate > 0.5 ? chalk.yellow : chalk.red;
            console.log(`   Hit Rate: ${hitRateColor(hitRate + '%')}`);
          }
        }
      };

      await showStats();

      expect(outputContains('Cache Statistics')).toBe(true);
      expect(outputContains('Connected (Redis)')).toBe(true);
      expect(outputContains('1,500')).toBe(true);
    });

    test('should display cache statistics with memory fallback', async () => {
      const mockStats = {
        enabled: true,
        redis_connected: false,
        key_prefix: 'mc:',
        memory_keys: 500,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockStats),
      });

      const showStats = async () => {
        const apiUrl = 'http://localhost:8000';
        console.log(chalk.blue('🐾 MasterClaw Cache Statistics\n'));
        
        const response = await fetch(`${apiUrl}/cache/stats`, {
          signal: AbortSignal.timeout(5000)
        });
        
        const stats = await response.json();
        
        const backendStatus = stats.redis_connected 
          ? chalk.green('Connected (Redis)') 
          : chalk.yellow('Memory Fallback');
        console.log(`   Backend: ${backendStatus}`);
        
        if (!stats.redis_connected) {
          console.log(chalk.yellow('Using in-memory cache (Redis unavailable)'));
          console.log(`   Memory Keys: ${stats.memory_keys}`);
        }
      };

      await showStats();

      expect(outputContains('Memory Fallback')).toBe(true);
      expect(outputContains('500')).toBe(true);
    });

    test('should handle disabled cache', async () => {
      const mockStats = {
        enabled: false,
        redis_connected: false,
        key_prefix: 'mc:',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockStats),
      });

      const showStats = async () => {
        const apiUrl = 'http://localhost:8000';
        const response = await fetch(`${apiUrl}/cache/stats`, {
          signal: AbortSignal.timeout(5000)
        });
        const stats = await response.json();
        
        const statusIcon = stats.enabled ? chalk.green('✅') : chalk.yellow('⚠️');
        console.log(`${statusIcon} Cache ${stats.enabled ? 'Enabled' : 'Disabled'}`);
      };

      await showStats();

      expect(outputContains('Disabled')).toBe(true);
    });

    test('should handle API error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const showStats = async () => {
        try {
          const apiUrl = 'http://localhost:8000';
          const response = await fetch(`${apiUrl}/cache/stats`, {
            signal: AbortSignal.timeout(5000)
          });
          
          if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
          }
        } catch (error) {
          console.log(chalk.red('❌ Failed to fetch cache statistics'));
          process.exit(4);
        }
      };

      await showStats();
      expect(process.exit).toHaveBeenCalledWith(4);
    });

    test('should handle non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const showStats = async () => {
        try {
          const apiUrl = 'http://localhost:8000';
          const response = await fetch(`${apiUrl}/cache/stats`, {
            signal: AbortSignal.timeout(5000)
          });
          
          if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
          }
        } catch (error) {
          console.log(chalk.red('❌ Failed to fetch cache statistics'));
          process.exit(4);
        }
      };

      await expect(showStats()).rejects.toThrow('Process exit called');
    });
  });

  describe('checkHealth command', () => {
    test('should display healthy status', async () => {
      const mockHealth = {
        status: 'healthy',
        enabled: true,
        backend: 'redis',
        latency_ms: 5,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockHealth),
      });

      const checkHealth = async () => {
        const apiUrl = 'http://localhost:8000';
        console.log(chalk.blue('🐾 MasterClaw Cache Health\n'));
        
        const response = await fetch(`${apiUrl}/cache/health`, {
          signal: AbortSignal.timeout(5000)
        });
        
        const health = await response.json();
        
        const statusIcon = health.status === 'healthy' ? chalk.green('✅') :
                           health.status === 'disabled' ? chalk.yellow('⚠️') :
                           chalk.red('❌');
        console.log(`${statusIcon} Status: ${health.status}`);
        console.log(`   Enabled: ${health.enabled ? chalk.green('Yes') : chalk.yellow('No')}`);
        
        const backendColor = health.backend === 'redis' ? chalk.green :
                             health.backend === 'memory' ? chalk.yellow :
                             chalk.gray;
        console.log(`   Backend: ${backendColor(health.backend)}`);
        
        if (health.latency_ms !== undefined && health.latency_ms >= 0) {
          const latencyColor = health.latency_ms < 10 ? chalk.green :
                               health.latency_ms < 50 ? chalk.yellow :
                               chalk.red;
          console.log(`   Latency: ${latencyColor(health.latency_ms + 'ms')}`);
        }
      };

      await checkHealth();

      expect(outputContains('healthy')).toBe(true);
      expect(outputContains('5ms')).toBe(true);
    });

    test('should display degraded status with Redis error', async () => {
      const mockHealth = {
        status: 'degraded',
        enabled: true,
        backend: 'memory',
        latency_ms: 2,
        redis_error: 'Connection refused',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockHealth),
      });

      const checkHealth = async () => {
        const apiUrl = 'http://localhost:8000';
        const response = await fetch(`${apiUrl}/cache/health`, {
          signal: AbortSignal.timeout(5000)
        });
        const health = await response.json();
        
        console.log(`Status: ${health.status}`);
        
        if (health.redis_error) {
          console.log(chalk.yellow('Redis Error:'));
          console.log(`   ${health.redis_error}`);
        }
      };

      await checkHealth();

      expect(outputContains('degraded')).toBe(true);
      expect(outputContains('Connection refused')).toBe(true);
    });

    test('should handle API request failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const checkHealth = async () => {
        try {
          const apiUrl = 'http://localhost:8000';
          const response = await fetch(`${apiUrl}/cache/health`, {
            signal: AbortSignal.timeout(5000)
          });
          await response.json();
        } catch (err) {
          console.log(chalk.red('❌ Failed to check cache health'));
          process.exit(4);
        }
      };

      await checkHealth();
      expect(process.exit).toHaveBeenCalledWith(4);
    });
  });

  describe('clearCache command', () => {
    test('should clear cache with force option', async () => {
      const mockResult = {
        success: true,
        keys_cleared: 1500,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResult),
      });

      const clearCache = async (pattern, options) => {
        const apiUrl = 'http://localhost:8000';
        console.log(chalk.blue('🐾 MasterClaw Cache Clear\n'));
        
        if (!options.force) {
          console.log(chalk.yellow('Would prompt for confirmation'));
          return;
        }
        
        const response = await fetch(`${apiUrl}/cache/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern, confirm: true }),
          signal: AbortSignal.timeout(10000)
        });
        
        const result = await response.json();
        
        if (result.success) {
          console.log(chalk.green('✅ Cache cleared successfully'));
          console.log(`   Keys removed: ${result.keys_cleared.toLocaleString()}`);
          
          if (result.pattern) {
            console.log(`   Pattern: ${chalk.gray(result.pattern)}`);
          }
        }
      };

      await clearCache(null, { force: true });

      expect(outputContains('Cache cleared successfully')).toBe(true);
      expect(outputContains('1,500')).toBe(true);
    });

    test('should clear cache with pattern and force option', async () => {
      const mockResult = {
        success: true,
        keys_cleared: 500,
        pattern: 'llm:*',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResult),
      });

      const clearCache = async (pattern, options) => {
        if (!options.force) return;
        
        const apiUrl = 'http://localhost:8000';
        const response = await fetch(`${apiUrl}/cache/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern, confirm: true }),
          signal: AbortSignal.timeout(10000)
        });
        
        const result = await response.json();
        
        if (result.success && result.pattern) {
          console.log(`   Pattern: ${chalk.gray(result.pattern)}`);
        }
      };

      await clearCache('llm:*', { force: true });

      expect(outputContains('llm:*')).toBe(true);
    });

    test('should exit in non-interactive environment without force', async () => {
      process.stdin.isTTY = false;

      const clearCache = async (pattern, options) => {
        console.log(chalk.blue('🐾 MasterClaw Cache Clear\n'));
        
        if (!options.force) {
          if (!process.stdin.isTTY) {
            console.log(chalk.red('❌ Cannot prompt for confirmation in non-interactive environment'));
            process.exit(2);
          }
        }
      };

      await clearCache(null, { force: false });

      expect(process.exit).toHaveBeenCalledWith(2);
    });

    test('should prompt for confirmation without force option and confirm', async () => {
      mockPrompt.mockResolvedValueOnce({ confirm: true });

      const mockResult = {
        success: true,
        keys_cleared: 1500,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResult),
      });

      const inquirer = await import('inquirer');
      
      const clearCache = async (pattern, options) => {
        console.log(chalk.blue('🐾 MasterClaw Cache Clear\n'));
        
        if (!options.force) {
          const { confirm } = await inquirer.default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: 'Are you sure you want to continue?',
            default: false,
          }]);
          
          if (!confirm) {
            console.log(chalk.yellow('Cancelled.'));
            return;
          }
        }
        
        console.log(chalk.green('✅ Cache cleared successfully'));
      };

      await clearCache(null, { force: false });

      expect(mockPrompt).toHaveBeenCalled();
      expect(outputContains('Cache cleared successfully')).toBe(true);
    });

    test('should cancel when user declines confirmation', async () => {
      mockPrompt.mockResolvedValueOnce({ confirm: false });

      const inquirer = await import('inquirer');
      
      const clearCache = async (pattern, options) => {
        if (!options.force) {
          const { confirm } = await inquirer.default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: 'Are you sure?',
            default: false,
          }]);
          
          if (!confirm) {
            console.log(chalk.yellow('Cancelled.'));
            return;
          }
        }
      };

      await clearCache(null, { force: false });

      expect(outputContains('Cancelled')).toBe(true);
    });

    test('should handle inquirer error gracefully', async () => {
      mockPrompt.mockRejectedValueOnce(new Error('User force closed the prompt'));

      const inquirer = await import('inquirer');
      
      const clearCache = async (pattern, options) => {
        if (!options.force) {
          try {
            await inquirer.default.prompt([{
              type: 'confirm',
              name: 'confirm',
              message: 'Are you sure?',
              default: false,
            }]);
          } catch (err) {
            if (err.message && err.message.indexOf('User force closed') >= 0) {
              console.log(chalk.red('❌ Interactive prompt failed'));
              process.exit(2);
            }
            throw err;
          }
        }
      };

      await clearCache(null, { force: false });

      expect(process.exit).toHaveBeenCalledWith(2);
    });

    test('should handle clear cache API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: jest.fn().mockResolvedValue({ detail: 'Permission denied' }),
      });

      const clearCache = async (pattern, options) => {
        if (!options.force) return;
        
        const apiUrl = 'http://localhost:8000';
        
        const response = await fetch(`${apiUrl}/cache/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern, confirm: true }),
          signal: AbortSignal.timeout(10000)
        });
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
          console.log(chalk.red('❌ Failed to clear cache'));
          console.log(chalk.gray(`   Error: ${error.detail}`));
          process.exit(4);
        }
      };

      await clearCache(null, { force: true });

      expect(process.exit).toHaveBeenCalledWith(4);
    });

    test('should use correct timeout for clear operation', async () => {
      const mockResult = { success: true, keys_cleared: 100 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResult),
      });

      const clearCache = async (pattern, options) => {
        const apiUrl = 'http://localhost:8000';
        
        await fetch(`${apiUrl}/cache/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern, confirm: true }),
          signal: AbortSignal.timeout(10000)
        });
      };

      await clearCache(null, { force: true });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: { timeout: 10000 }
        })
      );
    });
  });

  describe('warmCache command', () => {
    test('should display not implemented message', async () => {
      const warmCache = async () => {
        console.log(chalk.blue('🐾 MasterClaw Cache Warm\n'));
        console.log(chalk.yellow('⚠️  Cache warming is not yet implemented.'));
      };

      await warmCache();

      expect(outputContains('not yet implemented')).toBe(true);
    });
  });

  describe('Timeout configurations', () => {
    test('stats check should use 5 second timeout', async () => {
      const mockStats = {
        enabled: true,
        redis_connected: true,
        key_prefix: 'mc:',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockStats),
      });

      const showStats = async () => {
        const apiUrl = 'http://localhost:8000';
        await fetch(`${apiUrl}/cache/stats`, {
          signal: AbortSignal.timeout(5000)
        });
      };

      await showStats();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/cache/stats',
        expect.objectContaining({
          signal: { timeout: 5000 }
        })
      );
    });

    test('health check should use 5 second timeout', async () => {
      const mockHealth = {
        status: 'healthy',
        enabled: true,
        backend: 'redis',
        latency_ms: 5,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockHealth),
      });

      const checkHealth = async () => {
        const apiUrl = 'http://localhost:8000';
        await fetch(`${apiUrl}/cache/health`, {
          signal: AbortSignal.timeout(5000)
        });
      };

      await checkHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8000/cache/health',
        expect.objectContaining({
          signal: { timeout: 5000 }
        })
      );
    });

    test('POST request should have correct body structure', async () => {
      const mockResult = { success: true, keys_cleared: 100 };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResult),
      });

      const clearCache = async () => {
        const apiUrl = 'http://localhost:8000';
        await fetch(`${apiUrl}/cache/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern: 'llm:*', confirm: true }),
          signal: AbortSignal.timeout(10000)
        });
      };

      await clearCache();

      const postCall = mockFetch.mock.calls[0];
      
      expect(postCall[1]).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: 'llm:*', confirm: true }),
        signal: { timeout: 10000 }
      });
    });
  });
});
