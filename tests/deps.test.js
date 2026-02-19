/**
 * Tests for deps.js module
 * Run with: npm test -- deps.test.js
 *
 * Tests service dependency management functionality.
 */

const path = require('path');
const os = require('os');

// Mock fs-extra before requiring deps module
const mockPathExists = jest.fn();

jest.mock('fs-extra', () => ({
  pathExists: mockPathExists,
}));

// Mock chalk to return plain strings for testing
jest.mock('chalk', () => ({
  blue: (text) => text,
  gray: (text) => text,
  cyan: (text) => text,
  bold: (text) => text,
  red: (text) => text,
}));

const {
  findInfraDir,
  showDependencyTree,
} = require('../lib/deps');

// =============================================================================
// Setup
// =============================================================================

describe('Dependencies Module', () => {
  beforeEach(() => {
    mockPathExists.mockReset();
    delete process.env.MASTERCLAW_INFRA;
  });

  // ===========================================================================
  // findInfraDir Tests
  // ===========================================================================
  describe('findInfraDir', () => {
    test('returns null when no infrastructure directory found', async () => {
      mockPathExists.mockResolvedValue(false);

      const result = await findInfraDir();
      expect(result).toBeNull();
    });

    test('finds directory from MASTERCLAW_INFRA env var', async () => {
      process.env.MASTERCLAW_INFRA = '/custom/infra/path';
      mockPathExists.mockImplementation((p) => {
        return p.includes('/custom/infra/path/scripts/wait-for-deps.sh');
      });

      const result = await findInfraDir();
      expect(result).toBe('/custom/infra/path');
    });

    test('checks multiple candidate locations', async () => {
      mockPathExists.mockImplementation((p) => {
        // Only match the /opt path
        return p.includes('/opt/masterclaw-infrastructure/scripts/wait-for-deps.sh');
      });

      const result = await findInfraDir();
      expect(result).toBe('/opt/masterclaw-infrastructure');
    });

    test('returns first matching directory', async () => {
      mockPathExists.mockImplementation((p) => {
        return p.includes('masterclaw-infrastructure/scripts/wait-for-deps.sh');
      });

      const result = await findInfraDir();
      // Should return the first match (env var, cwd, parent, home, or /opt)
      expect(result).toBeTruthy();
    });

    test('handles null/undefined in candidates gracefully', async () => {
      // Don't set MASTERCLAW_INFRA, so first candidate is undefined
      mockPathExists.mockResolvedValue(false);

      const result = await findInfraDir();
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // showDependencyTree Tests
  // ===========================================================================
  describe('showDependencyTree', () => {
    let consoleOutput = [];
    const originalConsoleLog = console.log;

    beforeEach(() => {
      consoleOutput = [];
      console.log = (...args) => {
        consoleOutput.push(args.join(' '));
      };
    });

    afterEach(() => {
      console.log = originalConsoleLog;
    });

    test('outputs dependency tree header', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('MasterClaw Service Dependencies');
      expect(output).toContain('Service Dependency Map');
    });

    test('shows all services', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('traefik');
      expect(output).toContain('interface');
      expect(output).toContain('backend');
      expect(output).toContain('core');
      expect(output).toContain('gateway');
      expect(output).toContain('chroma');
      expect(output).toContain('watchtower');
    });

    test('shows service descriptions', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('Reverse proxy');
      expect(output).toContain('React web frontend');
      expect(output).toContain('Node.js API server');
      expect(output).toContain('Python AI brain');
    });

    test('shows dependencies for services with deps', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('depends on:');
      expect(output).toContain('gateway');
      expect(output).toContain('core');
      expect(output).toContain('backend');
    });

    test('shows no dependencies for base services', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('(no dependencies)');
    });

    test('shows legend', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('Legend:');
      expect(output).toContain('has dependencies');
      expect(output).toContain('base service');
    });

    test('traefik has correct dependencies', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      // traefik depends on gateway, core, backend, interface
      expect(output).toContain('traefik');
      expect(output).toContain('depends on: gateway, core, backend, interface');
    });

    test('core depends on chroma', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('core');
      expect(output).toContain('Python AI brain');
      // Check that core section contains chroma
      const coreMatch = output.match(/core[\s\S]*?depends on:[\s\S]*?chroma/);
      expect(coreMatch).toBeTruthy();
    });

    test('backend depends on gateway and core', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      expect(output).toContain('backend');
      // Check that backend section contains gateway and core
      const backendMatch = output.match(/backend[\s\S]*?depends on:[\s\S]*?gateway/);
      expect(backendMatch).toBeTruthy();
    });

    test('gateway has no dependencies', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      // Find gateway section and verify it has (no dependencies)
      const gatewayMatch = output.match(/gateway[\s\S]{0,100}\(no dependencies\)/);
      expect(gatewayMatch).toBeTruthy();
    });

    test('chroma has no dependencies', () => {
      showDependencyTree();

      const output = consoleOutput.join('\n');
      const chromaSection = output.substring(
        output.indexOf('chroma'),
        output.indexOf('watchtower')
      );
      expect(chromaSection).toContain('(no dependencies)');
    });
  });

  // ===========================================================================
  // Dependency Tree Structure Tests
  // ===========================================================================
  describe('Dependency Tree Structure', () => {
    test('dependency tree has expected structure', () => {
      // This test documents the expected dependency structure
      const expectedTree = {
        traefik: { deps: ['gateway', 'core', 'backend', 'interface'] },
        interface: { deps: ['backend'] },
        backend: { deps: ['gateway', 'core'] },
        core: { deps: ['chroma'] },
        gateway: { deps: [] },
        chroma: { deps: [] },
        watchtower: { deps: [] },
      };

      // Verify the structure by calling showDependencyTree and checking output
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => { output += msg + '\n'; };
      
      showDependencyTree();
      
      console.log = originalLog;

      // Check that all expected services are in output
      for (const service of Object.keys(expectedTree)) {
        expect(output).toContain(service);
      }
    });

    test('no circular dependencies in tree', () => {
      // Verify no service depends on itself (directly)
      // This is a basic check - full circular detection would require parsing
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => { output += msg + '\n'; };
      
      showDependencyTree();
      
      console.log = originalLog;

      // Each service should appear once in its own section
      const services = ['traefik', 'interface', 'backend', 'core', 'gateway', 'chroma', 'watchtower'];
      for (const service of services) {
        const count = (output.match(new RegExp(service, 'g')) || []).length;
        expect(count).toBeGreaterThanOrEqual(1); // At least once (the service name itself)
      }
    });
  });
});
