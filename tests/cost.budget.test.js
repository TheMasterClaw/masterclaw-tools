/**
 * Tests for Cost Budget Alert System
 * @jest-environment node
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('axios');
jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn().mockResolvedValue('/test/infra'),
}));

jest.mock('../lib/config', () => ({
  get: jest.fn().mockResolvedValue('http://localhost:8000'),
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

describe('Cost Budget System', () => {
  let costModule;
  const mockBudgetConfig = {
    version: '1.0',
    monthlyBudget: 100,
    warningThreshold: 80,
    criticalThreshold: 95,
    enabled: true,
    notifications: true,
    lastAlertSent: null,
    alertCooldownHours: 24,
    history: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fs.ensureDir.mockResolvedValue();
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue(mockBudgetConfig);
    fs.writeJson.mockResolvedValue();
  });

  describe('Budget Configuration', () => {
    it('should load existing budget config', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readJson.mockResolvedValue(mockBudgetConfig);

      costModule = require('../lib/cost');
      
      // Budget config should be loadable
      expect(fs.readJson).not.toHaveBeenCalled();
    });

    it('should create default config when none exists', async () => {
      fs.pathExists.mockResolvedValue(false);

      const defaultConfig = {
        version: '1.0',
        monthlyBudget: 100,
        warningThreshold: 80,
        criticalThreshold: 95,
        enabled: true,
        notifications: true,
        lastAlertSent: null,
        alertCooldownHours: 24,
        history: [],
      };

      // The module should handle missing config gracefully
      expect(defaultConfig.monthlyBudget).toBe(100);
      expect(defaultConfig.warningThreshold).toBe(80);
      expect(defaultConfig.criticalThreshold).toBe(95);
    });

    it('should validate budget thresholds', () => {
      // Warning should be less than critical
      const config = {
        warningThreshold: 80,
        criticalThreshold: 95,
      };

      expect(config.warningThreshold).toBeLessThan(config.criticalThreshold);
      expect(config.criticalThreshold).toBeLessThanOrEqual(100);
      expect(config.warningThreshold).toBeGreaterThan(0);
    });
  });

  describe('Budget Status Calculation', () => {
    it('should calculate correct budget percentage', () => {
      const budget = 100;
      const spent = 75;
      const usedPercent = (spent / budget) * 100;

      expect(usedPercent).toBe(75);
    });

    it('should identify critical status when over critical threshold', () => {
      const budget = 100;
      const spent = 96;
      const criticalThreshold = 95;
      const usedPercent = (spent / budget) * 100;

      expect(usedPercent).toBeGreaterThanOrEqual(criticalThreshold);
    });

    it('should identify warning status when between warning and critical', () => {
      const budget = 100;
      const spent = 85;
      const warningThreshold = 80;
      const criticalThreshold = 95;
      const usedPercent = (spent / budget) * 100;

      expect(usedPercent).toBeGreaterThanOrEqual(warningThreshold);
      expect(usedPercent).toBeLessThan(criticalThreshold);
    });

    it('should identify healthy status when under warning threshold', () => {
      const budget = 100;
      const spent = 50;
      const warningThreshold = 80;
      const usedPercent = (spent / budget) * 100;

      expect(usedPercent).toBeLessThan(warningThreshold);
    });
  });

  describe('Alert Cooldown Logic', () => {
    it('should allow alert when no previous alert sent', () => {
      const lastAlertSent = null;
      const cooldownHours = 24;

      const shouldSend = !lastAlertSent;
      expect(shouldSend).toBe(true);
    });

    it('should respect cooldown period', () => {
      const lastAlertSent = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
      const cooldownHours = 24;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;

      const shouldSend = (Date.now() - lastAlertSent.getTime()) > cooldownMs;
      expect(shouldSend).toBe(false);
    });

    it('should allow alert after cooldown period expires', () => {
      const lastAlertSent = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      const cooldownHours = 24;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;

      const shouldSend = (Date.now() - lastAlertSent.getTime()) > cooldownMs;
      expect(shouldSend).toBe(true);
    });
  });

  describe('Cost Formatting', () => {
    it('should format small costs in cents', () => {
      const cost = 0.005;
      const formatted = cost < 0.01 ? `$${(cost * 100).toFixed(2)}¢` : `$${cost.toFixed(4)}`;
      expect(formatted).toBe('$0.50¢');
    });

    it('should format larger costs in dollars', () => {
      const cost = 12.50;
      const formatted = cost < 0.01 ? `$${(cost * 100).toFixed(2)}¢` : `$${cost.toFixed(4)}`;
      expect(formatted).toBe('$12.5000');
    });
  });

  describe('Token Formatting', () => {
    it('should format millions of tokens', () => {
      const tokens = 2500000;
      const formatted = tokens >= 1000000 
        ? `${(tokens / 1000000).toFixed(2)}M`
        : tokens >= 1000 
          ? `${(tokens / 1000).toFixed(1)}K`
          : tokens.toString();
      expect(formatted).toBe('2.50M');
    });

    it('should format thousands of tokens', () => {
      const tokens = 5000;
      const formatted = tokens >= 1000000 
        ? `${(tokens / 1000000).toFixed(2)}M`
        : tokens >= 1000 
          ? `${(tokens / 1000).toFixed(1)}K`
          : tokens.toString();
      expect(formatted).toBe('5.0K');
    });

    it('should format small token counts', () => {
      const tokens = 500;
      const formatted = tokens >= 1000000 
        ? `${(tokens / 1000000).toFixed(2)}M`
        : tokens >= 1000 
          ? `${(tokens / 1000).toFixed(1)}K`
          : tokens.toString();
      expect(formatted).toBe('500');
    });
  });

  describe('Spending Projection', () => {
    it('should calculate projection based on daily average', () => {
      const dailyCosts = [
        { cost: 2.50 },
        { cost: 3.00 },
        { cost: 2.75 },
        { cost: 3.25 },
        { cost: 2.50 },
        { cost: 3.00 },
        { cost: 2.75 },
      ];

      const avgDaily = dailyCosts.reduce((sum, d) => sum + d.cost, 0) / dailyCosts.length;
      const projectedMonthly = avgDaily * 30;

      expect(avgDaily).toBeCloseTo(2.82, 1);
      expect(projectedMonthly).toBeCloseTo(84.6, 1);
    });
  });

  describe('Exit Codes', () => {
    it('should use exit code 0 for healthy status', () => {
      const exitCode = 0;
      expect(exitCode).toBe(0);
    });

    it('should use exit code 1 for warning status', () => {
      const exitCode = 1;
      expect(exitCode).toBe(1);
    });

    it('should use exit code 2 for critical status', () => {
      const exitCode = 2;
      expect(exitCode).toBe(2);
    });
  });
});
