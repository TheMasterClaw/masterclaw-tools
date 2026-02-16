/**
 * ssl.js - SSL Certificate Management for MasterClaw CLI
 * 
 * Provides commands to check SSL certificate expiration, renewal status,
 * and trigger certificate renewal across all MasterClaw domains.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const tls = require('tls');

const ssl = new Command('ssl');

// Default thresholds
const WARNING_DAYS = 14;
const CRITICAL_DAYS = 7;

/**
 * Find the infrastructure directory
 */
function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
  ];
  
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }
  
  // Try to find from git remote
  try {
    const gitRemote = execSync('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    if (gitRemote.includes('masterclaw-infrastructure')) {
      return process.cwd();
    }
  } catch (e) {
    // ignore
  }
  
  return null;
}

/**
 * Load domain from .env file
 */
function loadDomain() {
  const infraDir = findInfraDir();
  if (!infraDir) return 'localhost';
  
  const envFile = path.join(infraDir, '.env');
  if (fs.existsSync(envFile)) {
    try {
      const envContent = fs.readFileSync(envFile, 'utf8');
      const match = envContent.match(/DOMAIN=([^\s]+)/);
      if (match) return match[1];
    } catch (e) {
      // ignore
    }
  }
  return 'localhost';
}

/**
 * Check SSL certificate expiration for a domain
 */
async function checkCertExpiration(domain, port = 443) {
  return new Promise((resolve) => {
    // Skip localhost checks
    if (domain.includes('localhost')) {
      return resolve({ domain, days: -1, status: 'skipped', error: 'localhost' });
    }
    
    const options = {
      hostname: domain,
      port: port,
      method: 'GET',
      rejectUnauthorized: false, // Allow self-signed for checking
    };
    
    const req = https.request(options, (res) => {
      const cert = res.socket.getPeerCertificate();
      
      if (!cert || !cert.valid_to) {
        return resolve({ domain, days: -1, status: 'error', error: 'No certificate found' });
      }
      
      const expiryDate = new Date(cert.valid_to);
      const now = new Date();
      const daysUntil = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      let status = 'healthy';
      if (daysUntil <= 0) status = 'expired';
      else if (daysUntil <= CRITICAL_DAYS) status = 'critical';
      else if (daysUntil <= WARNING_DAYS) status = 'warning';
      
      resolve({
        domain,
        days: daysUntil,
        status,
        issuer: cert.issuer?.O || 'Unknown',
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        subject: cert.subject?.CN || domain,
      });
    });
    
    req.on('error', (err) => {
      resolve({ domain, days: -1, status: 'error', error: err.message });
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ domain, days: -1, status: 'error', error: 'Connection timeout' });
    });
    
    req.end();
  });
}

/**
 * Check all MasterClaw domains
 */
