/**
 * agent-swarm.js - Multi-Agent Swarm Orchestration for MasterClaw
 * 
 * Orchestrates multiple agents working together on complex tasks.
 * Features:
 * - Hierarchical agent swarms (queen/workers)
 * - Mesh topology for peer-to-peer collaboration
 * - Agent handoffs for task delegation
 * - Consensus-based decision making
 * - Context variable sharing
 * - Streaming responses
 * 
 * Inspired by OpenAI Swarm patterns but optimized for MasterClaw.
 * 
 * Usage:
 *   const swarm = require('./lib/agent-swarm');
 *   await swarm.init({ topology: 'hierarchical' });
 *   const result = await swarm.run({ agent: coderAgent, messages: [...] });
 */

const chalk = require('chalk');
const crypto = require('crypto');
const EventEmitter = require('events');

// MasterClaw integrations
const agentHub = require('./agent-hub');
const metering = require('./metering');
const memory = require('./memory');
const { wrapCommand } = require('./error-handler');

// =============================================================================
// Constants
// =============================================================================

const TOPOLOGIES = {
  HIERARCHICAL: 'hierarchical', // Queen coordinates workers
  MESH: 'mesh',                 // Peer-to-peer
  RING: 'ring',                 // Circular message passing
  STAR: 'star',                 // Central hub
};

const CONSENSUS_TYPES = {
  MAJORITY: 'majority',         // Simple majority vote
  WEIGHTED: 'weighted',         // Weighted by agent expertise
  BYZANTINE: 'byzantine',       // Fault-tolerant (2/3 majority)
  LEADER: 'leader',             // Queen decides
};

const AGENT_STATUS = {
  IDLE: 'idle',
  BUSY: 'busy',
  ERROR: 'error',
  OFFLINE: 'offline',
};

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

// =============================================================================
// Agent Class
// =============================================================================

class Agent {
  constructor(options = {}) {
    this.id = options.id || this.generateId();
    this.name = options.name || `Agent-${this.id.slice(0, 8)}`;
    this.role = options.role || 'general';
    this.instructions = options.instructions || '';
    this.tools = options.tools || [];
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens || 4096;
    this.capabilities = options.capabilities || [];
    this.metadata = options.metadata || {};
    
    // Runtime state
    this.status = AGENT_STATUS.IDLE;
    this.context = {};
    this.messageHistory = [];
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalTokensUsed: 0,
      avgResponseTime: 0,
    };
  }

  generateId() {
    return crypto.randomUUID();
  }

  /**
   * Add a tool/function to this agent
   */
  addTool(name, fn, description = '', parameters = {}) {
    this.tools.push({
      name,
      fn,
      description,
      parameters,
    });
    return this;
  }

  /**
   * Add a handoff function to transfer to another agent
   */
  addHandoff(targetAgent, condition = null) {
    this.addTool(
      `transfer_to_${targetAgent.name}`,
      () => ({ agent: targetAgent, contextVariables: {} }),
      `Transfer control to ${targetAgent.name}`,
      {}
    );
    return this;
  }

  /**
   * Execute this agent on a task
   */
  async execute(messages, contextVariables = {}) {
    const startTime = Date.now();
    this.status = AGENT_STATUS.BUSY;

    try {
      // Update context
      this.context = { ...this.context, ...contextVariables };
      
      // Build system prompt with instructions and tools
      const systemPrompt = this.buildSystemPrompt();
      
      // Call LLM (placeholder - integrate with actual LLM client)
      const response = await this.callLLM(systemPrompt, messages);
      
      // Update stats
      const duration = Date.now() - startTime;
      this.stats.tasksCompleted++;
      this.stats.avgResponseTime = 
        (this.stats.avgResponseTime * (this.stats.tasksCompleted - 1) + duration) / this.stats.tasksCompleted;
      
      this.status = AGENT_STATUS.IDLE;
      
      return {
        success: true,
        content: response.content,
        toolCalls: response.toolCalls || [],
        contextVariables: this.context,
        agent: this,
        usage: response.usage,
      };
    } catch (error) {
      this.status = AGENT_STATUS.ERROR;
      this.stats.tasksFailed++;
      
      return {
        success: false,
        error: error.message,
        agent: this,
      };
    }
  }

  buildSystemPrompt() {
    let prompt = this.instructions;
    
    if (this.tools.length > 0) {
      prompt += '\n\nYou have access to the following tools:\n';
      for (const tool of this.tools) {
        prompt += `- ${tool.name}: ${tool.description}\n`;
      }
      prompt += '\nUse the tools by calling them when needed.';
    }
    
    return prompt;
  }

  async callLLM(systemPrompt, messages) {
    // Placeholder: Integrate with actual LLM provider
    // This would call Claude, GPT, etc.
    
    // For now, return a mock response
    return {
      content: `[${this.name}] Processed ${messages.length} messages`,
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 50 },
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      status: this.status,
      capabilities: this.capabilities,
      stats: this.stats,
    };
  }
}

