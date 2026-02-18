/**
 * Tests for Docker status timeout protection
 * Run with: npm test -- exec.timeout.test.js
 * 
 * These tests verify that isContainerRunning and getRunningContainers
 * have proper timeout protection to prevent indefinite hangs when
 * the Docker daemon is unresponsive.
 */

const {
  isContainerRunning,
  getRunningContainers,
  DOCKER_STATUS_TIMEOUT_MS,
} = require('../lib/exec');

const { spawn } = require('child_process');

// Mock child_process to simulate hanging/spawn behavior
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('Docker Status Timeout Protection', () => {
  let mockProcess;
  let eventHandlers;
  let timeoutCallbacks;

  beforeEach(() => {
    jest.clearAllMocks();
    eventHandlers = {};
    timeoutCallbacks = [];

    // Create a mock process that captures event handlers
    mockProcess = {
      stdout: { on: jest.fn((event, handler) => {
        eventHandlers[`stdout:${event}`] = handler;
      }) },
      stderr: { on: jest.fn((event, handler) => {
        eventHandlers[`stderr:${event}`] = handler;
      }) },
      on: jest.fn((event, handler) => {
        eventHandlers[event] = handler;
      }),
      kill: jest.fn((signal) => {
        mockProcess.killed = true;
        mockProcess.killSignal = signal;
      }),
      killed: false,
    };

    // Mock setTimeout to capture callbacks
    jest.useFakeTimers();

    spawn.mockReturnValue(mockProcess);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =============================================================================
  // DOCKER_STATUS_TIMEOUT_MS Constant Tests
  // =============================================================================

  describe('DOCKER_STATUS_TIMEOUT_MS', () => {
    test('is exported and has correct value', () => {
      expect(DOCKER_STATUS_TIMEOUT_MS).toBeDefined();
      expect(DOCKER_STATUS_TIMEOUT_MS).toBe(10000); // 10 seconds
    });

    test('is a reasonable timeout value (5-30 seconds)', () => {
      expect(DOCKER_STATUS_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
      expect(DOCKER_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    });
  });

  // =============================================================================
  // isContainerRunning Timeout Tests
  // =============================================================================

  describe('isContainerRunning timeout protection', () => {
    test('resolves with false when Docker command times out', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Fast-forward past the timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    test('kills the process with SIGTERM on timeout', async () => {
      const resultPromise = isContainerRunning('mc-core');

      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      await resultPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    test('forces SIGKILL if process does not terminate after SIGTERM', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Advance past initial timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      // Process hasn't been killed yet (simulated)
      mockProcess.killed = false;

      // Advance past the force kill timeout (1000ms)
      jest.advanceTimersByTime(1100);

      await resultPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('accepts custom timeout parameter', async () => {
      const customTimeout = 5000; // 5 seconds
      const resultPromise = isContainerRunning('mc-core', customTimeout);

      // Should not timeout yet at 4 seconds
      jest.advanceTimersByTime(4000);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Should timeout at 5 seconds
      jest.advanceTimersByTime(1500);

      const result = await resultPromise;
      expect(result).toBe(false);
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    test('clears timeout when process completes normally', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Simulate successful completion before timeout
      eventHandlers['close'](0);

      const result = await resultPromise;
      expect(result).toBe(false); // Container not found in output

      // Advance time past when timeout would have fired
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 1000);

      // Process should not have been killed (timeout was cleared)
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    test('handles stderr output during timeout', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Simulate stderr output
      eventHandlers['stderr:data']('Error: Cannot connect to Docker daemon');

      // Trigger timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    test('handles process error event before timeout', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Simulate error before timeout
      eventHandlers['error'](new Error('Spawn failed'));

      const result = await resultPromise;
      expect(result).toBe(false);

      // Clear timeout should have been called
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    test('ignores close event after timeout already fired', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Trigger timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      // Then try to fire close event (should be ignored)
      eventHandlers['close'](0);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    test('ignores error event after timeout already fired', async () => {
      const resultPromise = isContainerRunning('mc-core');

      // Trigger timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      // Then try to fire error event (should be ignored)
      eventHandlers['error'](new Error('Late error'));

      const result = await resultPromise;
      expect(result).toBe(false);
    });
  });

  // =============================================================================
  // getRunningContainers Timeout Tests
  // =============================================================================

  describe('getRunningContainers timeout protection', () => {
    test('resolves with empty array when Docker command times out', async () => {
      const resultPromise = getRunningContainers();

      // Fast-forward past the timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      const result = await resultPromise;
      expect(result).toEqual([]);
    });

    test('kills the process with SIGTERM on timeout', async () => {
      const resultPromise = getRunningContainers();

      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      await resultPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    test('forces SIGKILL if process does not terminate after SIGTERM', async () => {
      const resultPromise = getRunningContainers();

      // Advance past initial timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      // Process hasn't been killed yet (simulated)
      mockProcess.killed = false;

      // Advance past the force kill timeout (1000ms)
      jest.advanceTimersByTime(1100);

      await resultPromise;
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('accepts custom timeout parameter', async () => {
      const customTimeout = 3000; // 3 seconds
      const resultPromise = getRunningContainers(customTimeout);

      // Should not timeout yet at 2 seconds
      jest.advanceTimersByTime(2000);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Should timeout at 3 seconds
      jest.advanceTimersByTime(1500);

      const result = await resultPromise;
      expect(result).toEqual([]);
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    test('clears timeout when process completes normally', async () => {
      const resultPromise = getRunningContainers();

      // Simulate successful completion before timeout
      eventHandlers['stdout:data']('mc-core|Up 3 hours\n');
      eventHandlers['close'](0);

      const result = await resultPromise;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('mc-core');

      // Advance time past when timeout would have fired
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 1000);

      // Process should not have been killed (timeout was cleared)
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    test('handles stderr output during timeout', async () => {
      const resultPromise = getRunningContainers();

      // Simulate stderr output
      eventHandlers['stderr:data']('Error: Docker daemon not responding');

      // Trigger timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      const result = await resultPromise;
      expect(result).toEqual([]);
    });

    test('handles process error event before timeout', async () => {
      const resultPromise = getRunningContainers();

      // Simulate error before timeout
      eventHandlers['error'](new Error('Docker not available'));

      const result = await resultPromise;
      expect(result).toEqual([]);

      // Clear timeout should have been called
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    test('ignores close event after timeout already fired', async () => {
      const resultPromise = getRunningContainers();

      // Trigger timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS + 100);

      // Then try to fire close event (should be ignored)
      eventHandlers['close'](0);

      const result = await resultPromise;
      expect(result).toEqual([]);
    });

    test('parses container output correctly even with custom timeout', async () => {
      const customTimeout = 15000;
      const resultPromise = getRunningContainers(customTimeout);

      // Simulate output with multiple containers
      eventHandlers['stdout:data'](
        'mc-core|Up 3 hours\nmc-backend|Up 2 hours\nmc-gateway|Up 1 hour\n'
      );
      eventHandlers['close'](0);

      const result = await resultPromise;
      expect(result).toHaveLength(3);
      expect(result.map(c => c.name)).toEqual(['mc-core', 'mc-backend', 'mc-gateway']);
    });
  });

  // =============================================================================
  // Integration Behavior Tests
  // =============================================================================

  describe('Timeout protection integration', () => {
    test('isContainerRunning uses DOCKER_STATUS_TIMEOUT_MS as default', async () => {
      isContainerRunning('mc-core');

      // Should not trigger before the default timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS - 100);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Should trigger at/after the default timeout
      jest.advanceTimersByTime(200);

      // Force the promise to resolve
      await Promise.resolve();

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    test('getRunningContainers uses DOCKER_STATUS_TIMEOUT_MS as default', async () => {
      getRunningContainers();

      // Should not trigger before the default timeout
      jest.advanceTimersByTime(DOCKER_STATUS_TIMEOUT_MS - 100);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      // Should trigger at/after the default timeout
      jest.advanceTimersByTime(200);

      // Force the promise to resolve
      await Promise.resolve();

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    test('both functions can operate with different timeouts concurrently', async () => {
      const promise1 = isContainerRunning('mc-core', 5000);
      const promise2 = getRunningContainers(10000);

      // First should timeout at 5s
      jest.advanceTimersByTime(5100);
      const result1 = await promise1;
      expect(result1).toBe(false);

      // Second should still be running
      expect(mockProcess.kill).toHaveBeenCalledTimes(1);

      // Second times out at 10s
      jest.advanceTimersByTime(5100);
      const result2 = await promise2;
      expect(result2).toEqual([]);

      expect(mockProcess.kill).toHaveBeenCalledTimes(2);
    });
  });
});
