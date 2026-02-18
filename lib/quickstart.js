/**
 * Quickstart command - Interactive project bootstrap wizard
 *
 * Helps new users set up a new MasterClaw project with sensible defaults:
 * - Project name and directory structure
 * - Configuration files (.env, config.json)
 * - Docker Compose setup (optional)
 * - Sample memory files
 * - Helpful next steps
 *
 * Usage: mc quickstart [project-name]
 */

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const ora = require('ora');
const { execSync } = require('child_process');

// Project templates
const TEMPLATES = {
  minimal: {
    name: 'Minimal',
    description: 'Bare essentials - just core configuration',
    features: ['Basic config', 'Environment setup'],
  },
  standard: {
    name: 'Standard',
    description: 'Recommended setup with Docker and monitoring',
    features: ['Docker Compose', 'Environment setup', 'Monitoring stack', 'Sample memories'],
  },
  complete: {
    name: 'Complete',
    description: 'Full-featured setup with all integrations',
    features: ['Docker Compose', 'Environment setup', 'Monitoring stack', 'Sample memories', 'Backup scripts', 'CI/CD config'],
  },
};

// Default configurations
const DEFAULT_CONFIGS = {
  core: {
    port: 8000,
    host: '0.0.0.0',
    log_level: 'info',
  },
  gateway: {
    port: 8080,
    host: '0.0.0.0',
  },
  memory: {
    backend: 'chroma',
    embedding_model: 'sentence-transformers/all-MiniLM-L6-v2',
  },
};

/**
 * Main quickstart action
 */
