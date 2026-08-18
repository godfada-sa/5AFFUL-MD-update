const { cmd } = require('../lib/plugins');
const { isOwner } = require('../lib/safful-mode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Streams stdout/stderr without a buffer cap, so big `npm install` output
// (including warnings on stderr) can never blow up the child process. Only a
// non-zero exit code counts as failure — warnings never block a restart.
function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeout || 120000;
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, message: error?.message || 'spawn failed', stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, message: '', stdout, stderr });
    });
  });
}

function short(result) {
  return String(result.message || result.stderr || result.stdout || 'unknown error')
    .trim().slice(0, 500);
}

function tail(value, lines = 6, maxChars = 400) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim())
    .filter(Boolean).slice(-lines).join('\n').slice(0, maxChars);
}

function scheduleRestart(seconds) {
  setTimeout(() => process.exit(0), seconds * 1000);
}

async function runUpdate(message, run) {
  if (!fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    return message.reply('*Update unavailable:* this deploy has no `.git` folder.\n\nIf you installed from a panel (zip upload), set it up once with: *`.gitinit`*');
  }

  await message.reply('🔄 *Checking for updates...*');
  const fetchResult = await run('git', ['fetch'], 120000);
  if (!fetchResult.ok) {
    return message.reply(`❌ *Could not reach GitHub.*\n${short(fetchResult)}`);
  }

  const branchResult = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 30000);
  const branch = String(branchResult.stdout || 'main').trim();

  // Detached HEAD (no branch): fall back to a plain fast-forward pull.
  if (!branch || branch === 'HEAD') {
    await message.reply('🔄 *Fetch complete.* Pulling (detached HEAD)…');
    const pull = await run('git', ['pull', '--ff-only'], 180000);
    if (!pull.ok) return message.reply(`❌ *Git pull failed.*\n${short(pull)}`);
    return finishUpdate(message, run, pull);
  }

  const aheadResult = await run('git', ['rev-list', '--count', `origin/${branch}..HEAD`], 30000);
  const behindResult = await run('git', ['rev-list', '--count', `HEAD..origin/${branch}`], 30000);
  const ahead = Number.parseInt(String(aheadResult.stdout || '0').trim(), 10) || 0;
  const behind = Number.parseInt(String(behindResult.stdout || '0').trim(), 10) || 0;

  const headResult = await run('git', ['rev-parse', '--short', 'HEAD'], 30000);
  const current = String(headResult.stdout || '').trim();

  if (behind === 0) {
    const note = ahead > 0
      ? `\nNote: you are *${ahead} commit(s) ahead* of the remote — nothing to pull.`
      : '';
    return message.reply(`✅ *Already up to date.*\nBranch \`${branch}\` at \`${current || 'HEAD'}\`.${note}`);
  }

  if (ahead > 0) {
    return message.reply(
      `⚠️ *Branches have diverged* — *${ahead}* local commit(s) ahead, *${behind}* remote commit(s) behind.\n`
      + 'Resolve manually (e.g. `git pull --rebase`) and try `.update` again.',
    );
  }

  await message.reply(`🔄 *${behind} new commit(s) found.* Pulling…`);
  const pull = await run('git', ['pull', '--ff-only'], 180000);
  if (!pull.ok) {
    return message.reply(`❌ *Git pull failed* (${behind} commit(s) behind).\n${short(pull)}`);
  }
  return finishUpdate(message, run, pull);
}

async function finishUpdate(message, run, pull) {
  await message.reply('📦 *Update pulled.* Installing dependencies…');
  const install = await run('npm', ['install'], 300000);
  if (!install.ok) {
    return message.reply(
      `⚠️ *Update applied, but npm install failed (exit ${install.exitCode ?? 'unknown'}).*\n`
      + `${short(install)}\n\nThe bot was NOT restarted.`,
    );
  }

  const summary = tail(pull.stdout + pull.stderr) || 'No output.';
  const installNote = tail(install.stdout + install.stderr);
  await message.reply(
    `✅ *Update complete.* Restarting in 3 seconds…`
    + (installNote ? `\n\n\`\`\`${installNote}\`\`\`` : ''),
  );
  scheduleRestart(3);
}

cmd({
  pattern: 'update',
  alias: ['pull', 'upd', 'gitpull', 'upgrade'],
  desc: 'Pull the latest code from GitHub and restart',
  category: 'owner',
  use: '',
}, async (message) => {
  if (!isOwner(message)) return message.reply('*Owner only.*');
  return runUpdate(message, runProcess);
});

cmd({
  pattern: 'restart',
  alias: ['reboot', 'res', 'resume'],
  desc: 'Restart the bot process',
  category: 'owner',
  use: '',
}, async (message) => {
  if (!isOwner(message)) return message.reply('*Owner only.*');
  await message.reply('🔄 *Restarting...* back in a few seconds.');
  scheduleRestart(2);
});

cmd({
  pattern: 'shutdown',
  alias: ['kill', 'off', 'stop'],
  desc: 'Stop the bot completely',
  category: 'owner',
  use: 'sure',
}, async (message, text) => {
  if (!isOwner(message)) return message.reply('*Owner only.*');
  const confirm = String(text || '').toLowerCase();
  if (!['sure', 'yes', 'confirm', 'kill', 'stop'].includes(confirm)) {
    return message.reply('⚠️ *Shutdown requires confirmation.*\nReply with: *.shutdown sure*');
  }
  await message.reply('🛑 *Shutting down.*\nStart it again with `pm2 restart` (or the panel restart button).');
  scheduleRestart(2);
});

module.exports = { PROJECT_ROOT, runProcess, runUpdate, scheduleRestart, short, tail };