async function checkAllDomains(options = {}) {
  const domain = loadDomain();
  const warnDays = options.warnDays || WARNING_DAYS;
  const criticalDays = options.criticalDays || CRITICAL_DAYS;
  
  const domains = [
    { name: domain, label: 'main' },
    { name: `api.${domain}`, label: 'api' },
    { name: `gateway.${domain}`, label: 'gateway' },
    { name: `core.${domain}`, label: 'core' },
    { name: `traefik.${domain}`, label: 'traefik' },
  ];
  
  console.log(chalk.blue('🔒 MasterClaw SSL Certificate Check\n'));
  console.log(`Warning threshold: ${chalk.yellow(`${warnDays} days`)}`);
  console.log(`Critical threshold: ${chalk.red(`${criticalDays} days`)}\n`);
  
  const results = [];
  
  for (const { name, label } of domains) {
    process.stdout.write(`  Checking ${chalk.gray(label.padEnd(12))} (${name}) ... `);
    
    const result = await checkCertExpiration(name);
    results.push({ ...result, label });
    
    if (result.status === 'skipped') {
      console.log(chalk.yellow('⚠️  skipped (localhost)'));
    } else if (result.status === 'error') {
      console.log(chalk.red(`❌ error - ${result.error}`));
    } else if (result.status === 'expired') {
      console.log(chalk.red(`🔴 EXPIRED (${result.days} days ago)`));
    } else if (result.status === 'critical') {
      console.log(chalk.red(`🔴 CRITICAL (${result.days} days)`));
    } else if (result.status === 'warning') {
      console.log(chalk.yellow(`⚠️  WARNING (${result.days} days)`));
    } else {
      console.log(chalk.green(`✅ OK (${result.days} days)`));
    }
  }
  
  // Summary
  const healthy = results.filter(r => r.status === 'healthy').length;
  const warning = results.filter(r => r.status === 'warning').length;
  const critical = results.filter(r => r.status === 'critical' || r.status === 'expired').length;
  const errors = results.filter(r => r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  
  console.log('\n' + chalk.cyan('Summary:'));
  console.log(`  ${chalk.green(`Healthy: ${healthy}`)}`);
  if (warning > 0) console.log(`  ${chalk.yellow(`Warning: ${warning}`)}`);
  if (critical > 0) console.log(`  ${chalk.red(`Critical: ${critical}`)}`);
  if (errors > 0) console.log(`  ${chalk.red(`Errors: ${errors}`)}`);
  if (skipped > 0) console.log(`  ${chalk.gray(`Skipped: ${skipped}`)}`);
  
  console.log('');
  
  if (critical > 0) {
    console.log(chalk.red('🔴 ACTION REQUIRED: Some certificates need immediate attention!'));
    console.log(chalk.gray('   Run "mc ssl renew" to force certificate renewal.\n'));
    return { ok: false, exitCode: 2 };
  } else if (warning > 0) {
    console.log(chalk.yellow('⚠️  Some certificates will expire soon. Plan renewal.\n'));
    return { ok: true, exitCode: 0 };
  } else if (errors > 0) {
    console.log(chalk.yellow('⚠️  Some domains could not be checked.\n'));
    return { ok: true, exitCode: 0 };
  } else {
    console.log(chalk.green('✅ All certificates are healthy!\n'));
    return { ok: true, exitCode: 0 };
  }
}

// =============================================================================
// SSL Commands
// =============================================================================

/**
 * Check command - verify SSL certificate status
 */
ssl
  .command('check')
  .description('Check SSL certificate expiration for all domains')
  .option('-d, --domain <domain>', 'Check specific domain only')
  .option('-w, --warn <days>', 'Warning threshold in days', '14')
  .option('-c, --critical <days>', 'Critical threshold in days', '7')
  .option('--json', 'Output results as JSON')
  .action(async (options) => {
    if (options.json) {
      // JSON output mode
      const domain = options.domain || loadDomain();
      const domains = options.domain 
        ? [{ name: domain, label: 'custom' }]
        : [
            { name: domain, label: 'main' },
            { name: `api.${domain}`, label: 'api' },
            { name: `gateway.${domain}`, label: 'gateway' },
            { name: `core.${domain}`, label: 'core' },
            { name: `traefik.${domain}`, label: 'traefik' },
          ];
      
      const results = [];
      for (const { name, label } of domains) {
        const result = await checkCertExpiration(name);
        results.push({ ...result, label });
      }
      
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    
    // Normal output mode
    if (options.domain) {
      // Check single domain
      console.log(chalk.blue(`🔒 Checking SSL certificate for ${options.domain}\n`));
      
      const result = await checkCertExpiration(options.domain);
      
      if (result.status === 'error') {
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }
      
      console.log(`Domain:    ${chalk.cyan(result.domain)}`);
      console.log(`Status:    ${result.status === 'healthy' ? chalk.green('✅ Healthy') : chalk.yellow('⚠️  Warning')}`);
      console.log(`Days Left: ${result.days > 30 ? chalk.green(result.days) : result.days > 7 ? chalk.yellow(result.days) : chalk.red(result.days)}`);
      console.log(`Issuer:    ${chalk.gray(result.issuer)}`);
      console.log(`Valid To:  ${chalk.gray(result.validTo)}`);
      
      if (result.days <= parseInt(options.critical)) {
        console.log(chalk.red('\n🔴 Certificate needs renewal soon!'));
        process.exit(2);
      } else if (result.days <= parseInt(options.warn)) {
        console.log(chalk.yellow('\n⚠️  Certificate will expire soon. Plan renewal.'));
      }
      
      return;
    }
    
    // Check all domains
    const { ok, exitCode } = await checkAllDomains({
      warnDays: parseInt(options.warn),
      criticalDays: parseInt(options.critical),
    });
    
    if (!ok) {
      process.exit(exitCode);
    }
  });

/**
 * Renew command - force certificate renewal
 */
ssl
  .command('renew')
  .description('Force SSL certificate renewal via Traefik')
  .option('-f, --force', 'Force renewal even if certificates are valid')
  .action(async (options) => {
    const infraDir = findInfraDir();
    
    if (!infraDir) {
      console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
      console.log(chalk.gray('Set MASTERCLAW_INFRA environment variable or run from infra directory'));
      process.exit(1);
    }
    
    console.log(chalk.blue('🔄 SSL Certificate Renewal\n'));
    
    // Check current status first (unless forcing)
    if (!options.force) {
      console.log(chalk.gray('Checking current certificate status...\n'));
      const { ok, exitCode } = await checkAllDomains();
      
      if (ok && exitCode === 0) {
        console.log(chalk.green('✅ All certificates are currently healthy.'));
        console.log(chalk.yellow('\n⚠️  Use --force to renew anyway, or certificates will auto-renew when needed.'));
        console.log(chalk.gray('   Traefik automatically handles renewal 30 days before expiration.\n'));
        return;
      }
      
      console.log('');
    }
    
    console.log(chalk.cyan('Restarting Traefik to trigger certificate renewal...\n'));
    
    try {
      // Restart Traefik container
      execSync('docker-compose restart traefik', {
        cwd: infraDir,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' }
      });
      
      console.log('');
      console.log(chalk.green('✅ Traefik restarted successfully'));
      console.log(chalk.gray('   Certificates will be renewed automatically if eligible.'));
      console.log(chalk.gray('   Checking status in 10 seconds...\n'));
      
      // Wait a bit and check status
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      const { ok } = await checkAllDomains();
      
      if (!ok) {
        console.log(chalk.yellow('\n⚠️  Certificates may still be processing. Check again in a few minutes.'));
      }
      
    } catch (err) {
      console.error(chalk.red(`\n❌ Failed to restart Traefik: ${err.message}`));
      console.log(chalk.gray('   Ensure Docker is running and you have proper permissions.\n'));
      process.exit(1);
    }
  });

/**
 * Info command - show SSL configuration details
 */
ssl
  .command('info')
  .description('Show SSL configuration information')
  .action(() => {
    const domain = loadDomain();
    const infraDir = findInfraDir();
    
    console.log(chalk.blue('🔒 MasterClaw SSL Configuration\n'));
    
    console.log(chalk.cyan('Domain:'));
    console.log(`  Primary: ${chalk.cyan(domain)}`);
    console.log(`  API:     ${chalk.cyan(`api.${domain}`)}`);
    console.log(`  Gateway: ${chalk.cyan(`gateway.${domain}`)}`);
    console.log(`  Core:    ${chalk.cyan(`core.${domain}`)}`);
    console.log(`  Traefik: ${chalk.cyan(`traefik.${domain}`)}\n`);
    
    console.log(chalk.cyan('Certificate Provider:'));
    console.log(`  ${chalk.gray('Let\'s Encrypt (via Traefik)')}\n`);
    
    console.log(chalk.cyan('Auto-Renewal:'));
    console.log(`  ${chalk.green('✅ Enabled')} - Traefik auto-renews 30 days before expiry\n`);
    
    console.log(chalk.cyan('Thresholds:'));
    console.log(`  Warning:  ${chalk.yellow(`${WARNING_DAYS} days`)}`);
    console.log(`  Critical: ${chalk.red(`${CRITICAL_DAYS} days`)}\n`);
    
    if (infraDir) {
      console.log(chalk.cyan('Infrastructure Directory:'));
      console.log(`  ${chalk.gray(infraDir)}\n`);
    }
    
    console.log(chalk.gray('Commands:'));
    console.log(chalk.gray('  mc ssl check  - Check certificate status'));
    console.log(chalk.gray('  mc ssl renew  - Force certificate renewal'));
    console.log(chalk.gray('  mc ssl info   - Show this information\n'));
  });

/**
 * Metrics command - output Prometheus-compatible metrics
 */
ssl
  .command('metrics')
  .description('Output SSL certificate metrics in Prometheus format')
  .action(async () => {
    const domain = loadDomain();
    
    const domains = [
      { name: domain, label: 'main' },
      { name: `api.${domain}`, label: 'api' },
      { name: `gateway.${domain}`, label: 'gateway' },
      { name: `core.${domain}`, label: 'core' },
      { name: `traefik.${domain}`, label: 'traefik' },
    ];
    
    console.log('# HELP masterclaw_ssl_cert_expiry_days Days until SSL certificate expires');
    console.log('# TYPE masterclaw_ssl_cert_expiry_days gauge');
    
    for (const { name, label } of domains) {
      const result = await checkCertExpiration(name);
      const days = result.status === 'skipped' ? -1 : result.days;
      console.log(`masterclaw_ssl_cert_expiry_days{domain="${name}",service="${label}"} ${days}`);
    }
    
    console.log('');
    console.log('# HELP masterclaw_ssl_cert_check_timestamp Unix timestamp of last check');
    console.log('# TYPE masterclaw_ssl_cert_check_timestamp gauge');
    console.log(`masterclaw_ssl_cert_check_timestamp ${Math.floor(Date.now() / 1000)}`);
  });

module.exports = ssl;
