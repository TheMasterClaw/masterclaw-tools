/**
 * API documentation management for MasterClaw CLI
 * Provides commands to view, export, and interact with Core API documentation
 * 
 * Features:
 * - View API documentation URLs and status
 * - Export OpenAPI spec to file
 * - List available API endpoints
 * - Open API docs in browser
 * - Validate API connectivity
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const { findInfraDir } = require('./services');
const config = require('./config');
const rateLimiter = require('./rate-limiter');
const httpClient = require('./http-client');

const api = new Command('api');

// =============================================================================
// Configuration
// =============================================================================

/** Default Core API URL */
const DEFAULT_API_URL = process.env.CORE_URL || 'http://localhost:8000';

/** API documentation paths */
const API_PATHS = {
  openapi: '/openapi.json',
  docs: '/docs',
  redoc: '/redoc',
  health: '/health',
  metrics: '/metrics',
};

/** Cache for OpenAPI spec */
let openApiCache = null;
let openApiCacheTime = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get API base URL from environment or config
 * @returns {string} API base URL
 */
function getApiUrl() {
  return process.env.CORE_URL || 
         process.env.MASTERCLAW_API_URL || 
         config.get('api.url') || 
         DEFAULT_API_URL;
}

/**
 * Fetch OpenAPI specification from API
 * @param {string} apiUrl - Base API URL
 * @returns {Promise<Object>} OpenAPI spec
 */
