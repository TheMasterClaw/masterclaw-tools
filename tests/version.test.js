/**
 * Tests for the version command
 */

const { 
  compareVersions, 
  getCliVersion,
  getInfraVersion,
  getCoreVersion,
} = require('../lib/version');
const path = require('path');

describe('Version Command', () => {
  describe('compareVersions', () => {
    test('returns 0 for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('2.5.1', '2.5.1')).toBe(0);
    });

    test('returns positive when v1 > v2', () => {
      expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
      expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    });

    test('returns negative when v1 < v2', () => {
      expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0);
      expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    });

    test('handles v prefix', () => {
      expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('v1.1.0', 'v1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', 'v1.1.0')).toBeLessThan(0);
    });

    test('handles different length versions', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
      expect(compareVersions('1', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0);
    });
  });

  describe('getCliVersion', () => {
    test('returns CLI version info', async () => {
      const version = await getCliVersion();
      
      expect(version).toHaveProperty('name', 'masterclaw-tools');
      expect(version).toHaveProperty('displayName', 'CLI Tools');
      expect(version).toHaveProperty('version');
      expect(version).toHaveProperty('source', 'package.json');
      expect(version).toHaveProperty('path');
      
      // Version should be a valid semver-like string
      expect(version.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getCoreVersion', () => {
    test('handles API not running gracefully', async () => {
      const version = await getCoreVersion();
      
      expect(version).toHaveProperty('name', 'masterclaw-core');
      expect(version).toHaveProperty('displayName', 'AI Core');
      expect(version).toHaveProperty('version');
    });
  });

  describe('getInfraVersion', () => {
    test('returns infrastructure version when found', async () => {
      const version = await getInfraVersion();
      
      expect(version).toHaveProperty('name', 'masterclaw-infrastructure');
      expect(version).toHaveProperty('displayName', 'Infrastructure');
      expect(version).toHaveProperty('version');
      expect(version).toHaveProperty('source');
    });
  });
});
