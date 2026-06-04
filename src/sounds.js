const cache = {};

export function play(name) {
  try {
    if (!cache[name]) {
      cache[name] = new Audio(`sounds/${name}.wav`);
    }
    const audio = cache[name];
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch (_) {}
}
