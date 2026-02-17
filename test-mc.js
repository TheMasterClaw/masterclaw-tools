#!/usr/bin/env node
// Debug version of mc.js to trace the error

console.log('DEBUG: Starting mc.js load...');

try {
  console.log('DEBUG: Loading commander...');
  const { Command } = require('commander');
  console.log('DEBUG: Commander loaded');
  
  console.log('DEBUG: Loading chalk...');
  const chalk = require('chalk');
  console.log('DEBUG: chalk loaded');
  
  console.log('DEBUG: Loading fs-extra...');
  const fs = require('fs-extra');
  console.log('DEBUG: fs-extra loaded');
  
  console.log('DEBUG: Loading path...');
  const path = require('path');
  console.log('DEBUG: path loaded');
  
  console.log('DEBUG: Loading services...');
  const { getAllStatuses, findInfraDir } = require('./lib/services');
  console.log('DEBUG: services loaded');
  
  console.log('DEBUG: Loading config...');
  const config = require('./lib/config');
  console.log('DEBUG: config loaded');
  
  console.log('DEBUG: Loading docker...');
  const docker = require('./lib/docker');
  console.log('DEBUG: docker loaded');
  
  console.log('DEBUG: Loading memory...');
  const memory = require('./lib/memory');
  console.log('DEBUG: memory loaded');
  
  console.log('DEBUG: Loading task...');
  const task = require('./lib/task');
  console.log('DEBUG: task loaded');
  
  console.log('DEBUG: Loading session...');
  const session = require('./lib/session');
  console.log('DEBUG: session loaded');
  
  console.log('DEBUG: Loading deploy...');
  const deploy = require('./lib/deploy');
  console.log('DEBUG: deploy loaded');
  
  console.log('DEBUG: Loading health...');
  const health = require('./lib/health');
  console.log('DEBUG: health loaded');
  
  console.log('DEBUG: Loading logs...');
  const logs = require('./lib/logs');
  console.log('DEBUG: logs loaded');
  
  console.log('DEBUG: Loading restore...');
  const restore = require('./lib/restore');
  console.log('DEBUG: restore loaded');
  
  console.log('DEBUG: Loading cleanup...');
  const cleanup = require('./lib/cleanup');
  console.log('DEBUG: cleanup loaded');
  
  console.log('DEBUG: Loading completion...');
  const completion = require('./lib/completion');
  console.log('DEBUG: completion loaded');
  
  console.log('DEBUG: Loading importer...');
  const importer = require('./lib/import');
  console.log('DEBUG: importer loaded');
  
  console.log('DEBUG: Loading deps...');
  const deps = require('./lib/deps');
  console.log('DEBUG: deps loaded');
  
  console.log('DEBUG: Loading cost...');
  const cost = require('./lib/cost');
  console.log('DEBUG: cost loaded');
  
  console.log('DEBUG: Loading env...');
  const env = require('./lib/env');
  console.log('DEBUG: env loaded, name:', env.program.name());
  
  console.log('DEBUG: Creating main program...');
  const program = new Command();
  program.name('mc').version('0.15.0');
  console.log('DEBUG: Main program created');
  
  console.log('DEBUG: Adding cleanup command...');
  program.addCommand(cleanup);
  console.log('DEBUG: cleanup added');
  
  console.log('DEBUG: Adding completion command...');
  program.addCommand(completion);
  console.log('DEBUG: completion added');
  
  console.log('DEBUG: Adding importer command...');
  program.addCommand(importer);
  console.log('DEBUG: importer added');
  
  console.log('DEBUG: Adding deps command...');
  program.addCommand(deps);
  console.log('DEBUG: deps added');
  
  console.log('DEBUG: Adding cost command...');
  program.addCommand(cost);
  console.log('DEBUG: cost added');
  
  console.log('DEBUG: Adding env command...');
  program.addCommand(env.program);
  console.log('DEBUG: env added successfully!');
  
} catch (err) {
  console.error('DEBUG ERROR:', err.message);
  console.error(err.stack);
}