async function runQuickstart(projectName, options) {
  console.log(chalk.blue('🐾 MasterClaw Quickstart Wizard\n'));
  console.log(chalk.gray('Let\'s set up your new MasterClaw project!\n'));

  // Get project name if not provided
  if (!projectName) {
    if (options.yes) {
      projectName = 'my-masterclaw-project';
    } else {
      const answer = await inquirer.prompt([{
        type: 'input',
        name: 'name',
        message: 'Project name:',
        default: 'my-masterclaw-project',
        validate: (input) => {
          if (!input.trim()) return 'Project name is required';
          if (!/^[a-z0-9-_]+$/i.test(input)) return 'Use only letters, numbers, hyphens, and underscores';
          return true;
        },
      }]);
      projectName = answer.name;
    }
  }

  // Validate project name
  if (!/^[a-z0-9-_]+$/i.test(projectName)) {
    console.log(chalk.red('❌ Invalid project name. Use only letters, numbers, hyphens, and underscores.'));
    process.exit(1);
  }

  const projectPath = path.resolve(options.directory, projectName);

  // Check if directory already exists
  if (await fs.pathExists(projectPath)) {
    console.log(chalk.red(`❌ Directory already exists: ${projectPath}`));
    process.exit(1);
  }

  // Select template
  let template = options.template;
  if (!options.yes && !TEMPLATES[template]) {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'template',
      message: 'Choose a project template:',
      choices: Object.entries(TEMPLATES).map(([key, t]) => ({
        name: `${t.name} - ${t.description}`,
        value: key,
      })),
      default: 'standard',
    }]);
    template = answer.template;
  }

  const selectedTemplate = TEMPLATES[template] || TEMPLATES.standard;

  // Additional options for non-minimal templates
  let useDocker = !options.skipDocker;
  let initGit = !options.skipGit;
  let llmProvider = 'openai';

  if (!options.yes && template !== 'minimal') {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'docker',
        message: 'Set up Docker Compose?',
        default: true,
      },
      {
        type: 'confirm',
        name: 'git',
        message: 'Initialize git repository?',
        default: true,
      },
      {
        type: 'list',
        name: 'llm',
        message: 'Primary LLM provider:',
        choices: [
          { name: 'OpenAI', value: 'openai' },
          { name: 'Anthropic (Claude)', value: 'anthropic' },
          { name: 'Google (Gemini)', value: 'google' },
          { name: 'Ollama (local)', value: 'ollama' },
          { name: 'Skip for now', value: 'skip' },
        ],
        default: 'openai',
      },
    ]);
    useDocker = answers.docker;
    initGit = answers.git;
    llmProvider = answers.llm;
  }

  // Create project structure
  const spinner = ora('Creating project structure...').start();

  try {
    // Create directories
    await fs.ensureDir(projectPath);
    await fs.ensureDir(path.join(projectPath, 'data'));
    await fs.ensureDir(path.join(projectPath, 'memory'));
    await fs.ensureDir(path.join(projectPath, 'skills'));
    await fs.ensureDir(path.join(projectPath, 'logs'));

    if (template !== 'minimal') {
      await fs.ensureDir(path.join(projectPath, 'scripts'));
      await fs.ensureDir(path.join(projectPath, 'docs'));
      await fs.ensureDir(path.join(projectPath, 'backups'));
    }

    if (template === 'complete') {
      await fs.ensureDir(path.join(projectPath, '.github', 'workflows'));
      await fs.ensureDir(path.join(projectPath, 'tests'));
    }

    spinner.text = 'Creating configuration files...';

    // Create .env file
    const envContent = generateEnvFile(llmProvider);
    await fs.writeFile(path.join(projectPath, '.env'), envContent);
    await fs.writeFile(path.join(projectPath, '.env.example'), envContent.replace(/=.*/g, '='));

    // Create config.json
    const configContent = generateConfigFile(projectName, llmProvider);
    await fs.writeFile(path.join(projectPath, 'config.json'), JSON.stringify(configContent, null, 2));

    // Create README
    const readmeContent = generateReadme(projectName, selectedTemplate, useDocker);
    await fs.writeFile(path.join(projectPath, 'README.md'), readmeContent);

    // Create .gitignore
    const gitignoreContent = generateGitignore();
    await fs.writeFile(path.join(projectPath, '.gitignore'), gitignoreContent);

    // Create sample memory file
    const memoryContent = generateSampleMemory(projectName);
    await fs.writeFile(path.join(projectPath, 'memory', 'welcome.md'), memoryContent);

    spinner.text = 'Setting up template files...';

    // Docker Compose setup
    if (useDocker && template !== 'minimal') {
      const dockerContent = generateDockerCompose(template);
      await fs.writeFile(path.join(projectPath, 'docker-compose.yml'), dockerContent);

      // Create Dockerfile if complete template
      if (template === 'complete') {
        const dockerfileContent = generateDockerfile();
        await fs.writeFile(path.join(projectPath, 'Dockerfile'), dockerfileContent);
      }
    }

    // Complete template extras
    if (template === 'complete') {
      // Backup script
      const backupScript = generateBackupScript();
      await fs.writeFile(path.join(projectPath, 'scripts', 'backup.sh'), backupScript);
      await fs.chmod(path.join(projectPath, 'scripts', 'backup.sh'), 0o755);

      // CI/CD workflow
      const cicdContent = generateCICDWorkflow();
      await fs.writeFile(path.join(projectPath, '.github', 'workflows', 'ci.yml'), cicdContent);

      // Health check script
      const healthScript = generateHealthScript();
      await fs.writeFile(path.join(projectPath, 'scripts', 'health-check.sh'), healthScript);
      await fs.chmod(path.join(projectPath, 'scripts', 'health-check.sh'), 0o755);
    }

    // Initialize git
    if (initGit) {
      spinner.text = 'Initializing git repository...';
      try {
        execSync('git init', { cwd: projectPath, stdio: 'ignore' });
        execSync('git add .', { cwd: projectPath, stdio: 'ignore' });
        execSync('git commit -m "Initial commit: MasterClaw project setup"', {
          cwd: projectPath,
          stdio: 'ignore',
        });
      } catch (err) {
        // Git init failed, continue without it
      }
    }

    spinner.succeed(`Project "${projectName}" created successfully!`);

    // Print summary
    console.log('');
    console.log(chalk.green(`✅ ${selectedTemplate.name} template applied`));
    console.log(chalk.gray(`   Location: ${projectPath}`));
    console.log('');

    console.log(chalk.cyan('Project structure:'));
    await printDirectoryStructure(projectPath, '');
    console.log('');

    console.log(chalk.cyan('Features included:'));
    selectedTemplate.features.forEach(feature => {
      console.log(chalk.gray(`  ✓ ${feature}`));
    });
    console.log('');

    if (llmProvider !== 'skip') {
      console.log(chalk.yellow('⚠️  Remember to set your API key:'));
      console.log(chalk.gray(`   Edit ${path.join(projectName, '.env')} and add your ${llmProvider} API key`));
      console.log('');
    }

    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.white(`  cd ${projectName}`));
    if (useDocker && template !== 'minimal') {
      console.log(chalk.white('  docker-compose up -d'));
    }
    console.log(chalk.white('  mc status'));
    console.log('');

    console.log(chalk.gray('Happy coding! 🐾'));

  } catch (err) {
    spinner.fail('Failed to create project');
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Generate .env file content
 */
function generateEnvFile(llmProvider) {
  const configs = {
    openai: {
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'gpt-4o-mini',
    },
    anthropic: {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'claude-3-sonnet-20240229',
    },
    google: {
      GOOGLE_API_KEY: '',
      GOOGLE_MODEL: 'gemini-pro',
    },
    ollama: {
      OLLAMA_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'llama2',
    },
  };

  let content = '# MasterClaw Environment Configuration\n';
  content += '# Generated by mc quickstart\n\n';

  content += '# Core Settings\n';
  content += 'MC_CORE_PORT=8000\n';
  content += 'MC_GATEWAY_PORT=8080\n';
  content += 'MC_LOG_LEVEL=info\n\n';

  if (llmProvider !== 'skip' && configs[llmProvider]) {
    content += `# ${llmProvider.charAt(0).toUpperCase() + llmProvider.slice(1)} Configuration\n`;
    for (const [key, value] of Object.entries(configs[llmProvider])) {
      content += `${key}=${value}\n`;
    }
    content += '\n';
  }

  content += '# Memory Configuration\n';
  content += 'MC_MEMORY_BACKEND=chroma\n';
  content += 'MC_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2\n\n';

  content += '# Security\n';
  content += 'MC_SECRET_KEY=change-me-in-production-' + Math.random().toString(36).substring(2, 15) + '\n';
  content += 'MC_ENABLE_AUTH=false\n\n';

  content += '# Optional Integrations\n';
  content += '# MC_DISCORD_TOKEN=\n';
  content += '# MC_SLACK_TOKEN=\n';
  content += '# MC_TELEGRAM_TOKEN=\n';

  return content;
}

/**
 * Generate config.json content
 */
function generateConfigFile(projectName, llmProvider) {
  const config = {
    name: projectName,
    version: '0.1.0',
    description: `MasterClaw project: ${projectName}`,
    created: new Date().toISOString(),
    core: {
      port: 8000,
      host: '0.0.0.0',
      log_level: 'info',
    },
    gateway: {
      port: 8080,
      host: '0.0.0.0',
    },
    memory: {
      backend: 'chroma',
      embedding_model: 'sentence-transformers/all-MiniLM-L6-v2',
      max_memories: 10000,
    },
    features: {
      websocket: true,
      analytics: true,
      rate_limiting: true,
    },
  };

  if (llmProvider !== 'skip') {
    config.llm = {
      provider: llmProvider,
      model: getDefaultModel(llmProvider),
      temperature: 0.7,
      max_tokens: 2048,
    };
  }

  return config;
}

/**
 * Get default model for provider
 */
function getDefaultModel(provider) {
  const models = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-sonnet-20240229',
    google: 'gemini-pro',
    ollama: 'llama2',
  };
  return models[provider] || 'unknown';
}

