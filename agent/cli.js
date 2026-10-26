/**
 * Terminal CLI Runner for the Autonomous AI Task Worker.
 *
 * Usage:
 *   node agent/cli.js "Find the latest invoice from Globex, extract the amount and due date, enter it into the finance portal, and tell me once it is done."
 *
 * If no argument is provided, runs Task 1 by default.
 */

import 'dotenv/config';
import readline from 'readline';
import { runTask } from './src/runtime/loop.js';
import { closeAll } from '../shared/db.js';

const DEFAULT_TASK = 'Find the latest invoice from Globex, extract the amount and due date, enter it into the finance portal, and tell me once it is done.';

// Setup interactive CLI terminal interface
function createTerminalInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return {
    async askQuestion(question, options = []) {
      return new Promise(resolve => {
        if (question.includes('[APPROVAL REQUIRED]')) {
          console.log(`\n\x1b[33m${question}\x1b[0m`);
        } else {
          console.log(`\n\x1b[33m[SUPERVISOR QUESTION]\x1b[0m ${question}`);
          if (options && options.length > 0) {
            console.log('Options:');
            options.forEach((opt, idx) => console.log(`  ${idx + 1}. ${opt}`));
          }
        }

        rl.question('\nYour response: ', answer => {
          const trimmed = answer.trim();
          // If user typed a number matching an option
          const num = parseInt(trimmed, 10);
          if (options && options.length > 0 && !isNaN(num) && num >= 1 && num <= options.length) {
            resolve(options[num - 1]);
          } else {
            resolve(trimmed || (options && options[0]) || 'Approved');
          }
        });
      });
    },
    close() {
      rl.close();
    }
  };
}

async function main() {
  const goal = process.argv[2] || DEFAULT_TASK;
  const terminal = createTerminalInterface();

  console.log('\n\x1b[36m╔══════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║           CentrAlign Autonomous AI Task Worker CLI               ║\x1b[0m');
  console.log('\x1b[36m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n');
  console.log(`\x1b[1mTask Goal:\x1b[0m ${goal}\n`);

  // Hook for live step streaming to console
  const onStep = ({ type, step, plan }) => {
    if (type === 'step') {
      const phaseColor = {
        understand: '\x1b[34m', // blue
        plan: '\x1b[35m',       // magenta
        observe: '\x1b[36m',    // cyan
        execute: '\x1b[32m',    // green
        adapt: '\x1b[33m',      // yellow
        verify: '\x1b[35m',     // magenta
        complete: '\x1b[32m'    // green
      }[step.phase] || '\x1b[37m';

      const reset = '\x1b[0m';
      const phaseBadge = `${phaseColor}[${step.phase.toUpperCase()}]${reset}`;
      console.log(`Step ${step.index} ${phaseBadge} \x1b[1m${step.tool}\x1b[0m (${step.durationMs}ms)`);
      console.log(`  └─ ${step.resultSummary}`);

      if (step.screenshot) {
        console.log(`  └─ Evidence Screenshot: ${step.screenshot}`);
      }
    }
  };

  try {
    const result = await runTask({
      goal,
      onStep,
      askHuman: async (question, options) => {
        return terminal.askQuestion(question, options);
      }
    });

    if (result.verification && Array.isArray(result.verification.checks) && result.verification.checks.length > 0) {
      console.log('\n\x1b[35m══════════════════════════════════════════════════════════════════\x1b[0m');
      console.log('\x1b[1mVERIFICATION CHECKS\x1b[0m');
      console.log('══════════════════════════════════════════════════════════════════');
      console.log('| What | Expected | Actual | Pass |');
      console.log('|---|---|---|---|');
      for (const check of result.verification.checks) {
        const passText = check.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(`| ${check.what} | ${check.expected} | ${check.actual} | ${passText} |`);
      }
    }

    const outcomeColor = result.status === 'completed' ? '\x1b[32m' : '\x1b[31m';
    console.log(`\n${outcomeColor}══════════════════════════════════════════════════════════════════\x1b[0m`);
    console.log(`\x1b[1mFINAL OUTCOME: ${(result.status || '').toUpperCase()}\x1b[0m`);
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(`Summary:\n${result.summary}\n`);

    if (result.claimedOutcome && Object.keys(result.claimedOutcome).length > 0) {
      console.log('Claimed Outcome:');
      console.log(JSON.stringify(result.claimedOutcome, null, 2));
    }

    console.log(`\nRun Artifacts: ${result.artifactsDir}`);
  } catch (err) {
    console.error('\n\x1b[31m[CLI Error]\x1b[0m', err.message);
  } finally {
    terminal.close();
    await closeAll();
    process.exit(0);
  }
}

main();
