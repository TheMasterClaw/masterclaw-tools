/**
 * client.js - OpenAPI Client Generator for MasterClaw
 * 
 * Generates type-safe API clients from the Core API's OpenAPI specification.
 * Supports TypeScript, JavaScript, and Python clients.
 * 
 * Usage:
 *   mc client generate              # Generate TypeScript client (default)
 *   mc client generate --lang python # Generate Python client
 *   mc client generate --lang js    # Generate JavaScript client
 *   mc client validate              # Validate OpenAPI spec
 *   mc client diff                  # Show API changes since last generation
 *   mc client sync                  # Auto-sync clients when API changes
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

const client = new Command('client');

// Default Core API URL
const DEFAULT_CORE_URL = process.env.CORE_URL || 'http://localhost:8000';

// Client output directories
const CLIENT_DIRS = {
  typescript: './clients/typescript',
  javascript: './clients/javascript', 
  python: './clients/python'
};

// Language-specific templates
const TEMPLATES = {
  typescript: {
    extension: '.ts',
    header: `/**
 * MasterClaw API Client - TypeScript
 * Auto-generated from OpenAPI spec - DO NOT EDIT MANUALLY
 * Generated: {{timestamp}}
 * API Version: {{apiVersion}}
 */

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

export class MasterClawClient {
  private config: ApiConfig;
  
  constructor(config: ApiConfig) {
    this.config = {
      timeout: 30000,
      ...config
    };
  }
`,
    footer: `}

export default MasterClawClient;
`,
    methodTemplate: (method) => `  /**
   * ${method.summary || method.operationId}
   * ${method.description ? '* ' + method.description : ''}
   */
  async ${method.operationId}(${method.params}): Promise<${method.returnType}> {
    const response = await fetch(\`${method.path}\`, {
      method: '${method.httpMethod}',
      headers: {
        'Content-Type': 'application/json',
        ${method.requiresAuth ? "'X-API-Key': this.config.apiKey," : ''}
      },
      ${method.body ? 'body: JSON.stringify(data),' : ''}
    });
    
    if (!response.ok) {
      throw new Error(\`API error: \${response.status} \${response.statusText}\`);
    }
    
    return response.json();
  }
`
  },
  
  javascript: {
    extension: '.js',
    header: `/**
 * MasterClaw API Client - JavaScript
 * Auto-generated from OpenAPI spec - DO NOT EDIT MANUALLY
 * Generated: {{timestamp}}
 * API Version: {{apiVersion}}
 */

class MasterClawClient {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeout: config.timeout || 30000,
    };
  }
`,
    footer: `}

module.exports = { MasterClawClient };
`,
    methodTemplate: (method) => `  /**
   * ${method.summary || method.operationId}
   */
  async ${method.operationId}(${method.params}) {
    const response = await fetch(\`${method.path}\`, {
      method: '${method.httpMethod}',
      headers: {
        'Content-Type': 'application/json',
        ${method.requiresAuth ? "'X-API-Key': this.config.apiKey," : ''}
      },
      ${method.body ? 'body: JSON.stringify(data),' : ''}
    });
    
    if (!response.ok) {
      throw new Error(\`API error: \${response.status} \${response.statusText}\`);
    }
    
    return response.json();
  }
`
  },
  
  python: {
    extension: '.py',
    header: `"""
MasterClaw API Client - Python
Auto-generated from OpenAPI spec - DO NOT EDIT MANUALLY
Generated: {{timestamp}}
API Version: {{apiVersion}}
"""

import requests
from typing import Optional, Dict, Any
from dataclasses import dataclass


@dataclass
class ApiConfig:
    base_url: str
    api_key: Optional[str] = None
    timeout: int = 30


class MasterClawClient:
    def __init__(self, config: ApiConfig):
        self.config = config
        self.session = requests.Session()
`,
    footer: `

__all__ = ['MasterClawClient', 'ApiConfig']
`,
    methodTemplate: (method) => `    def ${method.operationId}(self${method.params ? ', ' + method.params : ''}) -> ${method.returnType}:
        """
        ${method.summary or method.operationId}
        ${method.description or ''}
        """
        url = f"{self.config.base_url}${method.path}"
        headers = {
            'Content-Type': 'application/json',
            ${method.requiresAuth ? "'X-API-Key': self.config.api_key," : ''}
        }
        
        response = self.session.${method.httpMethod}(
            url,
            headers=headers,
            ${method.body ? 'json=data, ' : ''}timeout=self.config.timeout
        )
        response.raise_for_status()
        return response.json()
`
  }
};