/**
 * Generate README content
 */
function generateReadme(projectName, template, useDocker) {
  let content = `# ${projectName}\n\n`;
  content += `Generated with MasterClaw Quickstart (${template.name} template)\n\n`;

  content += `## Getting Started\n\n`;

  if (useDocker) {
    content += '### Using Docker (Recommended)\n\n';
    content += '```bash\n';
    content += '# Start all services\n';
    content += 'docker-compose up -d\n\n';
    content += '# Check status\n';
    content += 'mc status\n';
    content += '```\n\n';
  }

  content += '### Manual Setup\n\n';
  content += '```bash\n';
  content += '# Install dependencies\n';
  content += 'pip install -r requirements.txt\n\n';
  content += '# Configure environment\n';
  content += 'cp .env.example .env\n';
  content += '# Edit .env with your API keys\n\n';
  content += '# Start the core\n';
  content += 'python -m masterclaw_core\n';
  content += '```\n\n';

  content += `## Project Structure\n\n`;
  content += '- `data/` - Application data\n';
  content += '- `memory/` - Memory files and notes\n';
  content += '- `skills/` - Custom skills\n';
  content += '- `logs/` - Log files\n';

  if (template.name !== 'Minimal') {
    content += '- `scripts/` - Utility scripts\n';
    content += '- `docs/` - Documentation\n';
    content += '- `backups/` - Backup storage\n';
  }

  content += '\n';

  content += `## CLI Commands\n\n`;
  content += '```bash\n';
  content += '# Check system status\n';
  content += 'mc status\n\n';
  content += '# View logs\n';
  content += 'mc logs\n\n';
  content += '# Run diagnostics\n';
  content += 'mc doctor\n';
  content += '```\n\n';

  content += `## Configuration\n\n`;
  content += 'Edit `.env` to configure API keys and settings.\n';
  content += 'Edit `config.json` for advanced configuration.\n\n';

  content += `## Documentation\n\n`;
  content += '- [MasterClaw Documentation](https://github.com/TheMasterClaw/masterclaw-core)\n';
  content += '- [CLI Tools](https://github.com/TheMasterClaw/masterclaw-tools)\n';

  return content;
}