// =============================================================================
// Swarm Class
// =============================================================================

class Swarm extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.topology = options.topology || TOPOLOGIES.HIERARCHICAL;
    this.consensusType = options.consensusType || CONSENSUS_TYPES.LEADER;
    this.maxAgents = options.maxAgents || 10;
    this.agents = new Map(); // agentId -> Agent
    this.queen = null; // For hierarchical topology
    this.hub = null; // AgentHub connection
    
    // Swarm state
    this.isRunning = false;
    this.tasks = new Map(); // taskId -> task state
    this.sharedContext = {};
    
    // Consensus state
    this.votes = new Map();
    this.proposals = new Map();
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async init(hubOptions = null) {
    console.log(chalk.blue(`🐝 Initializing Swarm (${this.topology} topology)`));
    
    // Connect to AgentHub if provided
    if (hubOptions) {
      this.hub = agentHub.getHub(hubOptions);
      await this.hub.start();
      
      // Listen for agent events
      this.hub.on('agentRegistered', (agent) => {
        this.emit('agentJoined', agent);
      });
      
      this.hub.on('agentUnregistered', ({ agentId }) => {
        this.agents.delete(agentId);
        this.emit('agentLeft', { agentId });
      });
    }
    
    this.isRunning = true;
    this.emit('initialized');
    return this;
  }

  async stop() {
    console.log(chalk.yellow('🛑 Stopping Swarm...'));
    
    this.isRunning = false;
    
    // Stop all agents
    for (const agent of this.agents.values()) {
      agent.status = AGENT_STATUS.OFFLINE;
    }
    
    // Disconnect from hub
    if (this.hub) {
      await this.hub.stop();
    }
    
    this.emit('stopped');
  }

  // ===========================================================================
  // Agent Management
  // ===========================================================================

  addAgent(agent, isQueen = false) {
    if (this.agents.size >= this.maxAgents) {
      throw new Error(`Swarm at capacity (${this.maxAgents} agents)`);
    }
    
    this.agents.set(agent.id, agent);
    
    if (isQueen || (this.topology === TOPOLOGIES.HIERARCHICAL && !this.queen)) {
      this.queen = agent;
      console.log(chalk.cyan(`👑 ${agent.name} set as Queen`));
    }
    
    // Register with hub if connected
    if (this.hub) {
      // Agent would register itself via WebSocket
    }
    
    this.emit('agentAdded', agent);
    return this;
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    if (this.queen?.id === agentId) {
      this.queen = null;
    }
    
    this.agents.delete(agentId);
    this.emit('agentRemoved', { agentId });
    return true;
  }

  getAgent(agentId) {
    return this.agents.get(agentId);
  }

  getAgentsByRole(role) {
    return Array.from(this.agents.values()).filter(a => a.role === role);
  }

  getAvailableAgents() {
    return Array.from(this.agents.values()).filter(a => a.status === AGENT_STATUS.IDLE);
  }

  // ===========================================================================
  // Core Execution
  // ===========================================================================

  /**
   * Run a task through the swarm
   */
  async run(options) {
    const {
      agent,
      messages,
      contextVariables = {},
      maxTurns = DEFAULT_MAX_TURNS,
      debug = false,
    } = options;

    const taskId = this.generateId();
    const startTime = Date.now();
    
    console.log(chalk.blue(`🚀 Swarm task started: ${taskId}`));
    
    // Initialize task state
    const task = {
      id: taskId,
      agent,
      messages: [...messages],
      contextVariables: { ...contextVariables },
      history: [],
      turnCount: 0,
      debug,
      startTime,
    };
    
    this.tasks.set(taskId, task);
    
    // Record usage for billing
    metering.recordEvent('swarm.task.started', {
      taskId,
      agentId: agent.id,
      agentRole: agent.role,
    });

    try {
      let currentAgent = agent;
      
      // Execute turns
      while (task.turnCount < maxTurns) {
        task.turnCount++;
        
        if (debug) {
        console.log(chalk.gray(`  Turn ${task.turnCount}: ${currentAgent.name} (${currentAgent.role})`));
        }
        
        // Execute current agent
        const result = await currentAgent.execute(
          task.messages,
          task.contextVariables
        );
        
        // Record in history
        task.history.push({
          turn: task.turnCount,
          agent: currentAgent.toJSON(),
          result,
          timestamp: Date.now(),
        });
        
        // Handle result
        if (!result.success) {
          throw new Error(`Agent ${currentAgent.name} failed: ${result.error}`);
        }
        
        // Update context variables
        task.contextVariables = { ...task.contextVariables, ...result.contextVariables };
        
        // Check for handoff
        const handoff = this.detectHandoff(result);
        if (handoff) {
          if (debug) {
            console.log(chalk.yellow(`  ↳ Handoff: ${currentAgent.name} → ${handoff.agent.name}`));
          }
          currentAgent = handoff.agent;
          task.contextVariables = { ...task.contextVariables, ...handoff.contextVariables };
          continue;
        }
        
        // Check for tool calls
        if (result.toolCalls?.length > 0) {
          const toolResults = await this.executeTools(currentAgent, result.toolCalls);
          task.messages.push({
            role: 'tool',
            content: JSON.stringify(toolResults),
          });
          continue;
        }
        
        // Task complete
        const duration = Date.now() - startTime;
        
        metering.recordEvent('swarm.task.completed', {
          taskId,
          duration,
          turns: task.turnCount,
          agentId: currentAgent.id,
        });
        
        const finalResult = {
          taskId,
          messages: task.messages,
          history: task.history,
          contextVariables: task.contextVariables,
          finalAgent: currentAgent.toJSON(),
          turns: task.turnCount,
          duration,
        };
        
        this.emit('taskComplete', finalResult);
        this.tasks.delete(taskId);
        
        return finalResult;
      }
      
      // Max turns reached
      throw new Error(`Maximum turns (${maxTurns}) reached`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      metering.recordEvent('swarm.task.failed', {
        taskId,
        duration,
        error: error.message,
      });
      
      this.emit('taskError', { taskId, error });
      this.tasks.delete(taskId);
      
      throw error;
    }
  }

  /**
   * Run a task and stream results
   */
  async *runStream(options) {
    const result = await this.run(options);
    
    // Yield each turn's output
    for (const entry of result.history) {
      yield {
        turn: entry.turn,
        agent: entry.agent,
        content: entry.result.content,
        timestamp: entry.timestamp,
      };
    }
    
    // Yield final result
    yield {
      type: 'complete',
      contextVariables: result.contextVariables,
      finalAgent: result.finalAgent,
    };
  }

  /**
   * Run a task with multiple agents in parallel (for consensus)
   */
  async runParallel(options) {
    const { agents, messages, contextVariables = {}, consensusType = this.consensusType } = options;
    
    console.log(chalk.blue(`🔄 Running parallel consensus (${consensusType}) with ${agents.length} agents`));
    
    // Execute all agents in parallel
    const results = await Promise.all(
      agents.map(agent => agent.execute(messages, contextVariables))
    );
    
    // Gather consensus
    const consensus = await this.gatherConsensus(results, consensusType);
    
    return {
      results,
      consensus,
      consensusType,
    };
  }

  // ===========================================================================
  // Tools & Handoffs
  // ===========================================================================

  detectHandoff(result) {
    // Check if result indicates a handoff
    if (result.content?.includes('HANDOFF:')) {
      const match = result.content.match(/HANDOFF:\s*(\w+)/);
      if (match) {
        const targetAgentName = match[1];
        for (const agent of this.agents.values()) {
          if (agent.name === targetAgentName) {
            return { agent, contextVariables: {} };
          }
        }
      }
    }
    
    // Check tool results for handoff
    for (const toolCall of result.toolCalls || []) {
      if (toolCall.result?.agent instanceof Agent) {
        return {
          agent: toolCall.result.agent,
          contextVariables: toolCall.result.contextVariables || {},
        };
      }
    }
    
    return null;
  }

  async executeTools(agent, toolCalls) {
    const results = [];
    
    for (const call of toolCalls) {
      const tool = agent.tools.find(t => t.name === call.name);
      if (!tool) {
        results.push({ error: `Tool not found: ${call.name}` });
        continue;
      }
      
      try {
        const result = await tool.fn(call.arguments);
        results.push({ name: call.name, result });
      } catch (error) {
        results.push({ name: call.name, error: error.message });
      }
    }
    
    return results;
  }

  // ===========================================================================
  // Consensus
  // ===========================================================================

  async gatherConsensus(results, consensusType) {
    switch (consensusType) {
      case CONSENSUS_TYPES.MAJORITY:
        return this.majorityConsensus(results);
      
      case CONSENSUS_TYPES.WEIGHTED:
        return this.weightedConsensus(results);
      
      case CONSENSUS_TYPES.BYZANTINE:
        return this.byzantineConsensus(results);
      
      case CONSENSUS_TYPES.LEADER:
        return this.leaderConsensus(results);
      
      default:
        return this.majorityConsensus(results);
    }
  }

  majorityConsensus(results) {
    // Simple majority vote on content similarity
    const contents = results.map(r => r.content);
    const counts = {};
    
    for (const content of contents) {
      counts[content] = (counts[content] || 0) + 1;
    }
    
    const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    
    return {
      winner: winner[0],
      votes: winner[1],
      total: results.length,
      agreement: winner[1] / results.length,
    };
  }

  weightedConsensus(results) {
    // Weight by agent expertise/capabilities
    let totalWeight = 0;
    let weightedSum = {};
    
    for (const result of results) {
      const weight = result.agent.capabilities?.length || 1;
      totalWeight += weight;
      
      const content = result.content;
      weightedSum[content] = (weightedSum[content] || 0) + weight;
    }
    
    const winner = Object.entries(weightedSum).sort((a, b) => b[1] - a[1])[0];
    
    return {
      winner: winner[0],
      weightedVotes: winner[1],
      totalWeight,
      agreement: winner[1] / totalWeight,
    };
  }

  byzantineConsensus(results) {
    // Byzantine fault tolerance (2/3 majority required)
    const f = Math.floor((results.length - 1) / 3); // Max faulty nodes
    const requiredVotes = Math.ceil(2 * (results.length - f) / 3);
    
    const contents = results.map(r => r.content);
    const counts = {};
    
    for (const content of contents) {
      counts[content] = (counts[content] || 0) + 1;
    }
    
    const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    
    if (winner[1] >= requiredVotes) {
      return {
        winner: winner[0],
        votes: winner[1],
        required: requiredVotes,
        total: results.length,
        byzantineSafe: true,
      };
    }
    
    return {
      winner: null,
      error: 'No Byzantine consensus reached',
      maxVotes: winner[1],
      required: requiredVotes,
    };
  }

  leaderConsensus(results) {
    // Queen decides
    if (this.queen) {
      const queenResult = results.find(r => r.agent.id === this.queen.id);
      if (queenResult) {
        return {
          winner: queenResult.content,
          leader: this.queen.name,
          votes: 1,
          total: results.length,
        };
      }
    }
    
    // Fallback to first result
    return {
      winner: results[0]?.content,
      leader: null,
      fallback: true,
    };
  }

  // ===========================================================================
  // Topology Management
  // ===========================================================================

  setTopology(topology) {
    if (!Object.values(TOPOLOGIES).includes(topology)) {
      throw new Error(`Invalid topology: ${topology}`);
    }
    this.topology = topology;
    this.emit('topologyChanged', { topology });
  }

  setConsensusType(consensusType) {
    if (!Object.values(CONSENSUS_TYPES).includes(consensusType)) {
      throw new Error(`Invalid consensus type: ${consensusType}`);
    }
    this.consensusType = consensusType;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  generateId() {
    return crypto.randomUUID();
  }

  getStatus() {
    return {
      topology: this.topology,
      consensusType: this.consensusType,
      isRunning: this.isRunning,
      agentCount: this.agents.size,
      agents: Array.from(this.agents.values()).map(a => a.toJSON()),
      queen: this.queen?.toJSON(),
      activeTasks: this.tasks.size,
    };
  }

  // ===========================================================================
  // Pre-built Agent Factories
  // ===========================================================================

  static createCoderAgent(options = {}) {
    return new Agent({
      name: options.name || 'Coder',
      role: 'coder',
      instructions: `You are an expert software developer. Write clean, well-documented code.
Follow best practices and consider edge cases.
When you complete a task, hand off to the reviewer for code review.`,
      capabilities: ['coding', 'debugging', 'refactoring', 'testing'],
      ...options,
    });
  }

  static createReviewerAgent(options = {}) {
    return new Agent({
      name: options.name || 'Reviewer',
      role: 'reviewer',
      instructions: `You are a code reviewer. Analyze code for bugs, security issues, and style violations.
Provide constructive feedback. If code looks good, approve it.`,
      capabilities: ['code-review', 'security-audit', 'style-check'],
      ...options,
    });
  }

  static createTesterAgent(options = {}) {
    return new Agent({
      name: options.name || 'Tester',
      role: 'tester',
      instructions: `You are a QA engineer. Write comprehensive tests and verify functionality.
Report any bugs found with clear reproduction steps.`,
      capabilities: ['unit-testing', 'integration-testing', 'e2e-testing'],
      ...options,
    });
  }

  static createArchitectAgent(options = {}) {
    return new Agent({
      name: options.name || 'Architect',
      role: 'architect',
      instructions: `You are a system architect. Design scalable, maintainable systems.
Make technology decisions and define interfaces between components.`,
      capabilities: ['system-design', 'tech-selection', 'api-design'],
      ...options,
    });
  }

  static createSecurityAgent(options = {}) {
    return new Agent({
      name: options.name || 'Security',
      role: 'security',
      instructions: `You are a security specialist. Identify vulnerabilities and suggest fixes.
Follow OWASP guidelines and security best practices.`,
      capabilities: ['vulnerability-scanning', 'penetration-testing', 'compliance'],
      ...options,
    });
  }
}

// =============================================================================
// Result Class for Handoffs
// =============================================================================

class Result {
  constructor(options = {}) {
    this.value = options.value;
    this.agent = options.agent;
    this.contextVariables = options.contextVariables || {};
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

let swarmInstance = null;

function getSwarm(options = {}) {
  if (!swarmInstance) {
    swarmInstance = new Swarm(options);
  }
  return swarmInstance;
}

function resetSwarm() {
  if (swarmInstance) {
    swarmInstance.removeAllListeners();
    swarmInstance = null;
  }
}

module.exports = {
  Swarm,
  Agent,
  Result,
  getSwarm,
  resetSwarm,
  TOPOLOGIES,
  CONSENSUS_TYPES,
  AGENT_STATUS,
};
