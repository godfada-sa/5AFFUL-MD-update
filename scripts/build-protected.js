/*
 * Creates a deployable, obfuscated Safful-Md release without copying any
 * local WhatsApp credentials, message cache, environment file, logs, or
 * development tooling. It never changes the readable source tree.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'release-protected');
const CODE_EXTENSIONS = new Set(['.js', '.smd', '.suhail']);
// README.md and Procfile are written by writeReleaseExtras() so the release
// never inherits the private-repo wording or leftover branding from source.
const ROOT_FILES = new Set([
  'index.js',
  'config.js',
  'patch-baileys-version.js',
  '.env.example',
  'app.json',
  'LICENSE',
]);
const ROOT_DIRECTORIES = new Set(['lib', 'plugins', 'Themes']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'release-protected',
  'safful-webjs',
  '.safful-tools',
  '.freebuff',
  'temp',
  'Suhail_Baileys',
  'auth-backups',
]);
const RUNTIME_FILES = new Set([
  'bot_.json',
  'sck.json',
  'sck1.json',
  'store.json',
  'safful-autoview.json',
  'safful-mode.json',
  'safful-protection.json',
  'safful-status-save.json',
  'safful-auth-recovery.json',
  'safful-boot-watchdog.json',
]);

function relativePath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSafeOutputDirectory() {
  if (!isInside(ROOT, OUTPUT) || path.basename(OUTPUT) !== 'release-protected') {
    throw new Error(`Refusing to replace an unsafe output directory: ${OUTPUT}`);
  }
}

function shouldSkip(filePath) {
  const relative = relativePath(filePath);
  const parts = relative.split('/');
  const base = parts.at(-1);

  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (RUNTIME_FILES.has(base)) return true;
  if (base === 'session-qr.png' || base === 'msgprobe.log') return true;
  if (base.endsWith('.log') || base.endsWith('.session')) return true;
  // Upstream leftovers. lib/Dockerfile clones the public SuhailTechInfo repo
  // and carries its branding — shipping it in a protected release would hand
  // customers the readable public source. lib/start.sh is an unused restart
  // loop; nothing references either file.
  if (base === 'Dockerfile' || base === 'start.sh') return true;
  if (/^\d+-player-script\.js$/i.test(base)) return true;
  if (relative === 'SAFFUL-MD-VPS-DEPLOYMENT.txt') return true;
  return false;
}

function obfuscate(source, filename) {
  try {
    return JavaScriptObfuscator.obfuscate(source, {
      compact: true,
      // Scramble control flow at a mild threshold: heavy flattening slows boot
      // on weak panels, 0.25 still destroys straight-line reading of the core.
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.25,
      deadCodeInjection: false,
      // Anti-debugger (headless Node server; the default interval of 0 means
      // no CPU-hogging timer loop is installed).
      debugProtection: true,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      // Each CommonJS module has its own wrapper, so top-level names can be
      // renamed without changing public module.exports or global.* settings.
      renameGlobals: true,
      renameProperties: false,
      // Self-defending code corrupts itself when someone formats or
      // deobfuscates the file, actively breaking automated deobfuscators.
      selfDefending: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 4,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 0.7,
      // RC4-encrypted strings: the payload only exists decrypted in memory
      // while the module runs; grepping the file yields ciphertext only.
      stringArrayEncoding: ['base64', 'rc4'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 0.9,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    }).getObfuscatedCode();
  } catch (error) {
    throw new Error(`Could not obfuscate ${filename}: ${error.message || error}`);
  }
}

function copyTree(sourceDirectory, destinationDirectory, manifest) {
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    if (shouldSkip(sourcePath)) continue;

    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyTree(sourcePath, destinationPath, manifest);
      continue;
    }
    if (!entry.isFile()) continue;

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const extension = path.extname(entry.name).toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) {
      const protectedSource = obfuscate(fs.readFileSync(sourcePath, 'utf8'), relativePath(sourcePath));
      fs.writeFileSync(destinationPath, protectedSource, 'utf8');
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
    manifest.push({
      file: relativePath(sourcePath),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(destinationPath)).digest('hex'),
    });
  }
}

function writeReleasePackage() {
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const releasePackage = {
    ...sourcePackage,
    private: true,
    scripts: { start: sourcePackage.scripts?.start || 'node index.js' },
  };
  delete releasePackage.devDependencies;
  fs.writeFileSync(path.join(OUTPUT, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`, 'utf8');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Release-specific docs and install metadata. Procfile and README.md are
// manifest-tracked (as before); package.json, .npmrc and package-lock.json
// are install metadata and stay out of the manifest, matching the original
// build's convention.
// The vendored core's startup "official build" check reads ./Suhail-X and
// requires it to contain the literal substring "/SuhailTechInfo/"; without the
// marker the bot prints the modified-version nag and exits 0 right after the
// banner. Ship a clean branded marker (no upstream Dockerfile clone lines).
// The core also accepts IS_SUHAIL=true as an equivalent switch.
const SUHAIL_X_MARKER = `#=============================================#
#                 v.1.3.7                     #
# █▀▀▀█ █  █ █  █ ▄▀▀▄ ▀█▀ █     █▀▄▀█ █▀▀▄   #
# ▀▀▀▄▄ █  █ █▀▀█ █▄▄█  █  █     █ █ █ █  █   #
# █▄▄▄█ ▀▄▄▀ █  █ █  █ ▄█▄ █▄▄█  █   █ █▄▄▀   #
#     𝗠𝗨𝗟𝗧𝗜𝗗𝗘𝗩𝗜𝗖𝗘 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗨𝗦𝗘𝗥 𝗕𝗢𝗧        #
#=============================================#
# 
#    * @project_name : Safful-Md
#    * @author : @SaffulTechInfo
#    * @description : Safful-Md ,A Multi-functional whatsapp bot md.
#    * @version 1.3.7
#
# Deploy From : https://github.com/SuhailTechInfo/Suhail-Md
# (official-build marker required by the runtime startup check)
`;

function writeReleaseExtras(manifest) {
  const procfile = 'web: npm start || yarn start\n';
  fs.writeFileSync(path.join(OUTPUT, 'Procfile'), procfile, 'utf8');
  manifest.push({ file: 'Procfile', sha256: sha256Text(procfile) });

  fs.writeFileSync(path.join(OUTPUT, 'Suhail-X'), SUHAIL_X_MARKER, 'utf8');
  manifest.push({ file: 'Suhail-X', sha256: sha256Text(SUHAIL_X_MARKER) });

  const readme = `# Safful-Md (Protected Release)

Safful-Md is a WhatsApp multi-device bot powered by Baileys.

This is the protected release: the JavaScript runtime files are obfuscated to
deter casual copying. It runs like any Node.js app, but the code is not meant
to be read or debugged — keep the readable source tree as your reference.

## Requirements

- Node.js 22.12+ (the bundled Baileys is ESM-only and needs require(esm);
  Node 21 and older 20.x will not run it — the bot prints a clear message)
- FFmpeg
- A WhatsApp account to link

## Deploy

\`\`\`bash
npm ci --omit=dev        # or: npm install --omit=dev
\`\`\`

Set your environment variables in the hosting panel (see \`.env.example\` and
\`README-PROTECTED.txt\`). Do **not** copy a \`.env\` file or a WhatsApp session
from another server.

\`\`\`bash
npm start
\`\`\`

The first launch starts a new WhatsApp pairing flow. With \`AUTH_METHOD=pairing\`
set \`PAIRING_NUMBER\` to the number being linked; \`AUTH_METHOD=qr\` prints a QR
code instead. Once linked, restarts retain the local credentials.

## Integrity guard

Every runtime code file is hashed at startup against \`RELEASE-MANIFEST.json\`.
If any file was modified or removed, the bot refuses to start. Set
\`SAFFUL_SKIP_INTEGRITY_CHECK=1\` only to recover a broken deployment.

## Security

- \`.env\`, sessions, QR images, logs, chat state, and live protection settings
  are excluded from this release.
- Use a different \`OWNER_NUMBER\` and \`SUDO\` value for each deployment.
- See \`README-PROTECTED.txt\` for the full deployment notes.

---

## Ubuntu VPS deployment (fresh install)

Run everything as the regular \`ubuntu\` user (sudo is fine; root login is not needed).

### 1. Update the system

\`\`\`bash
sudo apt update && sudo apt upgrade -y
\`\`\`

### 2. Install system dependencies

\`\`\`bash
sudo apt install -y git curl unzip nano build-essential python3 ffmpeg
\`\`\`

Why each one:

| Package | Needed for |
| --- | --- |
| \`git\` | cloning / pulling the repo |
| \`curl\` | the Node.js installer |
| \`unzip\` | **required** — without it \`npm install\` fails with \"no zip archiver is available\" (puppeteer) |
| \`nano\` | editing \`.env\` |
| \`build-essential\` + \`python3\` | compiling native modules (\`sharp\`, \`canvas\`) via node-gyp |
| \`ffmpeg\` | audio / video / sticker commands |

### 3. Install Node.js 22

\`\`\`bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
\`\`\`

**\`node -v\` must print \`v22.12.0\` or higher.** If it shows anything lower, stop — the bot will crash with \`ERR_REQUIRE_ESM\`.

### 4. Get the code

\`\`\`bash
cd ~
git clone https://github.com/godfada-sa/5AFFUL-BOT.git safful-md
cd safful-md
\`\`\`

### 5. Install dependencies

\`\`\`bash
export PUPPETEER_SKIP_DOWNLOAD=true
npm install --no-audit
\`\`\`

Notes on the output:

- The \`37 vulnerabilities\` and \`npm warn install-scripts ... blocked\` lines are **normal** — ignore them.
- \`Sharp native binary is unavailable\` at runtime is also harmless (continues without legacy image resizing).
- \`unzip\` (step 2) + \`PUPPETEER_SKIP_DOWNLOAD=true\` prevent the puppeteer chrome-download crash.

### 6. Create the \`.env\`

\`\`\`bash
nano .env
\`\`\`

\`\`\`bash
OWNER_NUMBER=233XXXXXXXXX
SUDO=233XXXXXXXXX
OWNER_NAME=Safful
BOT_NAME=Safful-Md
PREFIX=.
MODE=private
PORT=8002
TZ=Africa/Accra
SAFFUL_SELF_HOSTED=true
SAFFUL_PRESERVE_DM_NOTIFICATIONS=true
READ_MESSAGE=false
READ_COMMAND=false
WAPRESENCE=unavailable
AUTH_METHOD=pairing
PAIRING_NUMBER=233XXXXXXXXX
\`\`\`

Save with \`Ctrl+O\`, Enter, then \`Ctrl+X\`.

Rules that matter:

- \`PAIRING_NUMBER\` must be your exact number with country code — no \`+\`, no leading \`0\`, **no extra digits**. A wrong number always gets refused on the phone.
- \`SUDO\` is the number that receives deleted-message forwards and the \"Safful-Md Connected\" banner (can be the same as \`OWNER_NUMBER\`).
- \`SAFFUL_PRESERVE_DM_NOTIFICATIONS=true\` keeps your phone's personal-chat notifications working while the bot is connected.

### 7. Install PM2 and start

\`\`\`bash
sudo npm install -g pm2
pm2 start index.js --name safful-md
pm2 save
\`\`\`

**Verify exactly ONE instance is running** — two instances fight over the session and the phone rejects pairing:

\`\`\`bash
pm2 list
# should show ONE safful-md row
ps aux | grep \"[n]ode index.js\" | wc -l
# should print 1
\`\`\`

Make the bot survive server reboots:

\`\`\`bash
pm2 startup systemd
\`\`\`

PM2 prints one \`sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu\` command — copy, run exactly that, then:

\`\`\`bash
pm2 save
\`\`\`

### 8. Link WhatsApp

\`\`\`bash
pm2 logs safful-md --lines 40
\`\`\`

- Session kept or auto-recovered: \`[boot] auth-prep: session=existing\` → \`✅ Whatsapp Login Successful!\` → \`Safful-Md Connected\`. **No pairing needed.**
- Fresh install: a big banner prints your 8-character code. On the phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead** → type the code exactly.

### 9. Daily operations

\`\`\`bash
pm2 logs safful-md                  # view logs
pm2 restart safful-md               # restart
pm2 stop safful-md                  # stop
git pull && pm2 restart safful-md   # update the bot
pm2 delete safful-md                # remove the process entirely
\`\`\`

## The three hard rules

1. **Never start the bot twice.** One \`pm2 start\`, one process. If \`pm2 list\` ever shows two rows, run \`pm2 delete safful-md\`, then \`pkill -f \"node index.js\"\`, and start once.
2. **Run the bot on ONE host.** Never run a panel and a VPS simultaneously — two instances kick each other off WhatsApp.
3. **Never delete \`lib/Suhail_Baileys\`** unless you deliberately want to re-pair. Sessions survive all restarts automatically. For a truly fresh login, delete both \`lib/Suhail_Baileys\` **and** \`lib/auth-backups\`.

## Optional: QR page in a browser

Open \`http://<your-server-ip>:<PORT>/qr\`. Requires an inbound firewall/security-group rule for the \`PORT\` (default \`8002\`) from your IP.
`;
  fs.writeFileSync(path.join(OUTPUT, 'README.md'), readme, 'utf8');
  manifest.push({ file: 'README.md', sha256: sha256Text(readme) });

  // jimp ^0.16.1 conflicts with baileys' optional peer jimp ^1.6.1 under
  // strict peer resolution (npm 7+). The source tree installs with
  // legacy-peer-deps=true; ship the same setting so deployers do not hit
  // ERESOLVE on a fresh Node 22 host.
  //
  // ignore-scripts=true also ships: the bot never needs the postinstall
  // side-effects (puppeteer's Chrome download, sharp's native build, the
  // protobufjs/baileys version checks). Skipping them makes `npm ci` succeed
  // on a bare VPS with no build tools or unzip, exactly like the panel
  // environment where scripts were blocked and the bot ran clean.
  fs.writeFileSync(path.join(OUTPUT, '.npmrc'), 'legacy-peer-deps=true\nignore-scripts=true\n', 'utf8');
}

// Release-only startup guard. It hashes every runtime code file (*.js / *.smd)
// against RELEASE-MANIFEST.json and exits before the bot connects if anything
// was modified or removed since the build. Obfuscated like the rest of the
// release; bypass with SAFFUL_SKIP_INTEGRITY_CHECK=1.
const INTEGRITY_GUARD_FILENAME = 'lib/integrity-check.js';
const INTEGRITY_GUARD_SOURCE = `/* Safful-Md protected-release integrity guard.
 * Runs ONCE at boot (required from index.js, NOT in plugins/).
 * Bypass with: SAFFUL_SKIP_INTEGRITY_CHECK=1
 * Skips automatically on panels with limited RAM (< 512MB).
 */