/**
 * Generate .gitignore content
 */
function generateGitignore() {
  return `# MasterClaw\n` +
         `.env\n` +
         `data/*\n` +
         `!data/.gitkeep\n` +
         `logs/*\n` +
         `!logs/.gitkeep\n` +
         `backups/*\n` +
         `!backups/.gitkeep\n` +
         `*.log\n` +
         `.coverage\n` +
         `__pycache__/\n` +
         `*.pyc\n` +
         `.pytest_cache/\n` +
         `node_modules/\n` +
         `.DS_Store\n` +
         `*.swp\n` +
         `*.swo\n` +
         `*~\n`;
}

/**
 * Generate sample memory content
 */
function generateSampleMemory(projectName) {
  const date = new Date().toISOString().split('T')[0];
  return `# Welcome to ${projectName}\n\n` +
         `Created: ${date}\n\n` +
         `## About This Project\n\n` +
         `This is your MasterClaw project memory file. Use this space to:\n\n` +
         `- Document important decisions\n` +
         `- Keep notes about your setup\n` +
         `- Store project context for your AI companion\n` +
         `- Track progress and milestones\n\n` +
         `## Quick Links\n\n` +
         `- Check status: \`mc status\`\n` +
         `- View logs: \`mc logs\`\n` +
         `- Run diagnostics: \`mc doctor\`\n\n` +
         `---\n` +
         `_This file is automatically loaded as context for your AI._\n`;
}

/**
 * Generate docker-compose.yml content
 */