/**
 * Fetch OpenAPI spec from Core API
 */
async function fetchOpenApiSpec(coreUrl) {
  try {
    const response = await axios.get(`${coreUrl}/openapi.json`, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Core API not available at ${coreUrl}. Is MasterClaw running?`);
    }
    throw new Error(`Failed to fetch OpenAPI spec: ${error.message}`);
  }
}

/**
 * Parse OpenAPI paths into method definitions
 */
function parseOpenApiMethods(spec) {
  const methods = [];
  
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [httpMethod, operation] of Object.entries(pathItem)) {
      if (httpMethod === 'parameters') continue;
      
      const methodName = operation.operationId || 
        `${httpMethod}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Extract parameters
      const pathParams = (operation.parameters || [])
        .filter(p => p.in === 'path')
        .map(p => p.name);
      
      const queryParams = (operation.parameters || [])
        .filter(p => p.in === 'query')
        .map(p => p.name);
      
      const requiresAuth = operation.security && operation.security.length > 0;
      const hasBody = ['post', 'put', 'patch'].includes(httpMethod);
      
      // Build parameter string based on language
      const params = buildParams(pathParams, queryParams, hasBody);
      
      // Determine return type
      const returnType = extractReturnType(operation);
      
      methods.push({
        operationId: camelCase(methodName),
        httpMethod: httpMethod.toUpperCase(),
        path: convertPathParams(path),
        summary: operation.summary,
        description: operation.description,
        params,
        returnType,
        requiresAuth,
        body: hasBody,
        tags: operation.tags || []
      });
    }
  }
  
  return methods;
}

/**
 * Build parameter string for different languages
 */
function buildParams(pathParams, queryParams, hasBody) {
  const params = [];
  
  // Path params
  pathParams.forEach(p => {
    params.push(`${p}: string`);
  });
  
  // Query params
  if (queryParams.length > 0) {
    params.push(`params?: { ${queryParams.map(p => `${p}?: any`).join(', ')} }`);
  }
  
  // Body
  if (hasBody) {
    params.push('data: any');
  }
  
  return params.join(', ');
}

/**
 * Extract return type from operation
 */
function extractReturnType(operation) {
  const successResponse = operation.responses?.['200'] || operation.responses?.['201'];
  if (successResponse?.content?.['application/json']?.schema) {
    return 'any'; // Simplified - could be more specific
  }
  return 'any';
}

/**
 * Convert OpenAPI path params to template literals
 */
function convertPathParams(path) {
  return path.replace(/{(\w+)}/g, '${$1}');
}

/**
 * Convert string to camelCase
 */
function camelCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/^[A-Z]/, char => char.toLowerCase());
}

/**
 * Generate client code for a language
 */
function generateClientCode(spec, lang, methods) {
  const template = TEMPLATES[lang];
  const timestamp = new Date().toISOString();
  const apiVersion = spec.info?.version || 'unknown';
  
  let code = template.header
    .replace('{{timestamp}}', timestamp)
    .replace('{{apiVersion}}', apiVersion);
  
  // Group methods by tag for organization
  const groupedMethods = groupByTag(methods);
  
  for (const [tag, tagMethods] of Object.entries(groupedMethods)) {
    code += `\n  // ${tag}\n`;
    tagMethods.forEach(method => {
      code += template.methodTemplate(method);
    });
  }
  
  code += template.footer;
  
  return code;
}

/**
 * Group methods by their primary tag
 */
function groupByTag(methods) {
  const grouped = {};
  
  methods.forEach(method => {
    const tag = method.tags[0] || 'general';
    if (!grouped[tag]) grouped[tag] = [];
    grouped[tag].push(method);
  });
  
  return grouped;
}

/**
 * Save client code and metadata
 */
