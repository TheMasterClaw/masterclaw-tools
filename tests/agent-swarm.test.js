/**
 * agent-swarm.test.js - Tests for Agent Swarm orchestration
 */

const { Swarm, Agent, Result, TOPOLOGIES, CONSENSUS_TYPES, AGENT_STATUS } = require('../lib/agent-swarm');

describe('AgentSwarm', () => {
  let swarm;

  beforeEach(() => {
    swarm = new Swarm({
      topology: TOPOLOGIES.HIERARCHICAL,
      consensusType: CONSENSUS_TYPES.LEADER,
    });
  });

  afterEach(async () => {
    if (swarm) {
      await swarm.stop();
    }
  });

  describe('Swarm Initialization', () => {
    test('should initialize with correct defaults', () => {
      expect(swarm.topology).toBe(TOPOLOGIES.HIERARCHICAL);
      expect(swarm.consensusType).toBe(CONSENSUS_TYPES.LEADER);
      expect(swarm.agents.size).toBe(0);
      expect(swarm.isRunning).toBe(false);
    });

    test('should initialize and emit events', async () => {
      const initSpy = jest.fn();
      swarm.on('initialized', initSpy);
      
      await swarm.init();
      
      expect(swarm.isRunning).toBe(true);
      expect(initSpy).toHaveBeenCalled();
    });

    test('should stop gracefully', async () => {
      await swarm.init();
      
      const stopSpy = jest.fn();
      swarm.on('stopped', stopSpy);
      
      await swarm.stop();
      
      expect(swarm.isRunning).toBe(false);
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('Agent Management', () => {
    test('should add agent to swarm', () => {
      const agent = new Agent({ name: 'TestAgent', role: 'coder' });
      const addedSpy = jest.fn();
      swarm.on('agentAdded', addedSpy);
      
      swarm.addAgent(agent);
      
      expect(swarm.agents.has(agent.id)).toBe(true);
      expect(addedSpy).toHaveBeenCalledWith(agent);
    });

    test('should set first agent as queen in hierarchical topology', () => {
      const agent1 = new Agent({ name: 'Agent1', role: 'coder' });
      const agent2 = new Agent({ name: 'Agent2', role: 'tester' });
      
      swarm.addAgent(agent1);
      swarm.addAgent(agent2);
      
      expect(swarm.queen).toBe(agent1);
    });

    test('should respect isQueen parameter', () => {
      const agent1 = new Agent({ name: 'Agent1', role: 'coder' });
      const agent2 = new Agent({ name: 'Agent2', role: 'tester' });
      
      swarm.addAgent(agent1);
      swarm.addAgent(agent2, true); // Force as queen
      
      expect(swarm.queen).toBe(agent2);
    });

    test('should enforce max agents limit', () => {
      swarm.maxAgents = 2;
      
      const agent1 = new Agent({ name: 'Agent1' });
      const agent2 = new Agent({ name: 'Agent2' });
      const agent3 = new Agent({ name: 'Agent3' });
      
      swarm.addAgent(agent1);
      swarm.addAgent(agent2);
      
      expect(() => swarm.addAgent(agent3)).toThrow('Swarm at capacity');
    });

    test('should remove agent', () => {
      const agent = new Agent({ name: 'TestAgent' });
      swarm.addAgent(agent);
      
      const removed = swarm.removeAgent(agent.id);
      
      expect(removed).toBe(true);
      expect(swarm.agents.has(agent.id)).toBe(false);
    });

    test('should clear queen when queen is removed', () => {
      const agent = new Agent({ name: 'QueenAgent' });
      swarm.addAgent(agent, true);
      expect(swarm.queen).toBe(agent);
      
      swarm.removeAgent(agent.id);
      expect(swarm.queen).toBeNull();
    });

    test('should get agents by role', () => {
      const coder1 = new Agent({ name: 'Coder1', role: 'coder' });
      const coder2 = new Agent({ name: 'Coder2', role: 'coder' });
      const tester = new Agent({ name: 'Tester', role: 'tester' });
      
      swarm.addAgent(coder1);
      swarm.addAgent(coder2);
      swarm.addAgent(tester);
      
      const coders = swarm.getAgentsByRole('coder');
      expect(coders.length).toBe(2);
      
      const testers = swarm.getAgentsByRole('tester');
      expect(testers.length).toBe(1);
    });

    test('should get available (idle) agents', () => {
      const agent1 = new Agent({ name: 'Agent1' });
      const agent2 = new Agent({ name: 'Agent2' });
      agent2.status = AGENT_STATUS.BUSY;
      
      swarm.addAgent(agent1);
      swarm.addAgent(agent2);
      
      const available = swarm.getAvailableAgents();
      expect(available.length).toBe(1);
      expect(available[0]).toBe(agent1);
    });
  });

  describe('Agent Execution', () => {
    test('should execute agent and return result', async () => {
      const agent = new Agent({
        name: 'TestAgent',
        instructions: 'You are a test agent',
      });
      
      const result = await agent.execute([{ role: 'user', content: 'Hello' }]);
      
      expect(result.success).toBe(true);
      expect(result.agent).toBe(agent);
      expect(result.content).toBeDefined();
    });

    test('should track agent stats', async () => {
      const agent = new Agent({ name: 'TestAgent' });
      
      expect(agent.stats.tasksCompleted).toBe(0);
      
      await agent.execute([{ role: 'user', content: 'Hello' }]);
      
      expect(agent.stats.tasksCompleted).toBe(1);
      expect(agent.stats.avgResponseTime).toBeGreaterThanOrEqual(0);
    });

    test('should handle agent errors', async () => {
      const agent = new Agent({ name: 'TestAgent' });
      
      // Mock LLM call to throw error
      agent.callLLM = async () => {
        throw new Error('LLM failure');
      };
      
      const result = await agent.execute([{ role: 'user', content: 'Hello' }]);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('LLM failure');
      expect(agent.stats.tasksFailed).toBe(1);
      expect(agent.status).toBe(AGENT_STATUS.ERROR);
    });

    test('should update context variables', async () => {
      const agent = new Agent({ name: 'TestAgent' });
      
      const result = await agent.execute(
        [{ role: 'user', content: 'Hello' }],
        { userName: 'Rex', project: 'masterclaw' }
      );
      
      expect(agent.context.userName).toBe('Rex');
      expect(agent.context.project).toBe('masterclaw');
    });
  });

  describe('Agent Tools', () => {
    test('should add tool to agent', () => {
      const agent = new Agent({ name: 'TestAgent' });
      const toolFn = jest.fn();
      
      agent.addTool('testTool', toolFn, 'A test tool', { param1: 'string' });
      
      expect(agent.tools.length).toBe(1);
      expect(agent.tools[0].name).toBe('testTool');
      expect(agent.tools[0].fn).toBe(toolFn);
    });

    test('should add handoff tool', () => {
      const agent1 = new Agent({ name: 'Agent1' });
      const agent2 = new Agent({ name: 'Agent2' });
      
      agent1.addHandoff(agent2);
      
      expect(agent1.tools.length).toBe(1);
      expect(agent1.tools[0].name).toBe('transfer_to_Agent2');
    });

    test('should execute tools', async () => {
      const agent = new Agent({ name: 'TestAgent' });
      const toolFn = jest.fn().mockResolvedValue({ result: 'success' });
      
      agent.addTool('testTool', toolFn);
      
      const toolCalls = [
        { name: 'testTool', arguments: { arg1: 'value1' } },
      ];
      
      const results = await swarm.executeTools(agent, toolCalls);
      
      expect(toolFn).toHaveBeenCalledWith({ arg1: 'value1' });
      expect(results[0].result).toEqual({ result: 'success' });
    });

    test('should handle tool errors', async () => {
      const agent = new Agent({ name: 'TestAgent' });
      const toolFn = jest.fn().mockRejectedValue(new Error('Tool failed'));
      
      agent.addTool('testTool', toolFn);
      
      const toolCalls = [{ name: 'testTool', arguments: {} }];
      const results = await swarm.executeTools(agent, toolCalls);
      
      expect(results[0].error).toBe('Tool failed');
    });
  });

  describe('Consensus', () => {
    test('should reach majority consensus', () => {
      const results = [
        { content: 'Option A', agent: { capabilities: [] } },
        { content: 'Option A', agent: { capabilities: [] } },
        { content: 'Option B', agent: { capabilities: [] } },
      ];
      
      const consensus = swarm.majorityConsensus(results);
      
      expect(consensus.winner).toBe('Option A');
      expect(consensus.votes).toBe(2);
      expect(consensus.agreement).toBe(2 / 3);
    });

    test('should reach weighted consensus', () => {
      const results = [
        { content: 'Option A', agent: { capabilities: ['expert'] } },
        { content: 'Option B', agent: { capabilities: ['expert', 'senior'] } },
        { content: 'Option B', agent: { capabilities: ['junior'] } },
      ];
      
      const consensus = swarm.weightedConsensus(results);
      
      expect(consensus.totalWeight).toBe(4); // 1 + 2 + 1
    });

    test('should reach Byzantine consensus with 2/3 majority', () => {
      const results = [
        { content: 'Option A', agent: {} },
        { content: 'Option A', agent: {} },
        { content: 'Option A', agent: {} },
        { content: 'Option B', agent: {} },
      ];
      
      const consensus = swarm.byzantineConsensus(results);
      
      expect(consensus.byzantineSafe).toBe(true);
      expect(consensus.required).toBe(2); // ceil(2 * (4-1) / 3) = 2
    });

    test('should fail Byzantine consensus without majority', () => {
      const results = [
        { content: 'Option A', agent: {} },
        { content: 'Option B', agent: {} },
        { content: 'Option C', agent: {} },
      ];
      
      const consensus = swarm.byzantineConsensus(results);
      
      expect(consensus.winner).toBeNull();
      expect(consensus.error).toContain('No Byzantine consensus');
    });

    test('should use leader consensus', () => {
      const queen = new Agent({ name: 'Queen', role: 'architect' });
      swarm.addAgent(queen, true);
      
      const results = [
        { content: 'Option A', agent: queen },
        { content: 'Option B', agent: { name: 'Worker' } },
      ];
      
      const consensus = swarm.leaderConsensus(results);
      
      expect(consensus.winner).toBe('Option A');
      expect(consensus.leader).toBe('Queen');
    });
  });

  describe('Topology Management', () => {
    test('should change topology', () => {
      const changedSpy = jest.fn();
      swarm.on('topologyChanged', changedSpy);
      
      swarm.setTopology(TOPOLOGIES.MESH);
      
      expect(swarm.topology).toBe(TOPOLOGIES.MESH);
      expect(changedSpy).toHaveBeenCalledWith({ topology: TOPOLOGIES.MESH });
    });

    test('should reject invalid topology', () => {
      expect(() => swarm.setTopology('invalid')).toThrow('Invalid topology');
    });

    test('should change consensus type', () => {
      swarm.setConsensusType(CONSENSUS_TYPES.BYZANTINE);
      expect(swarm.consensusType).toBe(CONSENSUS_TYPES.BYZANTINE);
    });

    test('should reject invalid consensus type', () => {
      expect(() => swarm.setConsensusType('invalid')).toThrow('Invalid consensus type');
    });
  });

  describe('Factory Methods', () => {
    test('should create coder agent', () => {
      const agent = Swarm.createCoderAgent({ name: 'MyCoder' });
      
      expect(agent.name).toBe('MyCoder');
      expect(agent.role).toBe('coder');
      expect(agent.capabilities).toContain('coding');
    });

    test('should create reviewer agent', () => {
      const agent = Swarm.createReviewerAgent();
      
      expect(agent.role).toBe('reviewer');
      expect(agent.capabilities).toContain('code-review');
    });

    test('should create tester agent', () => {
      const agent = Swarm.createTesterAgent();
      
      expect(agent.role).toBe('tester');
      expect(agent.capabilities).toContain('unit-testing');
    });

    test('should create architect agent', () => {
      const agent = Swarm.createArchitectAgent();
      
      expect(agent.role).toBe('architect');
      expect(agent.capabilities).toContain('system-design');
    });

    test('should create security agent', () => {
      const agent = Swarm.createSecurityAgent();
      
      expect(agent.role).toBe('security');
      expect(agent.capabilities).toContain('vulnerability-scanning');
    });
  });

  describe('Status and Metrics', () => {
    test('should return swarm status', () => {
      const agent = new Agent({ name: 'TestAgent' });
      swarm.addAgent(agent);
      
      const status = swarm.getStatus();
      
      expect(status.topology).toBe(TOPOLOGIES.HIERARCHICAL);
      expect(status.agentCount).toBe(1);
      expect(status.agents.length).toBe(1);
    });
  });
});

// Integration tests for full swarm run
describe('Swarm Integration', () => {
  let swarm;

  beforeEach(async () => {
    swarm = new Swarm({ topology: TOPOLOGIES.HIERARCHICAL });
    await swarm.init();
    
    // Add default agents
    const coder = Swarm.createCoderAgent();
    const reviewer = Swarm.createReviewerAgent();
    swarm.addAgent(coder, true); // Queen
    swarm.addAgent(reviewer);
  });

  afterEach(async () => {
    await swarm.stop();
  });

  test('should run task with single agent', async () => {
    const coder = swarm.getAgentsByRole('coder')[0];
    
    const result = await swarm.run({
      agent: coder,
      messages: [{ role: 'user', content: 'Write a hello world function' }],
      maxTurns: 3,
    });
    
    expect(result.taskId).toBeDefined();
    expect(result.turns).toBeGreaterThan(0);
    expect(result.history.length).toBeGreaterThan(0);
  });

  test('should emit taskComplete event', async () => {
    const taskCompleteSpy = jest.fn();
    swarm.on('taskComplete', taskCompleteSpy);
    
    const coder = swarm.getAgentsByRole('coder')[0];
    
    await swarm.run({
      agent: coder,
      messages: [{ role: 'user', content: 'Test' }],
      maxTurns: 1,
    });
    
    expect(taskCompleteSpy).toHaveBeenCalled();
  });

  test('should enforce max turns', async () => {
    const coder = swarm.getAgentsByRole('coder')[0];
    
    await expect(swarm.run({
      agent: coder,
      messages: [{ role: 'user', content: 'Test' }],
      maxTurns: 1,
    })).rejects.toThrow('Maximum turns (1) reached');
  });

  test('should run parallel execution', async () => {
    const agents = Array.from(swarm.agents.values());
    
    const result = await swarm.runParallel({
      agents,
      messages: [{ role: 'user', content: 'Review this code' }],
    });
    
    expect(result.results.length).toBe(agents.length);
    expect(result.consensus).toBeDefined();
  });
});
