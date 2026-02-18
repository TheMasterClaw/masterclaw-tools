/**
 * Tests for k8s.js - Kubernetes deployment management
 */

const k8s = require('../lib/k8s');

// Mock dependencies
jest.mock('../lib/services');
jest.mock('../lib/error-handler');
jest.mock('../lib/logger');

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

// Mock fs-extra
jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  readdir: jest.fn(),
}));

// Mock inquirer
jest.mock('inquirer', () => ({
  prompt: jest.fn(),
}));

describe('k8s command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should export a Command instance', () => {
    expect(k8s).toBeDefined();
    expect(k8s.name()).toBe('k8s');
  });

  test('should have deploy command', () => {
    const deployCmd = k8s.commands.find(c => c.name() === 'deploy');
    expect(deployCmd).toBeDefined();
    expect(deployCmd.description()).toContain('Deploy');
  });

  test('should have delete command', () => {
    const deleteCmd = k8s.commands.find(c => c.name() === 'delete');
    expect(deleteCmd).toBeDefined();
    expect(deleteCmd.description()).toContain('Delete');
  });

  test('should have status command', () => {
    const statusCmd = k8s.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd.description()).toContain('status');
  });

  test('should have logs command', () => {
    const logsCmd = k8s.commands.find(c => c.name() === 'logs');
    expect(logsCmd).toBeDefined();
    expect(logsCmd.description()).toContain('logs');
  });

  test('should have exec command', () => {
    const execCmd = k8s.commands.find(c => c.name() === 'exec');
    expect(execCmd).toBeDefined();
    expect(execCmd.description()).toContain('Execute');
  });

  test('should have port-forward command', () => {
    const pfCmd = k8s.commands.find(c => c.name() === 'port-forward');
    expect(pfCmd).toBeDefined();
    expect(pfCmd.description()).toContain('port');
  });

  test('should have scale command', () => {
    const scaleCmd = k8s.commands.find(c => c.name() === 'scale');
    expect(scaleCmd).toBeDefined();
    expect(scaleCmd.description()).toContain('Scale');
  });

  test('should have update command', () => {
    const updateCmd = k8s.commands.find(c => c.name() === 'update');
    expect(updateCmd).toBeDefined();
    expect(updateCmd.description()).toContain('Update');
  });

  test('should have cluster-info command', () => {
    const clusterCmd = k8s.commands.find(c => c.name() === 'cluster-info');
    expect(clusterCmd).toBeDefined();
    expect(clusterCmd.description()).toContain('cluster');
  });

  test('should have default namespace option', () => {
    const namespaceOpt = k8s.options.find(o => o.long === '--namespace');
    expect(namespaceOpt).toBeDefined();
    expect(namespaceOpt.defaultValue).toBe('masterclaw');
  });
});

describe('k8s deploy command options', () => {
  test('should have env option', () => {
    const deployCmd = k8s.commands.find(c => c.name() === 'deploy');
    const envOpt = deployCmd.options.find(o => o.long === '--env');
    expect(envOpt).toBeDefined();
  });

  test('should have method option', () => {
    const deployCmd = k8s.commands.find(c => c.name() === 'deploy');
    const methodOpt = deployCmd.options.find(o => o.long === '--method');
    expect(methodOpt).toBeDefined();
    expect(methodOpt.defaultValue).toBe('kustomize');
  });

  test('should have dry-run option', () => {
    const deployCmd = k8s.commands.find(c => c.name() === 'deploy');
    const dryRunOpt = deployCmd.options.find(o => o.long === '--dry-run');
    expect(dryRunOpt).toBeDefined();
  });
});

describe('k8s logs command options', () => {
  test('should have component option', () => {
    const logsCmd = k8s.commands.find(c => c.name() === 'logs');
    const compOpt = logsCmd.options.find(o => o.long === '--component');
    expect(compOpt).toBeDefined();
  });

  test('should have follow option', () => {
    const logsCmd = k8s.commands.find(c => c.name() === 'logs');
    const followOpt = logsCmd.options.find(o => o.long === '--follow');
    expect(followOpt).toBeDefined();
    expect(followOpt.defaultValue).toBe(false);
  });

  test('should have since option', () => {
    const logsCmd = k8s.commands.find(c => c.name() === 'logs');
    const sinceOpt = logsCmd.options.find(o => o.long === '--since');
    expect(sinceOpt).toBeDefined();
  });

  test('should have tail option', () => {
    const logsCmd = k8s.commands.find(c => c.name() === 'logs');
    const tailOpt = logsCmd.options.find(o => o.long === '--tail');
    expect(tailOpt).toBeDefined();
    expect(tailOpt.defaultValue).toBe('100');
  });
});
