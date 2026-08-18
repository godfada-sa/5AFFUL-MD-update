const { cmd } = require('../lib/plugins');
const { isOwner } = require('../lib/safful-mode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Panels without a terminal (zip uploads) have no .git folder, so .update has
// nothing to pull. .gitinit builds the repo in place from GitHub: it checks the
// git binary exists, initializes, adds the remote, fetches, and checks out the
// latest main. Ignored files (.env, sessions, live state) are never touched —
// only files tracked in the repo are replaced with the GitHub versions.

const REPO_URL = String(process.env.GIT_REPO_URL || 'https://github.com/godfada-sa/5AFFUL-BOT.git').trim();

function run(command, args, timeout = 120000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: error?.message || 'spawn failed', stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, message: '', stdout, stderr });
    });
  });
}

function short(result) {
  return String(result?.message || result?.stderr || result?.stdout || 'unknown error').trim().slice(0, 400);
}

cmd({
  pattern: 'gitinit',
  alias: ['initgit', 'gitfix'],
  desc: 'Set up the .git folder from GitHub so .update works (panel installs)',
  category: 'owner',
  use: '',
}, async (message) => {
  if (!isOwner(message)) return message.reply('*Owner only.*');

  if (fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    return message.reply('✅ *This install already has a .git folder.* Try `.update` directly.');
  }

  const version = await run('git', ['--version'], 30000);
  if (!version.ok) {
    return message.reply('❌ *The `git` program is not installed on this server*, so `.update` can never work here.\nInstall git on the panel image, or keep updating by uploading files.');
  }

  await message.reply('🔄 *Setting up git from GitHub…* (this can take a minute)');

  const init = await run('git', ['init'], 30000);
  if (!init.ok) return message.reply(`❌ *git init failed.*\n${short(init)}`);

  const addRemote = await run('git', ['remote', 'add', 'origin', REPO_URL], 30000);
  if (!addRemote.ok) {
    // remote may already exist from a partial setup
    const existing = await run('git', ['remote', 'get-url', 'origin'], 15000);
    if (!existing.ok || !String(existing.stdout).trim()) {
      return message.reply(`❌ *Could not add the GitHub remote.*\n${short(addRemote)}`);
    }
  }

  const fetch = await run('git', ['fetch', 'origin'], 240000);
  if (!fetch.ok) {
    return message.reply(`❌ *Could not reach GitHub.*\n${short(fetch)}\n\nThe panel must allow outbound HTTPS to github.com.`);
  }

  // Replace tracked files with the latest main. Ignored files (.env, sessions,
  // live state) are untouched — only files that exist in the repo get replaced.
  const reset = await run('git', ['reset', '--hard', 'origin/main'], 60000);
  if (!reset.ok) {
    return message.reply(`❌ *Could not apply the latest code.*\n${short(reset)}`);
  }

  // Make sure we are on a real branch (not detached) that tracks origin/main.
  const branch = await run('git', ['checkout', '-b', 'main'], 15000);
  if (!branch.ok && !/already exists/i.test(branch.stderr)) {
    const switchB = await run('git', ['switch', 'main'], 15000);
    if (!switchB.ok) {
      return message.reply(`❌ *Could not set the main branch.*\n${short(branch) || short(switchB)}`);
    }
  }
  await run('git', ['branch', '--set-upstream-to', 'origin/main', 'main'], 15000);

  const head = await run('git', ['rev-parse', '--short', 'HEAD'], 15000);
  return message.reply(
    `✅ *Git is set up.* Now on \`main\` at \`${String(head.stdout || '').trim() || 'HEAD'}\`.\n`
    + 'Your `.env` and session were NOT touched.\n'
    + 'Reply with `.update` anytime to pull new releases.',
  );
});