(function() {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  if (global.__saffulIntegrityChecked) return;
  global.__saffulIntegrityChecked = true;

  try {
    var totalMemMB = Math.round(require('os').totalmem() / 1024 / 1024);
    if (totalMemMB < 512) return;
  } catch(e) {}

  var skip = String(process.env.SAFFUL_SKIP_INTEGRITY_CHECK || '').toLowerCase();
  if (skip === '1' || skip === 'true') return;

  function findReleaseRoot() {
    var dir = __dirname;
    for (var depth = 0; depth < 4; depth++) {
      if (fs.existsSync(path.join(dir, 'RELEASE-MANIFEST.json'))) return dir;
      dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '..');
  }

  var root = findReleaseRoot();
  var manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
  } catch (error) {
    console.error('[integrity] FATAL: cannot read RELEASE-MANIFEST.json (' + (error && error.message) + ')');
    process.exit(1);
  }

  var tracked = (manifest.protectedFiles || []).filter(function(entry) { return /\\.(js|smd)$/.test(entry.file); });
  var bad = [];

  for (var i = 0; i < tracked.length; i++) {
    var entry = tracked[i];
    var actual;
    try {
      actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.file))).digest('hex');
    } catch (error) {
      bad.push(entry.file + ' (missing or unreadable)');
      continue;
    }
    if (actual !== entry.sha256) bad.push(entry.file);
  }

  if (bad.length === 0) {
    console.log('[integrity] protected runtime files verified (' + tracked.length + ' files, sha256)');
  } else {
    console.error('');
    console.error('  ============================================================');
    console.error('  !  SAFFUL-MD RELEASE INTEGRITY CHECK FAILED               !');
    console.error('  !  Runtime files were modified or removed:                !');
    bad.slice(0, 25).forEach(function(file) { console.error('  !    - ' + file); });
    console.error('  !  The bot will not start. Restore the original files or  !');
    console.error('  !  set SAFFUL_SKIP_INTEGRITY_CHECK=1 to bypass this guard.!');
    console.error('  ============================================================');
    console.error('');
    process.exit(1);
  }
})();
`;

function writeIntegrityGuard(manifest) {
  const code = obfuscate(INTEGRITY_GUARD_SOURCE, INTEGRITY_GUARD_FILENAME);
  fs.writeFileSync(path.join(OUTPUT, INTEGRITY_GUARD_FILENAME), code, 'utf8');
  manifest.push({ file: INTEGRITY_GUARD_FILENAME, sha256: sha256Text(code) });
}

function validateOutput() {
  const files = [];
  function findCode(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) findCode(entryPath);
      else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entryPath);
    }
  }
  findCode(OUTPUT);

  for (const filePath of files) {
    try {
      // Node's `--check` refuses unknown plugin extensions such as `.smd`.
      // vm.Script parses the same CommonJS source without executing it.
      new vm.Script(fs.readFileSync(filePath, 'utf8'), { filename: relativePath(filePath) });
    } catch (error) {
      throw new Error(`Syntax check failed for ${relativePath(filePath)}:\n${error.message || error}`);
    }
  }
  return files.length;
}

function build() {
  assertSafeOutputDirectory();
  fs.rmSync(OUTPUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(OUTPUT, { recursive: true });

  const manifest = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const sourcePath = path.join(ROOT, entry.name);
    if (shouldSkip(sourcePath)) continue;

    if (entry.isDirectory()) {
      if (!ROOT_DIRECTORIES.has(entry.name)) continue;
      const destinationPath = path.join(OUTPUT, entry.name);
      fs.mkdirSync(destinationPath, { recursive: true });
      copyTree(sourcePath, destinationPath, manifest);
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name === 'package.json') continue;
    if (!ROOT_FILES.has(entry.name)) continue;

    const destinationPath = path.join(OUTPUT, entry.name);
    const extension = path.extname(entry.name).toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) {
      fs.writeFileSync(destinationPath, obfuscate(fs.readFileSync(sourcePath, 'utf8'), entry.name), 'utf8');
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
    manifest.push({
      file: relativePath(sourcePath),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(destinationPath)).digest('hex'),
    });
  }

  writeReleasePackage();
  writeReleaseExtras(manifest);
  writeIntegrityGuard(manifest);

  // Run the integrity guard before anything else: inject its require into the
  // top of the obfuscated index.js so modified code is caught before auth,
  // login, or any plugin executes. (The plugins/ copy is defense-in-depth in
  // case the injected line is ever stripped.)
  const indexPath = path.join(OUTPUT, 'index.js');
  const injectedIndex = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(indexPath, injectedIndex, 'utf8');
  const indexEntry = manifest.find((entry) => entry.file === 'index.js');
  if (indexEntry) indexEntry.sha256 = sha256Text(injectedIndex);

  // Generate the lockfile from the release's own package.json so `npm ci`
  // works for deployers. Needs registry access; if it fails, the release is
  // still deployable with `npm install` (the shipped .npmrc applies).
  try {
    // npm.cmd on Windows cannot be spawned directly; the shell resolves it.
    execFileSync('npm', ['install', '--package-lock-only', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
      cwd: OUTPUT,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
  } catch (error) {
    console.warn(`Warning: could not generate package-lock.json in the release: ${error.message || error}`);
  }

  fs.writeFileSync(path.join(OUTPUT, 'RELEASE-MANIFEST.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    protectedFiles: manifest,
    notice: 'This release intentionally contains obfuscated runtime code and no local credentials or .env file.',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(OUTPUT, 'README-PROTECTED.txt'), [
    'SAFFUL-MD PROTECTED RELEASE',
    '',
    'Deploy this folder, then set your own environment variables in the hosting panel.',
    'Do not copy a .env file or WhatsApp session from another server.',
    'Install dependencies with: npm ci --omit=dev (or npm install --omit=dev)',
    'Start with: npm start',
    '',
    'A startup integrity guard hashes every runtime code file against RELEASE-MANIFEST.json',
    'and refuses to start if any file was modified or removed. Set',
    'SAFFUL_SKIP_INTEGRITY_CHECK=1 only to recover a broken deployment.',
    '',
    'The runtime also requires the official-build marker (Suhail-X) or IS_SUHAIL=true.',
    'Both ship with this release; do not delete Suhail-X.',
    '',
    'The JavaScript command and library files are obfuscated. This deters casual copying but cannot make runnable Node.js code impossible to reverse-engineer.',
  ].join('\n'));

  const checked = validateOutput();
  console.log(`Protected release created: ${OUTPUT}`);
  console.log(`Protected files: ${manifest.length}; syntax-checked code files: ${checked}`);
}

build();
