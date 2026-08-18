// Some managed Node hosts install JavaScript packages with native install
// scripts disabled. Sharp then exists on disk but cannot load its Linux
// binary, which used to crash Safful-Md during startup even though the only
// caller is an unused legacy image-resize helper.
const Module = require('module');
const originalLoad = Module._load;

function unavailableSharp() {
  const unavailable = () => Promise.reject(
    new Error('Image resizing is unavailable on this host because Sharp could not load its native binary.')
  );
  return {
    resize: () => ({ png: () => ({ toBuffer: unavailable }) }),
  };
}

Module._load = function loadOptionalSharp(request, parent, isMain) {
  if (request !== 'sharp') return originalLoad.call(this, request, parent, isMain);

  try {
    return originalLoad.call(this, request, parent, isMain);
  } catch (error) {
    console.warn('[optional] Sharp native binary is unavailable; continuing without legacy image resizing.');
    return unavailableSharp();
  }
};
