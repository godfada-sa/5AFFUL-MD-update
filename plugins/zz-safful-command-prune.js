const { commands } = require('../lib/plugins');

// Some legacy handlers live in bundled/obfuscated plugin files alongside
// commands we still use. Remove their registrations after every plugin has
// loaded so they cannot be invoked or leak back into the generated .menu.
const disabled = new Set([
  // Requested legacy downloaders and text-to-speech ("say") handlers.
  'ringtone', 'tgs', 'sound', 'tts', 'gtts', 'aitts', 'texttospeech', 'say',

  // The old anime bundle and the obsolete delete implementation.
  'wallpaper', 'legacydel', 'legacydelete', 'legacydlt',

  // Never expose the old remote-plugin installer commands.
  'plugin', 'plugins', 'install', 'installplugin', 'removeplugin', 'delplugin', 'getplugin',
]);

function commandNames(command) {
  return [command?.pattern, ...(Array.isArray(command?.alias) ? command.alias : [])]
    .filter(Boolean)
    .map((name) => String(name).trim().toLowerCase());
}

function isDisabled(command) {
  const names = commandNames(command);
  const category = String(command?.category || command?.type || '').trim().toLowerCase();
  const isLegacySong = command?.pattern === 'song'
    && String(command?.filename || '').toLowerCase().endsWith('downloader.smd');

  return isLegacySong
    || category === 'anime pics'
    || names.some((name) => disabled.has(name));
}

function pruneCommands(list) {
  let removed = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!isDisabled(list[index])) continue;
    list.splice(index, 1);
    removed += 1;
  }
  return removed;
}

setImmediate(() => {
  const removed = pruneCommands(commands);

  console.log(`[commands] removed ${removed} disabled legacy command(s)`);
});

module.exports = { commandNames, isDisabled, pruneCommands };
