/**
 * agent-cmd.js - CLI commands for Agent Hub and Swarm management
 * 
 * Commands:
 *   mc agent hub start              # Start WebSocket agent hub
 *   mc agent hub status             # Show hub status
 *   mc agent hub stop               # Stop the hub
 *   mc agent list                   # List connected agents
 *   mc agent message <agent>        # Send message to agent
 *   mc agent swarm init             # Initialize agent swarm
 *   mc agent swarm run              # Run a task through swarm
 *   mc agent swarm status           # Show swarm status
 * 
 *   mc billing report               # Generate usage report
 *   mc billing quota                # Check quota status
 *   mc billing tier                 # Manage subscription tiers
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');

const { wrapCommand, displayError, ExitCode } = require('./error-handler');
const { getHub, resetHub, MSG_TYPES } = require('./agent-hub');
const { getSwarm, resetSwarm, Agent, TOPOLOGIES, CONSENSUS_TYPES } = require('./agent-swarm');
const { getMetering, EVENT_TYPES } = require('./metering');

// =============================================================================
// Agent Hub Commands
// =============================================================================

function createHubCommand() {
  const hub = new Command('hub');
  hub.description('WebSocket Agent Hub management');

  // Start hub
  hub.command('start')
    .description('Start the WebSocket agent hub')
    .option('-p, --port <port>', 'Port to listen on', '8765')
    .option('-H, --host <host>', 'Host to bind to', '0.0.0.0')
    .option('--no-auth', 'Disable authentication')
    .option('--token <token>', 'Auth token', process.env.AGENT_HUB_TOKEN)
    .action(wrapCommand(async (options) => {
      const spinner = ora('Starting Agent Hub...').start();
      
      try {
        const hubInstance = getHub({
          port: parseInt(options.port),
          host: options.host,
          requireAuth: options.auth,
          authToken: options.token,
        });

        hubInstance.on('connection', ({ clientId, ip }) => {
          console.log(chalk.blue(`\n🔌 New connection: ${clientId} from ${ip}`));
        });

        hubInstance.on('agentRegistered', (agent) => {
          console.log(chalk.cyan(`\n🤖 Agent registered: ${agent.id} (${agent.role})`));
        });

        hubInstance.on('message', (envelope) => {
          const from = envelope.from.agentId || envelope.from.userId;
          console.log(chalk.gray(`\n💬 [${envelope.roomId}] ${from}: ${envelope.content.substring(0, 100)}...`));
        });

        await hubInstance.start();
        spinner.succeed(`Agent Hub running on ws://${options.host}:${options.port}`);
        
        console.log(chalk.gray(`\n  Health:   http://${options.host}:${options.port}/health`));
        console.log(chalk.gray(`  Metrics:  http://${options.host}:${options.port}/metrics`));
        console.log(chalk.gray(`\n  Press Ctrl+C to stop`));
        
        // Keep process alive
        process.on('SIGINT', async () => {
          console.log(chalk.yellow('\n\n🛑 Shutting down...'));
          await hubInstance.stop();
          process.exit(0);
        });
        
        // Wait indefinitely
        await new Promise(() => {});
        
      } catch (error) {
        spinner.fail(`Failed to start hub: ${error.message}`);
        throw error;
      }
    }));

  // Hub status
  hub.command('status')
    .description('Check agent hub status')
    .option('-p, --port <port>', 'Hub port', '8765')
    .option('-H, --host <host>', 'Hub host', 'localhost')
    .action(wrapCommand(async (options) => {
      const spinner = ora('Checking hub status...').start();
      
      try {
        const http = require('http');
        
        const response = await new Promise((resolve, reject) => {
          const req = http.get(`http://${options.host}:${options.port}/health`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
          });
          req.on('error', reject);
          req.setTimeout(5000, () => reject(new Error('Timeout')));
        });
        
        spinner.succeed('Agent Hub is running');
        
        console.log(chalk.blue('\n📊 Hub Status:'));
        console.log(`  Status:      ${chalk.green(response.status)}`);
        console.log(`  Connections: ${response.connections}`);
        console.log(`  Agents:      ${response.agents}`);
        console.log(`  Rooms:       ${response.rooms}`);
        console.log(`  Uptime:      ${Math.floor(response.uptime / 60)}m ${Math.floor(response.uptime % 60)}s`);
        
        if (response.agents > 0) {
          console.log(chalk.blue('\n🤖 Agent Breakdown:'));
          for (const [role, count] of Object.entries(response.agentBreakdown || {})) {
            console.log(`  ${role}: ${count}`);
          }
        }
        
      } catch (error) {
        spinner.fail('Agent Hub is not running or unreachable');
        process.exit(ExitCode.ERROR);
      }
    }));

  return hub;
}

// =============================================================================
// Agent Management Commands
// =============================================================================

function createAgentListCommand() {
  return new Command('list')
    .description('List connected agents')
    .option('-p, --port <port>', 'Hub port', '8765')
    .option('-H, --host <host>', 'Hub host', 'localhost')
    .action(wrapCommand(async (options) => {
      const spinner = ora('Fetching agents...').start();
      
      try {
        const http = require('http');
        
        const response = await new Promise((resolve, reject) => {
          const req = http.get(`http://${options.host}:${options.port}/metrics`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
          });
          req.on('error', reject);
          req.setTimeout(5000, () => reject(new Error('Timeout')));
        });
        
        spinner.stop();
        
        if (response.agents === 0) {
          console.log(chalk.yellow('No agents connected'));
          return;
        }
        
        console.log(chalk.blue(`\n🤖 Connected Agents (${response.agents}):\n`));
        
        // Fetch detailed agent list would require WebSocket connection
        // For now, show breakdown
        for (const [role, count] of Object.entries(response.agentBreakdown || {})) {
          console.log(`  ${chalk.cyan(role.padEnd(15))} ${count}`);
        }
        
      } catch (error) {
        spinner.fail('Failed to fetch agents');
        throw error;
      }
    }));
}

// =============================================================================
// Swarm Commands
// =============================================================================

function createSwarmCommand() {
  const swarm = new Command('swarm');
  swarm.description('Multi-agent swarm orchestration');

  // Initialize swarm
  swarm.command('init')
    .description('Initialize a new agent swarm')
    .option('-t, --topology <type>', 'Swarm topology', 'hierarchical')
    .option('-c, --consensus <type>', 'Consensus type', 'leader')
    .option('--hub', 'Connect to Agent Hub')
    .option('--hub-port <port>', 'Hub port', '8765')
    .action(wrapCommand(async (options) => {
      const spinner = ora('Initializing swarm...').start();
      
      try {
        const swarmInstance = getSwarm({
          topology: options.topology,
          consensusType: options.consensus,
        });

        const hubOptions = options.hub ? { port: options.hubPort } : null;
        await swarmInstance.init(hubOptions);
        
        spinner.succeed('Swarm initialized');
        
        console.log(chalk.blue('\n🐝 Swarm Configuration:'));
        console.log(`  Topology:    ${options.topology}`);
        console.log(`  Consensus:   ${options.consensus}`);
        console.log(`  Hub:         ${options.hub ? `ws://localhost:${options.hubPort}` : 'disabled'}`);
        
        // Pre-populate with default agents
        const coder = Swarm.createCoderAgent();
        const reviewer = Swarm.createReviewerAgent();
        const tester = Swarm.createTesterAgent();
        
        swarmInstance.addAgent(coder, true); // Queen
        swarmInstance.addAgent(reviewer);
        swarmInstance.addAgent(tester);
        
        console.log(chalk.blue('\n🤖 Default Agents Created:'));
        console.log(`  👑 ${coder.name} (Queen)`);
        console.log(`     ${reviewer.name}`);
        console.log(`     ${tester.name}`);
        
        console.log(chalk.gray('\n  Use "mc agent swarm run" to execute tasks'));
        
      } catch (error) {
        spinner.fail('Failed to initialize swarm');
        throw error;
      }
    }));

  // Run task through swarm
  swarm.command('run')
    .description('Run a task through the agent swarm')
    .argument('<task>', 'Task description')
    .option('-a, --agent <role>', 'Starting agent role', 'coder')
    .option('--max-turns <n>', 'Maximum turns', '10')
    .option('--parallel', 'Run with consensus (parallel)')
    .action(wrapCommand(async (task, options) => {
      const spinner = ora('Running swarm task...').start();
      
      try {
        const swarmInstance = getSwarm();
        
        if (!swarmInstance.isRunning) {
          spinner.fail('Swarm not initialized. Run "mc agent swarm init" first.');
          process.exit(ExitCode.ERROR);
        }
        
        // Find starting agent
        const agents = swarmInstance.getAgentsByRole(options.agent);
        if (agents.length === 0) {
          spinner.fail(`No agent with role: ${options.agent}`);
          process.exit(ExitCode.ERROR);
        }
        
        const startingAgent = agents[0];
        
        spinner.text = `Executing with ${startingAgent.name}...`;
        
        const messages = [{ role: 'user', content: task }];
        
        let result;
        if (options.parallel) {
          // Parallel execution with consensus
          const allAgents = Array.from(swarmInstance.agents.values());
          result = await swarmInstance.runParallel({
            agents: allAgents,
            messages,
          });
          
          spinner.succeed('Consensus reached');
          console.log(chalk.blue('\n🗳️ Consensus Result:'));
          console.log(`  Winner:    ${result.consensus.winner}`);
          console.log(`  Agreement: ${(result.consensus.agreement * 100).toFixed(1)}%`);
          
        } else {
          // Sequential execution with handoffs
          result = await swarmInstance.run({
            agent: startingAgent,
            messages,
            maxTurns: parseInt(options.maxTurns),
            debug: true,
          });
          
          spinner.succeed('Task completed');
          console.log(chalk.blue('\n📋 Task History:'));
          
          for (const entry of result.history) {
            console.log(`\n  Turn ${entry.turn}: ${chalk.cyan(entry.agent.name)} (${entry.agent.role})`);
            console.log(`  ${entry.result.content.substring(0, 200)}...`);
          }
          
          console.log(chalk.blue('\n✅ Final Result:'));
          console.log(`  Completed in ${result.turns} turns (${result.duration}ms)`);
          console.log(`  Final agent: ${result.finalAgent.name}`);
        }
        
      } catch (error) {
        spinner.fail('Task failed');
        throw error;
      }
    }));

  // Swarm status
  swarm.command('status')
    .description('Show swarm status')
    .action(wrapCommand(async () => {
      const swarmInstance = getSwarm();
      const status = swarmInstance.getStatus();
      
      console.log(chalk.blue('\n🐝 Swarm Status:\n'));
      console.log(`  Running:     ${status.isRunning ? chalk.green('Yes') : chalk.red('No')}`);
      console.log(`  Topology:    ${status.topology}`);
      console.log(`  Consensus:   ${status.consensusType}`);
      console.log(`  Agents:      ${status.agentCount}`);
      console.log(`  Active Tasks: ${status.activeTasks}`);
      
      if (status.queen) {
        console.log(`  Queen:       ${status.queen.name} (${status.queen.role})`);
      }
      
      if (status.agents.length > 0) {
        console.log(chalk.blue('\n  Agents:'));
        for (const agent of status.agents) {
          const statusEmoji = agent.status === 'idle' ? '🟢' : 
                            agent.status === 'busy' ? '🔵' : '🔴';
          console.log(`    ${statusEmoji} ${agent.name.padEnd(15)} ${agent.role}`);
        }
      }
    }));

  // Stop swarm
  swarm.command('stop')
    .description('Stop the swarm')
    .action(wrapCommand(async () => {
      const spinner = ora('Stopping swarm...').start();
      
      try {
        const swarmInstance = getSwarm();
        await swarmInstance.stop();
        resetSwarm();
        
        spinner.succeed('Swarm stopped');
      } catch (error) {
        spinner.fail('Failed to stop swarm');
        throw error;
      }
    }));

  return swarm;
}

// =============================================================================
// Billing Commands
// =============================================================================

function createBillingCommand() {
  const billing = new Command('billing');
  billing.description('Usage metering and billing');

  // Usage report
  billing.command('report')
    .description('Generate usage report')
    .option('-u, --user <id>', 'User ID', 'default')
    .option('-s, --start <date>', 'Start date (YYYY-MM-DD)')
    .option('-e, --end <date>', 'End date (YYYY-MM-DD)')
    .option('-f, --format <type>', 'Output format (json/csv)', 'json')
    .action(wrapCommand(async (options) => {
      const spinner = ora('Generating report...').start();
      
      try {
        const metering = getMetering();
        await metering.init();
        
        // Default to current month if no dates provided
        const now = new Date();
        const startDate = options.start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const endDate = options.end || now.toISOString().split('T')[0];
        
        const report = await metering.exportReport(
          options.user,
          startDate,
          endDate,
          options.format
        );
        
        spinner.succeed('Report generated');
        
        if (options.format === 'csv') {
          console.log('\n' + report);
        } else {
          console.log('\n' + JSON.stringify(report, null, 2));
        }
        
      } catch (error) {
        spinner.fail('Failed to generate report');
        throw error;
      }
    }));

  // Check quota
  billing.command('quota')
    .description('Check quota status')
    .option('-u, --user <id>', 'User ID', 'default')
    .action(wrapCommand(async (options) => {
      const spinner = ora('Checking quota...').start();
      
      try {
        const metering = getMetering();
        await metering.init();
        
        const quota = metering.getRemainingQuota(options.user);
        const tier = metering.getUserTier(options.user);
        
        spinner.succeed('Quota retrieved');
        
        console.log(chalk.blue(`\n📊 Quota Status for ${options.user}:\n`));
        console.log(`  Tier:           ${chalk.cyan(tier.toUpperCase())}`);
        console.log(`  Messages:       ${quota.messages === Infinity ? '∞' : quota.messages}`);
        console.log(`  API Calls:      ${quota.apiCalls === Infinity ? '∞' : quota.apiCalls}`);
        console.log(`  Swarm Tasks:    ${quota.swarmTasks === Infinity ? '∞' : quota.swarmTasks}`);
        console.log(`  Storage:        ${quota.storageMB} MB`);
        
      } catch (error) {
        spinner.fail('Failed to check quota');
        throw error;
      }
    }));

  // Manage tiers
  billing.command('tier')
    .description('Manage subscription tier')
    .option('-u, --user <id>', 'User ID', 'default')
    .option('-s, --set <tier>', 'Set tier (free/starter/pro/enterprise)')
    .action(wrapCommand(async (options) => {
      const metering = getMetering();
      await metering.init();
      
      if (options.set) {
        const spinner = ora(`Setting tier to ${options.set}...`).start();
        
        try {
          metering.setUserTier(options.user, options.set);
          spinner.succeed(`Tier updated to ${options.set}`);
        } catch (error) {
          spinner.fail('Failed to set tier');
          throw error;
        }
      } else {
        const currentTier = metering.getUserTier(options.user);
        
        console.log(chalk.blue(`\n💳 Current Tier: ${currentTier.toUpperCase()}\n`));
        console.log('Available tiers:');
        
        const tiers = metering.quotas;
        for (const [name, config] of Object.entries(tiers)) {
          const marker = name === currentTier ? '→' : ' ';
          const price = config.pricePerMonth ? `$${config.pricePerMonth}/mo` : 'Free';
          console.log(`  ${marker} ${name.padEnd(12)} ${price.padEnd(10)} ${config.messagesPerDay === Infinity ? 'Unlimited' : config.messagesPerDay + ' msgs/day'}`);
        }
      }
    }));

  return billing;
}

// =============================================================================
// Main Agent Command
// =============================================================================

function createAgentCommand() {
  const agent = new Command('agent');
  agent.description('Agent Hub and Swarm management');

  // Add subcommands
  agent.addCommand(createHubCommand());
  agent.addCommand(createAgentListCommand());
  agent.addCommand(createSwarmCommand());
  agent.addCommand(createBillingCommand());

  // Quick message command
  agent.command('message <agentId> <message>')
    .description('Send a message to an agent')
    .option('-H, --host <host>', 'Hub host', 'localhost')
    .option('-p, --port <port>', 'Hub port', '8765')
    .action(wrapCommand(async (agentId, message, options) => {
      const spinner = ora(`Sending message to ${agentId}...`).start();
      
      try {
        const WebSocket = require('ws');
        
        const ws = new WebSocket(`ws://${options.host}:${options.port}`);
        
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            // Authenticate
            ws.send(JSON.stringify({
              type: MSG_TYPES.AUTH,
              userId: 'cli-user',
            }));
            
            // Send message
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: MSG_TYPES.MESSAGE,
                targetAgentId: agentId,
                content: message,
              }));
            }, 100);
            
            setTimeout(() => {
              ws.close();
              resolve();
            }, 500);
          });
          
          ws.on('error', reject);
        });
        
        spinner.succeed('Message sent');
        
      } catch (error) {
        spinner.fail('Failed to send message');
        throw error;
      }
    }));

  return agent;
}

module.exports = {
  createAgentCommand,
  // Export for testing
  createHubCommand,
  createSwarmCommand,
  createBillingCommand,
};
