const originalLog = console.log.bind(console);

function rebrandConsoleText(value) {
  const branded = value
    .replace(/suhail[-_ ]*md/gi, 'Safful-Md')
    .replace(/suhail|empire/gi, 'Safful');

  // The legacy core prints a large ASCII "SUHAIL-MD" banner followed by this
  // mathematical-bold subtitle. Replace the whole banner rather than trying
  // to redraw individual block characters.
  if (branded.normalize('NFKD').includes('MULTIDEVICE WHATSAPP USER BOT')) {
    return '\n███████╗ █████╗ ███████╗███████╗██╗   ██╗██╗         ███╗   ███╗██████╗\n██╔════╝██╔══██╗██╔════╝██╔════╝██║   ██║██║         ████╗ ████║██╔══██╗\n███████╗███████║█████╗  █████╗  ██║   ██║██║         ██╔████╔██║██║  ██║\n╚════██║██╔══██║██╔══╝  ██╔══╝  ██║   ██║██║         ██║╚██╔╝██║██║  ██║\n███████║██║  ██║██║     ██║     ╚██████╔╝███████╗    ██║ ╚═╝ ██║██████╔╝\n╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝      ╚═════╝ ╚══════╝    ╚═╝     ╚═╝╚═════╝\n';
  }

  return branded;
}

console.log = (...values) => originalLog(...values.map((value) => (
  typeof value === 'string' ? rebrandConsoleText(value) : value
)));