function generateDockerCompose(template) {
  const services = {
    version: '3.8',
    services: {
      core: {
        image: 'themasterclaw/masterclaw-core:latest',
        container_name: 'masterclaw-core',
        ports: ['8000:8000'],
        env_file: ['.env'],
        volumes: [
          './data:/app/data',
          './memory:/app/memory',
          './logs:/app/logs',
        ],
        restart: 'unless-stopped',
        healthcheck: {
          test: ['CMD', 'curl', '-f', 'http://localhost:8000/health'],
          interval: '30s',
          timeout: '10s',
          retries: 3,
        },
      },
      gateway: {
        image: 'themasterclaw/masterclaw-gateway:latest',
        container_name: 'masterclaw-gateway',
        ports: ['8080:8080'],
        env_file: ['.env'],
        environment: [
          'MC_CORE_URL=http://core:8000',
        ],
        depends_on: ['core'],
        restart: 'unless-stopped',
      },
      chroma: {
        image: 'chromadb/chroma:latest',
        container_name: 'masterclaw-chroma',
        volumes: ['./data/chroma:/chroma/chroma'],
        restart: 'unless-stopped',
      },
    },
  };

  if (template === 'complete') {
    services.services.monitoring = {
      image: 'prom/prometheus:latest',
      container_name: 'masterclaw-prometheus',
      ports: ['9090:9090'],
      volumes: ['./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml'],
      restart: 'unless-stopped',
    };
    services.services.grafana = {
      image: 'grafana/grafana:latest',
      container_name: 'masterclaw-grafana',
      ports: ['3000:3000'],
      environment: [
        'GF_SECURITY_ADMIN_PASSWORD=admin',
      ],
      volumes: ['./monitoring/grafana:/var/lib/grafana'],
      restart: 'unless-stopped',
    };
  }

  // Convert to YAML-like format (simplified)
  return `# MasterClaw Docker Compose\n` +
         `# Generated by mc quickstart\n\n` +
         `version: '3.8'\n\n` +
         `services:\n` +
         `  core:\n` +
         `    image: themasterclaw/masterclaw-core:latest\n` +
         `    container_name: masterclaw-core\n` +
         `    ports:\n` +
         `      - "8000:8000"\n` +
         `    env_file:\n` +
         `      - .env\n` +
         `    volumes:\n` +
         `      - ./data:/app/data\n` +
         `      - ./memory:/app/memory\n` +
         `      - ./logs:/app/logs\n` +
         `    restart: unless-stopped\n` +
         `    healthcheck:\n` +
         `      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]\n` +
         `      interval: 30s\n` +
         `      timeout: 10s\n` +
         `      retries: 3\n\n` +
         `  gateway:\n` +
         `    image: themasterclaw/masterclaw-gateway:latest\n` +
         `    container_name: masterclaw-gateway\n` +
         `    ports:\n` +
         `      - "8080:8080"\n` +
         `    env_file:\n` +
         `      - .env\n` +
         `    environment:\n` +
         `      - MC_CORE_URL=http://core:8000\n` +
         `    depends_on:\n` +
         `      - core\n` +
         `    restart: unless-stopped\n\n` +
         `  chroma:\n` +
         `    image: chromadb/chroma:latest\n` +
         `    container_name: masterclaw-chroma\n` +
         `    volumes:\n` +
         `      - ./data/chroma:/chroma/chroma\n` +
         `    restart: unless-stopped\n`;
}

/**
 * Generate Dockerfile content
 */
function generateDockerfile() {
  return `# MasterClaw Dockerfile\n` +
         `# Generated by mc quickstart\n\n` +
         `FROM python:3.11-slim\n\n` +
         `WORKDIR /app\n\n` +
         `# Install system dependencies\n` +
         `RUN apt-get update && apt-get install -y \\\n` +
         `    git \\\n` +
         `    curl \\\n` +
         `    && rm -rf /var/lib/apt/lists/*\n\n` +
         `# Copy requirements and install Python dependencies\n` +
         `COPY requirements.txt .\n` +
         `RUN pip install --no-cache-dir -r requirements.txt\n\n` +
         `# Copy application code\n` +
         `COPY . .\n\n` +
         `# Expose port\n` +
         `EXPOSE 8000\n\n` +
         `# Health check\n` +
         `HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\\n` +
         `    CMD curl -f http://localhost:8000/health || exit 1\n\n` +
         `# Run the application\n` +
         `CMD ["python", "-m", "masterclaw_core"]\n`;
}

/**
 * Generate backup script
 */
function generateBackupScript() {
  return `#!/bin/bash\n` +
         `# MasterClaw Backup Script\n` +
         `# Generated by mc quickstart\n\n` +
         `set -e\n\n` +
         `BACKUP_DIR="./backups"\n` +
         `TIMESTAMP=\$(date +%Y%m%d_%H%M%S)\n` +
         `BACKUP_NAME="masterclaw_backup_\${TIMESTAMP}"\n\n` +
         `echo "Creating backup: \$BACKUP_NAME"\n\n` +
         `# Create backup directory\n` +
         `mkdir -p "\$BACKUP_DIR/\$BACKUP_NAME"\n\n` +
         `# Backup data\n` +
         `if [ -d "./data" ]; then\n` +
         `    cp -r ./data "\$BACKUP_DIR/\$BACKUP_NAME/"\n` +
         `fi\n\n` +
         `# Backup memory\n` +
         `if [ -d "./memory" ]; then\n` +
         `    cp -r ./memory "\$BACKUP_DIR/\$BACKUP_NAME/"\n` +
         `fi\n\n` +
         `# Backup config\n` +
         `cp config.json "\$BACKUP_DIR/\$BACKUP_NAME/" 2>/dev/null || true\n` +
         `cp .env "\$BACKUP_DIR/\$BACKUP_NAME/" 2>/dev/null || true\n\n` +
         `# Create archive\n` +
         `tar -czf "\$BACKUP_DIR/\$BACKUP_NAME.tar.gz" -C "\$BACKUP_DIR" "\$BACKUP_NAME"\n` +
         `rm -rf "\$BACKUP_DIR/\$BACKUP_NAME"\n\n` +
         `echo "Backup created: \$BACKUP_DIR/\$BACKUP_NAME.tar.gz"\n\n` +
         `# Keep only last 10 backups\n` +
         `ls -t "\$BACKUP_DIR"/*.tar.gz | tail -n +11 | xargs rm -f\n\n` +
         `echo "Backup complete!"\n`;
}

