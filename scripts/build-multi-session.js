/*
 * Builds the protected multi-session launcher.
 *
 * Reads the readable source  multi-session/launcher.js
 * Writes the protected build  multi-session/dist/launcher.js
 *
 * Uses the exact same obfuscation settings as the protected release
 * (scripts/build-protected.js) so the launcher carries the same level
 * of protection as the rest of the bot.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'multi-session', 'launcher.js');
const OUTPUT_DIR = path.join(ROOT, 'multi-session', 'dist');
const OUTPUT = path.join(OUTPUT_DIR, 'launcher.js');

function obfuscate(source, filename) {
  try {
    return JavaScriptObfuscator.obfuscate(source, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.25,
      deadCodeInjection: false,
      debugProtection: true,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: true,
      renameProperties: false,
      selfDefending: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 4,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 0.7,
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

function build() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Source not found: ${SOURCE}`);
  }
  const source = fs.readFileSync(SOURCE, 'utf8');

  // 1. Syntax-check the readable source first.
  new vm.Script(source, { filename: 'multi-session/launcher.js' });

  // 2. Obfuscate.
  const protectedCode = obfuscate(source, 'multi-session/launcher.js');

  // 3. Verify the protected output parses (without executing it).
  new vm.Script(protectedCode, { filename: 'multi-session/dist/launcher.js' });

  // 4. Write it out.
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, protectedCode, 'utf8');

  console.log(`Protected multi-session launcher created: ${OUTPUT}`);
  console.log(`Source : ${SOURCE} (${source.length} bytes)`);
  console.log(`Output : ${OUTPUT} (${protectedCode.length} bytes)`);
}

build();