async function fetchOpenApiSpec(apiUrl) {
  // Check cache
  if (openApiCache && openApiCacheTime && (Date.now() - openApiCacheTime < CACHE_TTL_MS)) {
    return openApiCache;
  }

  const url = `${apiUrl}${API_PATHS.openapi}`;
  
  try {
    const response = await httpClient.get(url, { timeout: 10000 });
    openApiCache = response.data;
    openApiCacheTime = Date.now();
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch OpenAPI spec: ${error.message}`);
  }
}

/**
 * Check if API is accessible
 * @param {string} apiUrl - Base API URL
 * @returns {Promise<{accessible: boolean, version?: string, error?: string}>}
 */
async function checkApiHealth(apiUrl) {
  try {
    const response = await httpClient.get(`${apiUrl}${API_PATHS.health}`, { 
      timeout: 5000 
    });
    return {
      accessible: true,
      version: response.data?.version,
      status: response.data?.status,
    };
  } catch (error) {
    return {
      accessible: false,
      error: error.message,
    };
  }
}

/**
 * Open URL in default browser
 * @param {string} url - URL to open
 */
function openBrowser(url) {
  const platform = os.platform();
  
  try {
    if (platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
    } else {
      // Linux and others
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Format HTTP method with color
 * @param {string} method - HTTP method
 * @returns {string} Colored method string
 */
function formatMethod(method) {
  const colors = {
    GET: chalk.green,
    POST: chalk.blue,
    PUT: chalk.yellow,
    PATCH: chalk.cyan,
    DELETE: chalk.red,
  };
  
  const upperMethod = method.toUpperCase();
  const color = colors[upperMethod] || chalk.white;
  return color(upperMethod.padEnd(6));
}

/**
 * Group endpoints by tag/category
 * @param {Object} spec - OpenAPI spec
 * @returns {Map<string, Array<{method: string, path: string, summary: string}>>}
 */
function groupEndpointsByTag(spec) {
  const groups = new Map();
  
  if (!spec.paths) return groups;
  
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, details] of Object.entries(methods)) {
      if (method === 'parameters') continue;
      
      const tag = details.tags?.[0] || 'General';
      const summary = details.summary || details.description || 'No description';
      
      if (!groups.has(tag)) {
        groups.set(tag, []);
      }
      
      groups.get(tag).push({
        method: method.toUpperCase(),
        path,
        summary,
        deprecated: details.deprecated || false,
      });
    }
  }
  
  // Sort endpoints within each group
  for (const endpoints of groups.values()) {
    endpoints.sort((a, b) => a.path.localeCompare(b.path));
  }
  
  return groups;
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Show API status and documentation URLs
 */
api
  .command('status')
  .description('Show API status and documentation URLs')
  .option('-u, --url <url>', 'API base URL', getApiUrl())
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await rateLimiter.checkLimit('api:status', 30, 60); // 30 per minute
      
      const apiUrl = options.url;
      const health = await checkApiHealth(apiUrl);
      
      const info = {
        api_url: apiUrl,
        status: health.accessible ? 'accessible' : 'unreachable',
        version: health.version,
        health_status: health.status,
        documentation: {
          swagger_ui: `${apiUrl}${API_PATHS.docs}`,
          redoc: `${apiUrl}${API_PATHS.redoc}`,
          openapi_spec: `${apiUrl}${API_PATHS.openapi}`,
        },
        endpoints: {
          health: `${apiUrl}${API_PATHS.health}`,
          metrics: `${apiUrl}${API_PATHS.metrics}`,
        },
      };
      
      if (!health.accessible) {
        info.error = health.error;
      }
      
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      
      console.log(chalk.bold('🐾 MasterClaw API Status'));
      console.log(chalk.gray('─'.repeat(50)));
      
      console.log(`\n${chalk.bold('API URL:')} ${chalk.cyan(apiUrl)}`);
      
      if (health.accessible) {
        console.log(` ${chalk.green('●')} Status: ${chalk.green('Accessible')}`);
        if (health.version) {
          console.log(` ${chalk.green('●')} Version: ${chalk.cyan(health.version)}`);
        }
      } else {
        console.log(` ${chalk.red('●')} Status: ${chalk.red('Unreachable')}`);
        console.log(`   ${chalk.gray(health.error)}`);
      }
      
      console.log(`\n${chalk.bold('📚 Documentation:')}`);
      console.log(`   Swagger UI: ${chalk.cyan(info.documentation.swagger_ui)}`);
      console.log(`   ReDoc:      ${chalk.cyan(info.documentation.redoc)}`);
      console.log(`   OpenAPI:    ${chalk.cyan(info.documentation.openapi_spec)}`);
      
      console.log(`\n${chalk.bold('🔌 Endpoints:')}`);
      console.log(`   Health:  ${chalk.cyan(info.endpoints.health)}`);
      console.log(`   Metrics: ${chalk.cyan(info.endpoints.metrics)}`);
      
      if (!health.accessible) {
        console.log(`\n${chalk.yellow('💡 Tip:')} Ensure the Core API is running with: ${chalk.cyan('mc status')}`);
      }
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Open API documentation in browser
 */
api
  .command('docs')
  .description('Open API documentation in browser')
  .option('-u, --url <url>', 'API base URL', getApiUrl())
  .option('--redoc', 'Open ReDoc instead of Swagger UI')
  .action(async (options) => {
    try {
      await rateLimiter.checkLimit('api:docs', 10, 60); // 10 per minute
      
      const apiUrl = options.url;
      const docUrl = options.redoc 
        ? `${apiUrl}${API_PATHS.redoc}` 
        : `${apiUrl}${API_PATHS.docs}`;
      
      const docType = options.redoc ? 'ReDoc' : 'Swagger UI';
      
      console.log(chalk.bold(`🐾 Opening ${docType}...`));
      console.log(chalk.gray(`   ${docUrl}`));
      
      const opened = openBrowser(docUrl);
      
      if (opened) {
        console.log(chalk.green(`\n✅ Opened ${docType} in your browser`));
      } else {
        console.log(chalk.yellow(`\n⚠️  Could not open browser automatically`));
        console.log(chalk.gray(`   Please open manually: ${chalk.cyan(docUrl)}`));
      }
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Export OpenAPI specification
 */
api
  .command('export')
  .description('Export OpenAPI specification to file')
  .option('-u, --url <url>', 'API base URL', getApiUrl())
  .option('-o, --output <file>', 'Output file path')
  .option('--yaml', 'Export as YAML (default: JSON)')
  .action(async (options) => {
    try {
      await rateLimiter.checkLimit('api:export', 10, 60); // 10 per minute
      
      const apiUrl = options.url;
      
      console.log(chalk.bold('🐾 Exporting OpenAPI Specification'));
      console.log(chalk.gray(`   Fetching from ${apiUrl}...`));
      
      const spec = await fetchOpenApiSpec(apiUrl);
      
      // Determine output format and filename
      const isYaml = options.yaml;
      const defaultExt = isYaml ? 'yaml' : 'json';
      const outputFile = options.output || `masterclaw-api-${spec.info?.version || '1.0.0'}.${defaultExt}`;
      
      // Convert to YAML if requested
      let output;
      if (isYaml) {
        // Simple YAML conversion (for proper YAML, would need js-yaml)
        output = `# MasterClaw API Specification
# Version: ${spec.info?.version || 'unknown'}
# Generated: ${new Date().toISOString()}
# 
# Note: This is a basic YAML representation.
# For full YAML export, install js-yaml: npm install js-yaml

${JSON.stringify(spec, null, 2)}`;
      } else {
        output = JSON.stringify(spec, null, 2);
      }
      
      // Write file
      await fs.writeFile(outputFile, output, 'utf8');
      
      const stats = await fs.stat(outputFile);
      const sizeKb = (stats.size / 1024).toFixed(2);
      
      console.log(chalk.green(`\n✅ Exported to: ${chalk.cyan(outputFile)}`));
      console.log(chalk.gray(`   Size: ${sizeKb} KB`));
      console.log(chalk.gray(`   Format: ${isYaml ? 'YAML' : 'JSON'}`));
      console.log(chalk.gray(`   API Version: ${spec.info?.version || 'unknown'}`));
      
      if (spec.info?.title) {
        console.log(chalk.gray(`   Title: ${spec.info.title}`));
      }
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * List API endpoints
 */
api
  .command('endpoints')
  .description('List all available API endpoints')
  .option('-u, --url <url>', 'API base URL', getApiUrl())
  .option('-t, --tag <tag>', 'Filter by tag/category')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await rateLimiter.checkLimit('api:endpoints', 20, 60); // 20 per minute
      
      const apiUrl = options.url;
      
      console.log(chalk.bold('🐾 Fetching API Endpoints...'));
      console.log(chalk.gray(`   From: ${apiUrl}`));
      
      const spec = await fetchOpenApiSpec(apiUrl);
      const groups = groupEndpointsByTag(spec);
      
      if (options.json) {
        const output = {};
        for (const [tag, endpoints] of groups) {
          if (!options.tag || tag.toLowerCase() === options.tag.toLowerCase()) {
            output[tag] = endpoints;
          }
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      
      console.log(chalk.bold(`\n📡 API Endpoints (${spec.info?.version || 'unknown'})\n`));
      
      let totalEndpoints = 0;
      
      for (const [tag, endpoints] of groups) {
        // Filter by tag if specified
        if (options.tag && tag.toLowerCase() !== options.tag.toLowerCase()) {
          continue;
        }
        
        console.log(chalk.bold.yellow(`${tag}`));
        console.log(chalk.gray('─'.repeat(40)));
        
        for (const ep of endpoints) {
          const methodStr = formatMethod(ep.method);
          const pathStr = chalk.cyan(ep.path);
          const deprecatedStr = ep.deprecated ? chalk.red(' [DEPRECATED]') : '';
          
          console.log(`  ${methodStr} ${pathStr}${deprecatedStr}`);
          console.log(`         ${chalk.gray(ep.summary)}`);
          totalEndpoints++;
        }
        
        console.log();
      }
      
      console.log(chalk.gray(`Total: ${totalEndpoints} endpoints`));
      
      if (options.tag && totalEndpoints === 0) {
        console.log(chalk.yellow(`\n⚠️  No endpoints found with tag: ${options.tag}`));
        console.log(chalk.gray(`   Available tags: ${Array.from(groups.keys()).join(', ')}`));
      }
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Show API version information
 */
api
  .command('version')
  .description('Show API version information')
  .option('-u, --url <url>', 'API base URL', getApiUrl())
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await rateLimiter.checkLimit('api:version', 30, 60);
      
      const apiUrl = options.url;
      const spec = await fetchOpenApiSpec(apiUrl);
      
      const info = {
        api_version: spec.info?.version,
        title: spec.info?.title,
        description: spec.info?.description,
        contact: spec.info?.contact,
        license: spec.info?.license,
        openapi_version: spec.openapi,
        server_count: spec.servers?.length || 0,
        endpoint_count: Object.keys(spec.paths || {}).length,
      };
      
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      
      console.log(chalk.bold('🐾 MasterClaw API Version'));
      console.log(chalk.gray('─'.repeat(50)));
      
      console.log(`\n${chalk.bold('API Title:')} ${info.title || 'N/A'}`);
      console.log(`${chalk.bold('Version:')}   ${chalk.cyan(info.api_version || 'N/A')}`);
      console.log(`${chalk.bold('OpenAPI:')}   ${info.openapi_version || 'N/A'}`);
      
      if (info.description) {
        const shortDesc = info.description.split('\n')[0].substring(0, 100);
        console.log(`\n${chalk.bold('Description:')}`);
        console.log(`  ${chalk.gray(shortDesc)}${info.description.length > 100 ? '...' : ''}`);
      }
      
      console.log(`\n${chalk.bold('Statistics:')}`);
      console.log(`  ${chalk.gray('Servers:')}   ${info.server_count}`);
      console.log(`  ${chalk.gray('Paths:')}     ${info.endpoint_count}`);
      
      if (spec.servers && spec.servers.length > 0) {
        console.log(`\n${chalk.bold('Servers:')}`);
        spec.servers.forEach((server, i) => {
          console.log(`  ${i + 1}. ${chalk.cyan(server.url)}`);
          if (server.description) {
            console.log(`     ${chalk.gray(server.description)}`);
          }
        });
      }
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

module.exports = api;