/**
 * Generate CI/CD workflow
 */
function generateCICDWorkflow() {
  return `name: CI\n\n` +
         `on:\n` +
         `  push:\n` +
         `    branches: [ main, develop ]\n` +
         `  pull_request:\n` +
         `    branches: [ main ]\n\n` +
         `jobs:\n` +
         `  test:\n` +
         `    runs-on: ubuntu-latest\n\n` +
         `    steps:\n` +
         `    - uses: actions/checkout@v3\n\n` +
         `    - name: Set up Python\n` +
         `      uses: actions/setup-python@v4\n` +
         `      with:\n` +
         `        python-version: '3.11'\n\n` +
         `    - name: Install dependencies\n` +
         `      run: |\n` +
         `        python -m pip install --upgrade pip\n` +
         `        pip install -r requirements.txt\n` +
         `        pip install pytest\n\n` +
         `    - name: Run tests\n` +
         `      run: pytest\n\n` +
         `    - name: Lint with flake8\n` +
         `      run: |\n` +
         `        pip install flake8\n` +
         `        flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics\n\n` +
         `    - name: Validate configuration\n` +
         `      run: |\n` +
         `        python -c "import json; json.load(open('config.json'))"\n`;
}

/**
 * Generate health check script
 */
function generateHealthScript() {
  return `#!/bin/bash\n` +
         `# MasterClaw Health Check Script\n` +
         `# Generated by mc quickstart\n\n` +
         `set -e\n\n` +
         `CORE_URL="\${MC_CORE_URL:-http://localhost:8000}"\n` +
         `GATEWAY_URL="\${MC_GATEWAY_URL:-http://localhost:8080}"\n\n` +
         `echo "Checking MasterClaw health..."\n\n` +
         `# Check Core\n` +
         `echo -n "Core API: "\n` +
         `if curl -sf "\$CORE_URL/health" > /dev/null 2>&1; then\n` +
         `    echo "✓ Healthy"\n` +
         `else\n` +
         `    echo "✗ Unhealthy"\n` +
         `    exit 1\n` +
         `fi\n\n` +
         `# Check Gateway\n` +
         `echo -n "Gateway: "\n` +
         `if curl -sf "\$GATEWAY_URL/health" > /dev/null 2>&1; then\n` +
         `    echo "✓ Healthy"\n` +
         `else\n` +
         `    echo "✗ Unhealthy"\n` +
         `fi\n\n` +
         `echo "Health check complete!"\n`;
}

/**
 * Print directory structure
 */
async function printDirectoryStructure(dirPath, prefix) {
  const entries = await fs.readdir(dirPath);
  const filtered = entries.filter(e => !e.startsWith('.git') && !e.startsWith('node_modules'));

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const fullPath = path.join(dirPath, entry);
    const stats = await fs.stat(fullPath);

    const connector = isLast ? '└── ' : '├── ';
    console.log(chalk.gray(`${prefix}${connector}${entry}`));

    if (stats.isDirectory()) {
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      try {
        const subEntries = await fs.readdir(fullPath);
        if (subEntries.length > 0) {
          // Limit depth
          if (prefix.length < 8) {
            await printDirectoryStructure(fullPath, newPrefix);
          } else {
            console.log(chalk.gray(`${newPrefix}...`));
          }
        }
      } catch (err) {
        // Skip unreadable directories
      }
    }
  }
}

module.exports = {
  runQuickstart,
  TEMPLATES,
};
