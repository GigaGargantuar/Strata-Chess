const travelDuration = 210;
const appearanceDuration = 160;

function pose({ x, y }, opacity = 1, scale = 1) {
  return { transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`, opacity };
}

export async function animateMoves({ surface, entries, square, pieceArt, signal }) {
  if (typeof surface.animate !== 'function' || signal.aborted || document.hidden
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const hidden = new Map();
  const sprites = [];
  const animations = [];
  const cancel = () => {
    for (const animation of animations) animation.cancel();
  };
  const cancelWhenHidden = () => {
    if (document.hidden) cancel();
  };

  function addSprite(side, type, size, keyframes, duration) {
    const sprite = pieceArt(side, type, 'move-sprite');
    sprite.style.width = sprite.style.height = `${size}px`;
    sprites.push(sprite);
    surface.append(sprite);
    animations.push(sprite.animate(keyframes, { duration, easing: 'cubic-bezier(0.2, 0.7, 0.35, 1)', fill: 'both' }));
  }

  function travel(from, to, side, type) {
    const start = square(from);
    const end = square(to);
    if (!start && !end) return;
    if (end?.image && !hidden.has(end.image)) {
      hidden.set(end.image, end.image.style.visibility);
      end.image.style.visibility = 'hidden';
    }
    const first = start ? pose(start) : pose(end, 0, 0.68);
    const last = end ? pose(end) : pose(start, 0, 0.68);
    addSprite(side, type, (end ?? start).size, [first, last], start && end ? travelDuration : appearanceDuration);
  }

  try {
    for (const entry of entries) {
      const capture = entry.captured && square(entry.capture);
      if (capture) {
        const { side, type, voodoo } = entry.captured;
        addSprite(side, voodoo ? 'v' : type, capture.size,
          [pose(capture), { ...pose(capture), offset: 0.5 }, pose(capture, 0, 0.75)], travelDuration);
      }
      travel(entry.from, entry.to, entry.side, entry.voodoo ? 'v' : entry.type);
      if (entry.castle) travel(entry.castle.from, entry.castle.to, entry.side, 'r');
    }
    signal.addEventListener('abort', cancel, { once: true });
    document.addEventListener('visibilitychange', cancelWhenHidden);
  } catch {
    cancel();
  } finally {
    await Promise.allSettled(animations.map(animation => animation.finished));
    signal.removeEventListener('abort', cancel);
    document.removeEventListener('visibilitychange', cancelWhenHidden);
    for (const sprite of sprites) sprite.remove();
    for (const [image, visibility] of hidden) image.style.visibility = visibility;
  }
}
