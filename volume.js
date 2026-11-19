const LAYERS = 8;

function polygon(ctx, corners) {
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (const { x, y } of corners.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
}

function segment(ctx, start, end) {
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function dot(ctx, x, y, radius, color) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

function layerGeometry(width, height) {
  const depth = Math.min(58, height * 0.27);
  const rise = (height - 42 - depth) / (LAYERS - 1);
  const halfWidth = Math.min(114, (width - 98) / 2);
  const centerX = (width - 40) / 2;
  return Array.from({ length: LAYERS }, (_, layer) => {
    const y = height - 21 - depth / 2 - layer * rise;
    const rear = { x: centerX + halfWidth * 0.14, y: y - depth / 2 };
    const right = { x: centerX + halfWidth, y: y - depth * 0.04 };
    const front = { x: centerX - halfWidth * 0.14, y: y + depth / 2 };
    const left = { x: centerX - halfWidth, y: y + depth * 0.04 };
    return { corners: [rear, right, front, left], labelX: right.x + 29, labelY: right.y, rise };
  });
}

function paintPlane(ctx, { corners }, options) {
  const { selected, hovered, target, cleared } = options;
  const [rear, right, front, left] = corners;

  if (selected) {
    const thickness = 2.5;
    polygon(ctx, [left, front, right,
      { ...right, y: right.y + thickness },
      { ...front, y: front.y + thickness },
      { ...left, y: left.y + thickness }
    ]);
    ctx.fillStyle = '#484dc5';
    ctx.fill();
  }

  polygon(ctx, corners);
  ctx.fillStyle = selected ? '#aeb6fa' : hovered ? '#a5b4f344' : target ? '#a5b4f32d' : '#f7f9ff30';
  ctx.fill();

  if (!cleared) {
    const squareX = { x: (right.x - rear.x) / LAYERS, y: (right.y - rear.y) / LAYERS };
    const squareY = { x: (left.x - rear.x) / LAYERS, y: (left.y - rear.y) / LAYERS };
    ctx.save();
    ctx.transform(squareX.x, squareX.y, squareY.x, squareY.y, rear.x, rear.y);
    ctx.fillStyle = selected ? '#777fe7' : hovered || target ? '#858fdf26' : '#929fce1a';
    for (let row = 0; row < LAYERS; row += 1) {
      for (let col = row % 2; col < LAYERS; col += 2) ctx.fillRect(col, row, 1, 1);
    }
    ctx.restore();
  }

  polygon(ctx, corners);
  ctx.strokeStyle = selected ? '#5259d5' : hovered || target ? '#7a85db' : cleared ? '#aab4d275' : '#919ecc88';
  ctx.lineWidth = selected ? 1.25 : 0.85;
  ctx.setLineDash(cleared && !selected ? [3, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function paintTick(ctx, geometry, index, options) {
  const { selected, hovered, target, cleared, king } = options;
  const { corners, labelX, labelY } = geometry;
  const start = { x: corners[1].x + 5, y: labelY };
  const end = { x: labelX - 15, y: labelY };
  ctx.strokeStyle = selected || hovered || target ? '#777fd9' : '#a3aecd88';
  ctx.lineWidth = 0.8;
  segment(ctx, start, end);
  dot(ctx, start.x, start.y, 1.3, ctx.strokeStyle);

  if (selected || hovered) {
    ctx.beginPath();
    ctx.roundRect(labelX - 12, labelY - 7, 24, 14, 4);
    ctx.fillStyle = selected ? '#5359d8' : '#dbe1ff';
    ctx.fill();
  }

  ctx.font = `${selected ? 700 : 500} 9px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = selected ? '#fff' : cleared ? '#8b95b2' : hovered || target ? '#4551a7' : '#5f6b96';
  ctx.fillText(String(index + 1).padStart(2, '0'), labelX, labelY + 0.3);
  if (king) dot(ctx, labelX + 17, labelY, 2.2, selected ? '#9b7026' : '#b2883c');
}

function projectedY({ x, y }, end, atX) {
  return y + ((end.y - y) * (atX - x)) / (end.x - x);
}

function hitLayer(geometry, x, y) {
  let match = -1;
  let closest = Infinity;
  geometry.forEach((plane, layer) => {
    const [rear, right, front, left] = plane.corners;
    if (x > right.x && x < plane.labelX + 22 && Math.abs(y - plane.labelY) <= plane.rise / 2) {
      match = layer;
      closest = 0;
      return;
    }
    if (x < left.x || x > right.x) return;
    const top = x < rear.x ? projectedY(left, rear, x) : projectedY(rear, right, x);
    const bottom = x < front.x ? projectedY(left, front, x) : projectedY(front, right, x);
    const distance = Math.abs(y - (top + bottom) / 2);
    if (y >= top - 4 && y <= bottom + 4 && distance < closest) {
      match = layer;
      closest = distance;
    }
  });
  return match;
}

export function mountVolume(canvas, onSelect) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { update() {} };

  let active = 4;
  let kingLayer = 4;
  let cleared = new Set();
  let targets = new Set();
  let geometry = [];
  let hovered = -1;

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (width < 110 || height < 110) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelsWide = Math.round(width * ratio);
    const pixelsHigh = Math.round(height * ratio);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    geometry = layerGeometry(width, height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const bottom = geometry[0].corners;
    const top = geometry[LAYERS - 1].corners;
    ctx.strokeStyle = '#8998cb70';
    ctx.lineWidth = 0.85;
    ctx.setLineDash([2.5, 4]);
    bottom.forEach((corner, index) => segment(ctx, corner, top[index]));
    ctx.setLineDash([]);

    const state = geometry.map((_, index) => ({
      selected: index === active,
      hovered: index === hovered,
      target: targets.has(index),
      cleared: cleared.has(index),
      king: kingLayer === index
    }));
    geometry.forEach((plane, index) => paintPlane(ctx, plane, state[index]));
    geometry.forEach((plane, index) => paintTick(ctx, plane, index, state[index]));

    const [rear, , front, left] = top;
    dot(ctx, rear.x, rear.y, 1.8, '#a3aed2');
    dot(ctx, left.x, left.y, 1.8, '#a3aed2');
    dot(ctx, front.x, front.y, 1.8, '#a3aed2');
  }

  function pointerLayer(event) {
    const { left, top } = canvas.getBoundingClientRect();
    return hitLayer(geometry, event.clientX - left, event.clientY - top);
  }

  canvas.addEventListener('pointermove', (event) => {
    const next = pointerLayer(event);
    if (next === hovered) return;
    hovered = next;
    canvas.style.cursor = hovered === -1 ? '' : 'pointer';
    draw();
  });
  canvas.addEventListener('pointerleave', () => {
    if (hovered === -1) return;
    hovered = -1;
    canvas.style.cursor = '';
    draw();
  });
  canvas.addEventListener('click', (event) => {
    const layer = pointerLayer(event);
    if (layer !== -1) onSelect(layer);
  });

  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  draw();

  return {
    update({ layer, kingLayer: king, clearedLayers = [], targetLayers = [] }) {
      active = layer;
      kingLayer = king;
      cleared = new Set(clearedLayers);
      targets = new Set(targetLayers);
      draw();
    }
  };
}