async function saveClient(outputDir, lang, code, spec) {
  await fs.ensureDir(outputDir);
  
  const template = TEMPLATES[lang];
  const filename = `masterclaw-client${template.extension}`;
  const filepath = path.join(outputDir, filename);
  
  // Write client file
  await fs.writeFile(filepath, code, 'utf-8');
  
  // Write metadata
  const metadata = {
    generatedAt: new Date().toISOString(),
    apiVersion: spec.info?.version,
    apiTitle: spec.info?.title,
    language: lang,
    endpoints: Object.keys(spec.paths || {}).length,
    checksum: require('crypto').createHash('md5').update(code).digest('hex')
  };
  
  await fs.writeFile(
    path.join(outputDir, 'client-metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  return { filepath, metadata };
}

/**
 * Generate package.json for JS/TS clients
 */
async function generatePackageJson(outputDir, lang, spec) {
  const packageData = {
    name: lang === 'typescript' ? '@masterclaw/api-client' : 'masterclaw-api-client',
    version: spec.info?.version || '1.0.0',
    description: `Auto-generated MasterClaw API client (${lang})`,
    main: lang === 'typescript' ? 'masterclaw-client.ts' : 'masterclaw-client.js',
    types: lang === 'typescript' ? 'masterclaw-client.d.ts' : undefined,
    scripts: {
      build: lang === 'typescript' ? 'tsc masterclaw-client.ts --declaration' : 'echo "No build needed"'
    },
    keywords: ['masterclaw', 'api', 'client', 'ai'],
    author: 'Auto-generated',
    license: 'MIT',
    engines: {
      node: '>=14.0.0'
    },
    peerDependencies: lang === 'typescript' ? {
      typescript: '>=4.0.0'
    } : undefined
  };
  
  await fs.writeFile(
    path.join(outputDir, 'package.json'),
    JSON.stringify(packageData, null, 2)
  );
}

/**
 * Generate setup.py for Python client
 */
async function generateSetupPy(outputDir, spec) {
  const setupPy = `from setuptools import setup

setup(
    name='masterclaw-api-client',
    version='${spec.info?.version || '1.0.0'}',
    description='Auto-generated MasterClaw API client',
    py_modules=['masterclaw-client'],
    install_requires=['requests>=2.25.0'],
    python_requires='>=3.8',
    author='Auto-generated',
    license='MIT',
)
`;
  
  await fs.writeFile(path.join(outputDir, 'setup.py'), setupPy);
  
  // Also generate requirements.txt
  await fs.writeFile(
    path.join(outputDir, 'requirements.txt'),
    'requests>=2.25.0\n'
  );
}

// =============================================================================
// Commands
// =============================================================================

client
  .description('Generate API clients from Core OpenAPI spec');

/**
 * Generate command - Generate client for specified language
 */
client
  .command('generate')
  .description('Generate API client from OpenAPI spec')
  .option('-l, --lang <language>', 'Target language (typescript, javascript, python)', 'typescript')
  .option('-u, --url <url>', 'Core API URL', DEFAULT_CORE_URL)
  .option('-o, --output <dir>', 'Output directory')
  .option('--skip-package', 'Skip generating package files')
  .action(async (options) => {
    console.log(chalk.blue('🐾 MasterClaw API Client Generator\n'));
    
    // Validate language
    const validLangs = ['typescript', 'javascript', 'python'];
    if (!validLangs.includes(options.lang)) {
      console.error(chalk.red(`❌ Unsupported language: ${options.lang}`));
      console.log(chalk.gray(`Supported: ${validLangs.join(', ')}`));
      process.exit(1);
    }
    
    // Determine output directory
    const outputDir = options.output || CLIENT_DIRS[options.lang];
    
    try {
      // Fetch OpenAPI spec
      console.log(chalk.gray(`📥 Fetching OpenAPI spec from ${options.url}...`));
      const spec = await fetchOpenApiSpec(options.url);
      
      console.log(chalk.green(`✅ Found API: ${spec.info?.title} v${spec.info?.version}`));
      console.log(chalk.gray(`   Endpoints: ${Object.keys(spec.paths || {}).length}`));
      
      // Parse methods
      console.log(chalk.gray('\n🔍 Parsing API endpoints...'));
      const methods = parseOpenApiMethods(spec);
      console.log(chalk.green(`✅ Found ${methods.length} operations`));
      
      // Generate client code
      console.log(chalk.gray(`\n🏗️  Generating ${options.lang} client...`));
      const code = generateClientCode(spec, options.lang, methods);
      
      // Save client
      const { filepath, metadata } = await saveClient(outputDir, options.lang, code, spec);
      
      // Generate package files
      if (!options.skipPackage) {
        if (options.lang === 'python') {
          await generateSetupPy(outputDir, spec);
        } else {
          await generatePackageJson(outputDir, options.lang, spec);
        }
      }
      
      // Success output
      console.log(chalk.green(`\n✅ Client generated successfully!`));
      console.log(chalk.cyan(`\n📁 Output: ${filepath}`));
      console.log(chalk.gray(`   Language: ${options.lang}`));
      console.log(chalk.gray(`   Endpoints: ${metadata.endpoints}`));
      console.log(chalk.gray(`   Operations: ${methods.length}`));
      
      // Usage instructions
      console.log(chalk.blue('\n📖 Usage:'));
      switch (options.lang) {
        case 'typescript':
          console.log(chalk.gray('   import { MasterClawClient } from \'./masterclaw-client\';'));
          console.log(chalk.gray('   const client = new MasterClawClient({'));
          console.log(chalk.gray('     baseUrl: \'http://localhost:8000\','));
          console.log(chalk.gray('     apiKey: \'your-api-key\''));
          console.log(chalk.gray('   });'));
          console.log(chalk.gray('   const health = await client.healthCheck();'));
          break;
        case 'javascript':
          console.log(chalk.gray('   const { MasterClawClient } = require(\'./masterclaw-client\');'));
          console.log(chalk.gray('   const client = new MasterClawClient({'));
          console.log(chalk.gray('     baseUrl: \'http://localhost:8000\','));
          console.log(chalk.gray('     apiKey: \'your-api-key\''));
          console.log(chalk.gray('   });'));
          console.log(chalk.gray('   const health = await client.healthCheck();'));
          break;
        case 'python':
          console.log(chalk.gray('   from masterclaw_client import MasterClawClient, ApiConfig'));
          console.log(chalk.gray('   config = ApiConfig('));
          console.log(chalk.gray('       base_url="http://localhost:8000",'));
          console.log(chalk.gray('       api_key="your-api-key"'));
          console.log(chalk.gray('   )'));
          console.log(chalk.gray('   client = MasterClawClient(config)'));
          console.log(chalk.gray('   health = client.health_check()'));
          break;
      }
      
    } catch (error) {
      console.error(chalk.red(`\n❌ Generation failed: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Validate command - Validate the OpenAPI spec
 */
client
  .command('validate')
  .description('Validate Core API OpenAPI spec')
  .option('-u, --url <url>', 'Core API URL', DEFAULT_CORE_URL)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const spec = await fetchOpenApiSpec(options.url);
      
      const validation = {
        valid: true,
        version: spec.openapi,
        apiVersion: spec.info?.version,
        title: spec.info?.title,
        endpoints: Object.keys(spec.paths || {}).length,
        schemas: Object.keys(spec.components?.schemas || {}).length,
        issues: []
      };
      
      // Check for common issues
      if (!spec.info?.description) {
        validation.issues.push('API description is missing');
      }
      
      if (!spec.components?.schemas) {
        validation.issues.push('No schemas defined');
      }
      
      // Check for endpoints without operationIds
      for (const [path, pathItem] of Object.entries(spec.paths || {})) {
        for (const [method, operation] of Object.entries(pathItem)) {
          if (method === 'parameters') continue;
          if (!operation.operationId) {
            validation.issues.push(`Missing operationId: ${method.toUpperCase()} ${path}`);
          }
        }
      }
      
      if (options.json) {
        console.log(JSON.stringify(validation, null, 2));
      } else {
        console.log(chalk.blue('🔍 OpenAPI Validation Results\n'));
        console.log(`Version: ${spec.openapi}`);
        console.log(`API: ${spec.info?.title} v${spec.info?.version}`);
        console.log(`Endpoints: ${validation.endpoints}`);
        console.log(`Schemas: ${validation.schemas}`);
        
        if (validation.issues.length === 0) {
          console.log(chalk.green('\n✅ Spec is valid'));
        } else {
          console.log(chalk.yellow(`\n⚠️  ${validation.issues.length} issues found:`));
          validation.issues.forEach(issue => {
            console.log(chalk.gray(`  - ${issue}`));
          });
        }
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Validation failed: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Diff command - Show API changes
 */
client
  .command('diff')
  .description('Show API changes since last client generation')
  .option('-l, --lang <language>', 'Language to check', 'typescript')
  .option('-u, --url <url>', 'Core API URL', DEFAULT_CORE_URL)
  .action(async (options) => {
    try {
      const outputDir = CLIENT_DIRS[options.lang];
      const metadataPath = path.join(outputDir, 'client-metadata.json');
      
      if (!await fs.pathExists(metadataPath)) {
        console.log(chalk.yellow('⚠️  No previous client generation found'));
        console.log(chalk.gray('Run: mc client generate first'));
        return;
      }
      
      const metadata = await fs.readJson(metadataPath);
      const currentSpec = await fetchOpenApiSpec(options.url);
      
      console.log(chalk.blue('📊 API Changes\n'));
      console.log(`Previous: ${metadata.apiVersion} (${metadata.generatedAt})`);
      console.log(`Current:  ${currentSpec.info?.version}`);
      
      if (metadata.apiVersion !== currentSpec.info?.version) {
        console.log(chalk.yellow('\n⚠️  API version changed'));
      }
      
      const currentEndpoints = Object.keys(currentSpec.paths || {});
      const prevCount = metadata.endpoints;
      const currCount = currentEndpoints.length;
      
      if (currCount !== prevCount) {
        const diff = currCount - prevCount;
        const color = diff > 0 ? chalk.green : chalk.red;
        console.log(color(`\n${diff > 0 ? '+' : ''}${diff} endpoints`));
      } else {
        console.log(chalk.gray('\nNo endpoint count changes'));
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Diff failed: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Sync command - Auto-sync when API changes
 */
client
  .command('sync')
  .description('Auto-sync clients when API changes (CI/CD)')
  .option('-l, --lang <languages...>', 'Languages to generate', ['typescript'])
  .option('-u, --url <url>', 'Core API URL', DEFAULT_CORE_URL)
  .option('--commit', 'Auto-commit changes (CI)')
  .action(async (options) => {
    console.log(chalk.blue('🔄 MasterClaw Client Sync\n'));
    
    try {
      const spec = await fetchOpenApiSpec(options.url);
      let hasChanges = false;
      
      for (const lang of options.lang) {
        const outputDir = CLIENT_DIRS[lang];
        const metadataPath = path.join(outputDir, 'client-metadata.json');
        
        // Check if generation needed
        if (await fs.pathExists(metadataPath)) {
          const metadata = await fs.readJson(metadataPath);
          if (metadata.apiVersion === spec.info?.version) {
            console.log(chalk.gray(`${lang}: Up to date (${metadata.apiVersion})`));
            continue;
          }
        }
        
        // Generate client
        console.log(chalk.yellow(`${lang}: Generating...`));
        const methods = parseOpenApiMethods(spec);
        const code = generateClientCode(spec, lang, methods);
        await saveClient(outputDir, lang, code, spec);
        
        if (lang === 'python') {
          await generateSetupPy(outputDir, spec);
        } else {
          await generatePackageJson(outputDir, lang, spec);
        }
        
        console.log(chalk.green(`${lang}: ✅ Generated`));
        hasChanges = true;
      }
      
      if (hasChanges && options.commit) {
        console.log(chalk.gray('\n📝 Committing changes...'));
        try {
          execSync('git add clients/');
          execSync(`git commit -m "chore: update API clients to ${spec.info?.version}"`);
          console.log(chalk.green('✅ Changes committed'));
        } catch (e) {
          console.log(chalk.yellow('⚠️  Commit failed (may be no changes)'));
        }
      }
      
      console.log(chalk.green('\n✅ Sync complete'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Sync failed: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * Status command - Show client generation status
 */
client
  .command('status')
  .description('Show client generation status for all languages')
  .action(async () => {
    console.log(chalk.blue('📊 Client Generation Status\n'));
    
    const languages = ['typescript', 'javascript', 'python'];
    
    for (const lang of languages) {
      const outputDir = CLIENT_DIRS[lang];
      const metadataPath = path.join(outputDir, 'client-metadata.json');
      
      if (await fs.pathExists(metadataPath)) {
        const metadata = await fs.readJson(metadataPath);
        console.log(`${lang.padEnd(12)} ${chalk.green('✅ Generated')}`);
        console.log(chalk.gray(`   Version: ${metadata.apiVersion}`));
        console.log(chalk.gray(`   Generated: ${new Date(metadata.generatedAt).toLocaleString()}`));
        console.log(chalk.gray(`   Endpoints: ${metadata.endpoints}`));
      } else {
        console.log(`${lang.padEnd(12)} ${chalk.red('❌ Not generated')}`);
      }
      console.log('');
    }
  });

module.exports = client;
