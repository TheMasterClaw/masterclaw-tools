/**
 * Benchmark Module - Performance testing for MasterClaw
 * 
 * Features:
 * - LLM provider/model benchmark comparisons
 * - Memory search performance testing
 * - API endpoint load testing
 * - Historical trend tracking
 * - Regression detection
 */

const chalk = require('chalk');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { findInfraDir } = require('./services');

// Benchmark history storage
const BENCHMARK_HISTORY_FILE = 'benchmark-history.json';
const MAX_HISTORY_ENTRIES = 100;

// Default benchmark configuration
const DEFAULT_CONFIG = {
  llmTests: [
    { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o' },
    { provider: 'openai', model: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { provider: 'anthropic', model: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { provider: 'anthropic', model: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
  ],
  testPrompts: [
    { name: 'short', prompt: 'Say hello in 5 words.', expectedTokens: 10 },
    { name: 'medium', prompt: 'Explain the concept of Docker containers in 3 sentences.', expectedTokens: 80 },
    { name: 'long', prompt: 'Write a detailed analysis of the benefits and drawbacks of microservices architecture versus monolithic architecture. Include specific examples and trade-offs.', expectedTokens: 300 },
  ],
  iterations: 3,
  memoryTests: {
    entriesToAdd: 100,
    searchIterations: 50,
  },
  apiTests: {
    concurrentRequests: 10,
    totalRequests: 100,
  },
};

/**
 * Get benchmark history storage path
 */
async function getHistoryPath() {
  const configDir = path.join(require('os').homedir(), '.masterclaw');
  await fs.ensureDir(configDir);
  return path.join(configDir, BENCHMARK_HISTORY_FILE);
}

/**
 * Load benchmark history
 */
async function loadHistory() {
  try {
    const historyPath = await getHistoryPath();
    if (await fs.pathExists(historyPath)) {
      return await fs.readJson(historyPath);
    }
  } catch (error) {
    // Ignore errors, return empty history
  }
  return { runs: [], created: new Date().toISOString() };
}

/**
 * Save benchmark history
 */
async function saveHistory(history) {
  const historyPath = await getHistoryPath();
  
  // Trim old entries
  if (history.runs.length > MAX_HISTORY_ENTRIES) {
    history.runs = history.runs.slice(-MAX_HISTORY_ENTRIES);
  }
  
  await fs.writeJson(historyPath, history, { spaces: 2 });
}

/**
 * Format duration for display
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format throughput (tokens/second)
 */
function formatThroughput(tokens, ms) {
  const tps = tokens / (ms / 1000);
  return `${tps.toFixed(1)} t/s`;
}

/**
 * Calculate statistics from an array of numbers
 */
function calculateStats(values) {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, median: 0, p95: 0 };
  
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.floor(sorted.length * 0.95);
  const p95 = sorted[Math.min(p95Index, sorted.length - 1)];
  
  return { min, max, avg, median, p95 };
}

/**
 * Run a single LLM benchmark test
 */
async function runLLMTest(apiUrl, test, config) {
  const results = [];
  
  for (let i = 0; i < config.iterations; i++) {
    const startTime = Date.now();
    let firstTokenTime = null;
    let tokenCount = 0;
    
    try {
      // Use streaming to measure time-to-first-token
      const response = await axios.post(
        `${apiUrl}/v1/chat`,
        {
          message: test.prompt,
          provider: config.provider,
          model: config.model,
          stream: true,
        },
        {
          responseType: 'text',
          timeout: 60000,
          transformResponse: [(data) => data], // Don't parse JSON
        }
      );
      
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      // Parse streaming response to count tokens (approximate)
      const lines = response.data.split('\n').filter(line => line.trim());
      let responseText = '';
      
      for (const line of lines) {
        try {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;
            const parsed = JSON.parse(jsonStr);
            if (parsed.token) {
              if (!firstTokenTime) firstTokenTime = Date.now();
              responseText += parsed.token;
            }
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
      
      // Estimate tokens (rough: 4 chars per token)
      tokenCount = Math.ceil(responseText.length / 4);
      
      results.push({
        iteration: i + 1,
        totalTime,
        timeToFirstToken: firstTokenTime ? firstTokenTime - startTime : totalTime,
        tokenCount,
        tokensPerSecond: tokenCount / (totalTime / 1000),
        success: true,
      });
    } catch (error) {
      results.push({
        iteration: i + 1,
        totalTime: Date.now() - startTime,
        timeToFirstToken: null,
        tokenCount: 0,
        tokensPerSecond: 0,
        success: false,
        error: error.message,
      });
    }
    
    // Small delay between iterations
    if (i < config.iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return results;
}

/**
 * Run LLM benchmarks
 */
async function runLLMBenchmarks(apiUrl, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const results = [];
  
  console.log(chalk.blue('\n🧪 LLM Provider Benchmarks'));
  console.log(chalk.gray(`Running ${config.iterations} iterations per test...\n`));
  
  for (const testPrompt of config.testPrompts) {
    console.log(chalk.yellow(`Test: ${testPrompt.name} (${testPrompt.expectedTokens} expected tokens)`));
    
    for (const modelConfig of config.llmTests) {
      process.stdout.write(`  ${modelConfig.name}... `);
      
      const testResults = await runLLMTest(apiUrl, testPrompt, {
        ...config,
        provider: modelConfig.provider,
        model: modelConfig.model,
      });
      
      const successful = testResults.filter(r => r.success);
      const successRate = (successful.length / testResults.length) * 100;
      
      if (successful.length > 0) {
        const times = successful.map(r => r.totalTime);
        const ttfts = successful.map(r => r.timeToFirstToken).filter(Boolean);
        const tps = successful.map(r => r.tokensPerSecond);
        
        const timeStats = calculateStats(times);
        const ttfStats = calculateStats(ttfts);
        const tpsStats = calculateStats(tps);
        
        results.push({
          test: testPrompt.name,
          provider: modelConfig.provider,
          model: modelConfig.model,
          name: modelConfig.name,
          successRate,
          timeStats,
          ttfStats,
          tpsStats,
          rawResults: testResults,
        });
        
        console.log(chalk.green(`✓ ${formatDuration(timeStats.avg)} avg, ${formatThroughput(testPrompt.expectedTokens, timeStats.avg)}`));
      } else {
        results.push({
          test: testPrompt.name,
          provider: modelConfig.provider,
          model: modelConfig.model,
          name: modelConfig.name,
          successRate: 0,
          error: testResults[0]?.error || 'Unknown error',
          rawResults: testResults,
        });
        
        console.log(chalk.red(`✗ Failed (${testResults[0]?.error || 'Unknown'})`));
      }
    }
    
    console.log('');
  }
  
  return results;
}

/**
 * Run memory benchmarks
 */
async function runMemoryBenchmarks(apiUrl, options = {}) {
  const config = { ...DEFAULT_CONFIG.memoryTests, ...options };
  
  console.log(chalk.blue('\n💾 Memory Store Benchmarks'));
  console.log(chalk.gray(`Adding ${config.entriesToAdd} entries, ${config.searchIterations} searches...\n`));
  
  // Test add performance
  process.stdout.write('  Adding entries... ');
  const addStart = Date.now();
  const addTimes = [];
  
  for (let i = 0; i < config.entriesToAdd; i++) {
    const entryStart = Date.now();
    try {
      await axios.post(`${apiUrl}/v1/memory/add`, {
        content: `Benchmark test entry ${i}: This is a test memory for performance benchmarking.`,
        metadata: { benchmark: true, index: i },
        source: 'benchmark',
      });
      addTimes.push(Date.now() - entryStart);
    } catch (error) {
      // Ignore errors
    }
  }
  
  const addStats = calculateStats(addTimes);
  console.log(chalk.green(`✓ ${formatDuration(addStats.avg)} avg per entry`));
  
  // Test search performance
  process.stdout.write('  Searching memories... ');
  const searchTimes = [];
  const searchQueries = [
    'benchmark test',
    'performance',
    'memory entry',
    'test data',
    'artificial intelligence',
  ];
  
  for (let i = 0; i < config.searchIterations; i++) {
    const query = searchQueries[i % searchQueries.length];
    const searchStart = Date.now();
    
    try {
      await axios.post(`${apiUrl}/v1/memory/search`, {
        query,
        top_k: 5,
      });
      searchTimes.push(Date.now() - searchStart);
    } catch (error) {
      // Ignore errors
    }
  }
  
  const searchStats = calculateStats(searchTimes);
  console.log(chalk.green(`✓ ${formatDuration(searchStats.avg)} avg per search`));
  
  // Cleanup
  process.stdout.write('  Cleaning up... ');
  try {
    const searchResults = await axios.post(`${apiUrl}/v1/memory/search`, {
      query: 'benchmark test',
      top_k: config.entriesToAdd,
      filter_metadata: { benchmark: true },
    });
    
    if (searchResults.data?.results) {
      for (const result of searchResults.data.results) {
        try {
          await axios.delete(`${apiUrl}/v1/memory/${result.id}`);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    console.log(chalk.green('✓'));
  } catch (error) {
    console.log(chalk.yellow('⚠ (some entries may remain)'));
  }
  
  return {
    add: addStats,
    search: searchStats,
    entriesAdded: config.entriesToAdd,
    searchesPerformed: config.searchIterations,
  };
}

/**
 * Run API endpoint benchmarks
 */
async function runAPIBenchmarks(apiUrl, options = {}) {
  const config = { ...DEFAULT_CONFIG.apiTests, ...options };
  
  console.log(chalk.blue('\n🌐 API Endpoint Benchmarks'));
  console.log(chalk.gray(`${config.totalRequests} requests, ${config.concurrentRequests} concurrent...\n`));
  
  const endpoints = [
    { name: 'health', method: 'GET', path: '/health' },
    { name: 'chat', method: 'POST', path: '/v1/chat', body: { message: 'Hello', use_memory: false } },
    { name: 'memory_search', method: 'POST', path: '/v1/memory/search', body: { query: 'test', top_k: 5 } },
  ];
  
  const results = [];
  
  for (const endpoint of endpoints) {
    process.stdout.write(`  /${endpoint.name}... `);
    
    const times = [];
    const errors = [];
    
    // Run requests in batches
    const batches = Math.ceil(config.totalRequests / config.concurrentRequests);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchSize = Math.min(config.concurrentRequests, config.totalRequests - batch * config.concurrentRequests);
      const batchPromises = [];
      
      for (let i = 0; i < batchSize; i++) {
        batchPromises.push((async () => {
          const start = Date.now();
          try {
            await axios({
              method: endpoint.method,
              url: `${apiUrl}${endpoint.path}`,
              data: endpoint.body,
              timeout: 30000,
            });
            times.push(Date.now() - start);
          } catch (error) {
            errors.push(error.message);
          }
        })());
      }
      
      await Promise.all(batchPromises);
    }
    
    const stats = calculateStats(times);
    const successRate = (times.length / config.totalRequests) * 100;
    
    results.push({
      endpoint: endpoint.name,
      stats,
      successRate,
      totalRequests: config.totalRequests,
      successfulRequests: times.length,
      failedRequests: errors.length,
    });
    
    const statusColor = successRate >= 95 ? chalk.green : successRate >= 80 ? chalk.yellow : chalk.red;
    console.log(statusColor(`✓ ${formatDuration(stats.avg)} avg, ${successRate.toFixed(0)}% success`));
  }
  
  return results;
}

/**
 * Compare current results with historical baseline
 */
async function compareWithBaseline(currentResults, history) {
  if (!history.runs || history.runs.length === 0) {
    return null;
  }
  
  // Get the most recent successful run as baseline
  const baseline = history.runs
    .filter(r => r.success && r.results?.llm)
    .pop();
  
  if (!baseline) return null;
  
  const comparisons = [];
  
  // Compare LLM results
  for (const current of currentResults.llm || []) {
    const baselineResult = (baseline.results.llm || []).find(
      b => b.test === current.test && b.model === current.model
    );
    
    if (baselineResult?.timeStats?.avg && current.timeStats?.avg) {
      const timeDiff = ((current.timeStats.avg - baselineResult.timeStats.avg) / baselineResult.timeStats.avg) * 100;
      comparisons.push({
        test: `${current.name} (${current.test})`,
        metric: 'response_time',
        change: timeDiff,
        baseline: baselineResult.timeStats.avg,
        current: current.timeStats.avg,
      });
    }
  }
  
  return comparisons;
}

/**
 * Display benchmark results
 */
function displayResults(results, comparisons = null) {
  console.log(chalk.blue('\n📊 Benchmark Results Summary'));
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // LLM Results table
  if (results.llm?.length > 0) {
    console.log(chalk.bold('LLM Performance:'));
    console.log('─'.repeat(70));
    console.log(`${'Model'.padEnd(20)} ${'Test'.padEnd(10)} ${'Avg Time'.padEnd(12)} ${'Throughput'.padEnd(12)} ${'Success'}`);
    console.log('─'.repeat(70));
    
    for (const r of results.llm) {
      if (r.timeStats) {
        const model = r.name.padEnd(20).substring(0, 20);
        const test = r.test.padEnd(10);
        const time = formatDuration(r.timeStats.avg).padEnd(12);
        const throughput = formatThroughput(100, r.timeStats.avg).padEnd(12);
        const success = r.successRate >= 95 ? chalk.green('✓') : chalk.yellow('~');
        console.log(`${model} ${test} ${time} ${throughput} ${success} ${r.successRate.toFixed(0)}%`);
      }
    }
    console.log('');
  }
  
  // Memory Results
  if (results.memory) {
    console.log(chalk.bold('Memory Store Performance:'));
    console.log('─'.repeat(50));
    console.log(`  Add entry:    ${formatDuration(results.memory.add.avg)} avg (${formatDuration(results.memory.add.p95)} p95)`);
    console.log(`  Search:       ${formatDuration(results.memory.search.avg)} avg (${formatDuration(results.memory.search.p95)} p95)`);
    console.log('');
  }
  
  // API Results
  if (results.api?.length > 0) {
    console.log(chalk.bold('API Endpoint Performance:'));
    console.log('─'.repeat(50));
    for (const r of results.api) {
      const status = r.successRate >= 95 ? chalk.green : r.successRate >= 80 ? chalk.yellow : chalk.red;
      console.log(`  /${r.endpoint.padEnd(15)} ${formatDuration(r.stats.avg).padEnd(12)} ${status(`${r.successRate.toFixed(0)}% success`)}`);
    }
    console.log('');
  }
  
  // Comparisons with baseline
  if (comparisons?.length > 0) {
    console.log(chalk.bold('Performance Changes vs Baseline:'));
    console.log('─'.repeat(50));
    for (const c of comparisons) {
      const changeIcon = c.change > 10 ? '🔴' : c.change > 5 ? '🟡' : c.change < -10 ? '🟢' : '⚪';
      const changeStr = `${c.change > 0 ? '+' : ''}${c.change.toFixed(1)}%`;
      const color = c.change > 10 ? chalk.red : c.change > 5 ? chalk.yellow : c.change < -10 ? chalk.green : chalk.gray;
      console.log(`  ${changeIcon} ${c.test.padEnd(30)} ${color(changeStr)}`);
    }
    console.log('');
  }
}

/**
 * Main benchmark runner
 */
async function runBenchmarks(options = {}) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  
  // Determine API URL
  const infraDir = await findInfraDir();
  let apiUrl = options.apiUrl || 'http://localhost:8000';
  
  if (infraDir) {
    // Try to get from config or environment
    try {
      const config = require('./config');
      const cfg = config.loadConfig();
      if (cfg.api?.url) {
        apiUrl = cfg.api.url;
      }
    } catch (e) {
      // Use default
    }
  }
  
  console.log(chalk.blue('🐾 MasterClaw Performance Benchmark'));
  console.log(chalk.gray(`Target: ${apiUrl}`));
  console.log(chalk.gray(`Started: ${new Date().toLocaleString()}\n`));
  
  // Check if API is accessible
  try {
    await axios.get(`${apiUrl}/health`, { timeout: 5000 });
  } catch (error) {
    console.log(chalk.red('❌ API is not accessible'));
    console.log(chalk.gray(`   Tried: ${apiUrl}/health`));
    console.log(chalk.gray(`   Error: ${error.message}\n`));
    console.log(chalk.yellow('💡 Make sure MasterClaw is running:'));
    console.log(chalk.gray('   mc status'));
    console.log(chalk.gray('   mc revive\n'));
    return null;
  }
  
  console.log(chalk.green('✓ API is reachable\n'));
  
  const results = {
    timestamp,
    apiUrl,
    success: true,
  };
  
  // Run selected benchmarks
  if (!options.skipLLM) {
    try {
      results.llm = await runLLMBenchmarks(apiUrl, options);
    } catch (error) {
      console.log(chalk.red(`\n❌ LLM benchmarks failed: ${error.message}`));
      results.llm = null;
    }
  }
  
  if (!options.skipMemory) {
    try {
      results.memory = await runMemoryBenchmarks(apiUrl, options);
    } catch (error) {
      console.log(chalk.red(`\n❌ Memory benchmarks failed: ${error.message}`));
      results.memory = null;
    }
  }
  
  if (!options.skipAPI) {
    try {
      results.api = await runAPIBenchmarks(apiUrl, options);
    } catch (error) {
      console.log(chalk.red(`\n❌ API benchmarks failed: ${error.message}`));
      results.api = null;
    }
  }
  
  // Calculate total duration
  results.duration = Date.now() - startTime;
  results.success = !!(results.llm || results.memory || results.api);
  
  // Load history and compare
  const history = await loadHistory();
  const comparisons = await compareWithBaseline(results, history);
  
  // Display results
  displayResults(results, comparisons);
  
  // Save to history
  history.runs.push({
    timestamp,
    apiUrl,
    duration: results.duration,
    success: results.success,
    results: {
      llm: results.llm,
      memory: results.memory,
      api: results.api,
    },
  });
  
  await saveHistory(history);
  
  console.log(chalk.gray(`\nBenchmark completed in ${formatDuration(results.duration)}`));
  console.log(chalk.gray(`Results saved to: ${await getHistoryPath()}\n`));
  
  return results;
}

/**
 * Show benchmark history
 */
async function showHistory(options = {}) {
  const history = await loadHistory();
  
  console.log(chalk.blue('\n📈 Benchmark History'));
  console.log('═══════════════════════════════════════════════════════════\n');
  
  if (!history.runs || history.runs.length === 0) {
    console.log(chalk.yellow('No benchmark history found.'));
    console.log(chalk.gray('\nRun your first benchmark:'));
    console.log(chalk.gray('  mc benchmark\n'));
    return;
  }
  
  console.log(chalk.gray(`Total runs: ${history.runs.length}`));
  console.log(chalk.gray(`Created: ${new Date(history.created).toLocaleDateString()}\n`));
  
  // Show recent runs
  const recent = options.all ? history.runs : history.runs.slice(-10);
  
  console.log(chalk.bold('Recent Benchmark Runs:'));
  console.log('─'.repeat(80));
  console.log(`${'Date'.padEnd(20)} ${'Duration'.padEnd(12)} ${'LLM'.padEnd(8)} ${'Memory'.padEnd(8)} ${'API'.padEnd(8)} ${'Status'}`);
  console.log('─'.repeat(80));
  
  for (const run of recent) {
    const date = new Date(run.timestamp).toLocaleString().padEnd(20);
    const duration = formatDuration(run.duration).padEnd(12);
    const llm = (run.results?.llm ? '✓' : '✗').padEnd(8);
    const memory = (run.results?.memory ? '✓' : '✗').padEnd(8);
    const api = (run.results?.api ? '✓' : '✗').padEnd(8);
    const status = run.success ? chalk.green('✓ pass') : chalk.red('✗ fail');
    
    console.log(`${date} ${duration} ${llm} ${memory} ${api} ${status}`);
  }
  
  console.log('');
}

/**
 * Compare two benchmark runs
 */
async function compareRuns(run1Index, run2Index) {
  const history = await loadHistory();
  
  if (history.runs.length < 2) {
    console.log(chalk.yellow('\nNeed at least 2 benchmark runs to compare.'));
    return;
  }
  
  const runs = history.runs.filter(r => r.success);
  const run1 = runs[runs.length - 2]; // Second to last
  const run2 = runs[runs.length - 1]; // Last
  
  console.log(chalk.blue('\n📊 Benchmark Comparison'));
  console.log('═══════════════════════════════════════════════════════════\n');
  
  console.log(`Comparing:`);
  console.log(`  Baseline:  ${new Date(run1.timestamp).toLocaleString()}`);
  console.log(`  Current:   ${new Date(run2.timestamp).toLocaleString()}\n`);
  
  // Compare LLM results
  if (run1.results?.llm && run2.results?.llm) {
    console.log(chalk.bold('LLM Performance Changes:'));
    console.log('─'.repeat(70));
    
    for (const current of run2.results.llm) {
      const baseline = run1.results.llm.find(
        b => b.test === current.test && b.model === current.model
      );
      
      if (baseline?.timeStats?.avg && current.timeStats?.avg) {
        const change = ((current.timeStats.avg - baseline.timeStats.avg) / baseline.timeStats.avg) * 100;
        const changeStr = `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
        const color = change > 10 ? chalk.red : change > 5 ? chalk.yellow : change < -10 ? chalk.green : chalk.gray;
        const arrow = change > 0 ? '↑' : '↓';
        
        console.log(`  ${current.name} (${current.test})`);
        console.log(`    ${arrow} ${color(changeStr)}  ${formatDuration(baseline.timeStats.avg)} → ${formatDuration(current.timeStats.avg)}`);
      }
    }
    console.log('');
  }
  
  // Compare memory results
  if (run1.results?.memory && run2.results?.memory) {
    console.log(chalk.bold('Memory Performance Changes:'));
    console.log('─'.repeat(50));
    
    const addChange = ((run2.results.memory.add.avg - run1.results.memory.add.avg) / run1.results.memory.add.avg) * 100;
    const searchChange = ((run2.results.memory.search.avg - run1.results.memory.search.avg) / run1.results.memory.search.avg) * 100;
    
    const addColor = addChange > 10 ? chalk.red : addChange > 5 ? chalk.yellow : addChange < -10 ? chalk.green : chalk.gray;
    const searchColor = searchChange > 10 ? chalk.red : searchChange > 5 ? chalk.yellow : searchChange < -10 ? chalk.green : chalk.gray;
    
    console.log(`  Add:    ${addChange > 0 ? '↑' : '↓'} ${addColor(`${addChange > 0 ? '+' : ''}${addChange.toFixed(1)}%`)}`);
    console.log(`  Search: ${searchChange > 0 ? '↑' : '↓'} ${searchColor(`${searchChange > 0 ? '+' : ''}${searchChange.toFixed(1)}%`)}`);
    console.log('');
  }
}

/**
 * Export benchmark results
 */
async function exportResults(format = 'json', outputPath = null) {
  const history = await loadHistory();
  
  if (!outputPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    outputPath = `masterclaw-benchmark-${timestamp}.${format}`;
  }
  
  let content;
  if (format === 'json') {
    content = JSON.stringify(history, null, 2);
  } else if (format === 'csv') {
    // Simple CSV export of runs
    const lines = ['timestamp,duration_ms,success,llm_count,memory_add_avg,memory_search_avg'];
    for (const run of history.runs) {
      lines.push([
        run.timestamp,
        run.duration,
        run.success,
        run.results?.llm?.length || 0,
        run.results?.memory?.add?.avg || 0,
        run.results?.memory?.search?.avg || 0,
      ].join(','));
    }
    content = lines.join('\n');
  }
  
  await fs.writeFile(outputPath, content);
  console.log(chalk.green(`\n✓ Exported benchmark history to: ${outputPath}\n`));
}

module.exports = {
  runBenchmarks,
  showHistory,
  compareRuns,
  exportResults,
  // For testing
  calculateStats,
  formatDuration,
  formatThroughput,
};
