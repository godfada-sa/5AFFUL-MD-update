const { commands } = require('../lib/plugins');

// Some legacy handlers live in bundled/obfuscated plugin files alongside
// commands we still use. Remove their registrations after every plugin has
// loaded so they cannot be invoked or leak back into the generated .menu.
const disabled = new Set([
  // Requested legacy downloaders and text-to-speech ("say") handlers.
  'ringtone', 'tgs', 'sound', 'tts', 'gtts', 'aitts', 'texttospeech', 'say',

  // The legacy tiktok handler in downloader.smd depends on the suspended
  // api-smd.onrender.com host; it is renamed (tiktokold/ttold/ttdlold) so it
  // can never fire, and these names are pruned so they stay out of .menu.
  'tiktokold', 'ttold', 'ttdlold',

  // The whole downloader.smd bundle is retired: only .tiktok, .song and .save
  // are kept, and all three now live in their own readable plugin files.
  // (isDisabled below also prunes every remaining downloader.smd command by
  // filename, so anything registered from that bundle never runs or lists.)
  'ytvid', 'ytmp3', 'ytmp4', 'ytsearch', 'yts', 'ytd', 'downmp4', 'mp4fromurl',
  'mp4', 'video', 'video2', 'mfire', 'mediafire', 'apksearch', 'apks',
  'addstickers', 'doc', 'facebook', 'fbdl', 'pint', 'gitclone', 'insta', 'instagram',

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
  const filename = String(command?.filename || '').toLowerCase();
  const fromRetiredBundle = filename.endsWith('downloader.smd');

  // Every command registered from the retired downloader.smd bundle is
  // disabled: the only downloaders we keep (.tiktok/.song/.save) live in their
  // own readable plugin files, so pruning the whole bundle cannot remove them.
  return fromRetiredBundle
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
