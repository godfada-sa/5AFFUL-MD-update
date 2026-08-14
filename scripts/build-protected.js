/*
 * Creates a deployable, obfuscated Safful-Md release without copying any
 * local WhatsApp credentials, message cache, environment file, logs, or
 * development tooling. It never changes the readable source tree.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'release-protected');
const CODE_EXTENSIONS = new Set(['.js', '.smd', '.suhail']);
const ROOT_FILES = new Set([
  'index.js',
  'config.js',
  'patch-baileys-version.js',
  '.env.example',
  'Procfile',
  'app.json',
  'README.md',
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
  if (/^\d+-player-script\.js$/i.test(base)) return true;
  if (relative === 'SAFFUL-MD-VPS-DEPLOYMENT.txt') return true;
  return false;
}

function obfuscate(source, filename) {
  try {
    return JavaScriptObfuscator.obfuscate(source, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      // Each CommonJS module has its own wrapper, so top-level names can be
      // renamed without changing public module.exports or global.* settings.
      renameGlobals: true,
      renameProperties: false,
      selfDefending: false,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 8,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 0.5,
      stringArrayEncoding: ['base64'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 0.75,
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
    'Install dependencies with: npm install --omit=dev',
    'Start with: npm start',
    '',
    'The JavaScript command and library files are obfuscated. This deters casual copying but cannot make runnable Node.js code impossible to reverse-engineer.',
  ].join('\n'));

  const checked = validateOutput();
  console.log(`Protected release created: ${OUTPUT}`);
  console.log(`Protected files: ${manifest.length}; syntax-checked code files: ${checked}`);
}

build();
