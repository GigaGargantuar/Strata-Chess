import { PIECE_NAMES, SIZE, cell, coords } from './game.js';
import { animateMoves } from './move-motion.js';

const FILES = 'abcdefgh';
const TILE = 28;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 3.5;
const DEFAULT_TILT = 0.29;
const MIN_TILT = 0.22;
const MAX_TILT = 0.93;

function make(tag, className, label) {
  const element = document.createElement(tag);
  element.className = className;
  if (label) element.textContent = label;
  return element;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function position(element, x, y) {
  element.style.transform = `translate(${x}px, ${y}px)`;
}

function squareLabel(index, piece, move, checked, threatened, danger) {
  const { x, y, z } = coords(index);
  const details = [`${FILES[x]}${y + 1}`, `layer ${z + 1}`];
  if (piece?.voodoo) details.push('your Voodoo Knight', danger ? 'under attack' : 'moves on its own');
  else if (piece) details.push(`${piece.side === 'player' ? 'your' : 'opposing'} ${PIECE_NAMES[piece.type].toLowerCase()}`);
  if (move) details.push(move.capture == null ? 'legal move' : 'legal capture');
  if (checked) details.push('in check');
  if (threatened) details.push('cross-layer attack');
  return details.join(', ');
}

export function createViewport(element, { onSquareClick, pieceArt }) {
  const controls = make('div', 'viewport-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '3D camera controls');

  const stage = make('div', 'viewport-stage');
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', 'Eight-layer 3D chessboard');
  const help = make('p', 'viewport-help', 'Drag up or down to tilt. Right-click and drag to pan. Scroll or pinch to zoom.');
  const keyboardHelp = make('p', 'sr-only', 'Use the arrow keys to move between squares, and Page Up and Page Down to change layers. Press Enter or Space to select a square.');
  help.id = `${element.id}-camera-help`;
  keyboardHelp.id = `${element.id}-keyboard-help`;
  stage.setAttribute('aria-describedby', `${help.id} ${keyboardHelp.id}`);
  element.append(controls, help, keyboardHelp, stage);

  const guides = [make('i', 'viewport-guide'), make('i', 'viewport-guide')];
  stage.append(...guides);
  const boardPlanes = [];
  const buttons = [];
  const markers = [];
  const labels = [];
  const markerGroup = make('div', 'viewport-markers');
  markerGroup.setAttribute('aria-hidden', 'true');
  let focusIndex = cell(4, 1, 4);

  for (let z = SIZE - 1; z >= 0; z -= 1) {
    const plane = make('div', 'viewport-plane');
    plane.setAttribute('role', 'group');
    plane.setAttribute('aria-label', `Layer ${z + 1}`);
    boardPlanes[z] = plane;
    stage.append(plane);
    for (let y = SIZE - 1; y >= 0; y -= 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const index = cell(x, y, z);
        const square = make('button', 'viewport-square');
        square.type = 'button';
        square.dataset.index = index;
        square.classList.toggle('is-dark', (x + y) % 2 === 0);
        square.tabIndex = index === focusIndex ? 0 : -1;
        buttons[index] = square;
        plane.append(square);

        const marker = make('span', 'viewport-marker');
        marker.dataset.index = index;
        marker.hidden = true;
        markers[index] = marker;
      }
    }
    const label = make('span', 'viewport-layer-label', String(z + 1).padStart(2, '0'));
    label.setAttribute('aria-hidden', 'true');
    labels[z] = label;
  }
  markerGroup.append(...markers);
  stage.append(markerGroup, ...labels);

  let tilt = DEFAULT_TILT;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let frame = 0;
  let projection = [];
  let squarePositions = [];
  let pieceSize = 0;
  let motion = null;
  const pointers = new Map();
  let gesture = null;

  const tiltControls = make('div', 'viewport-control-group');
  const magnification = make('div', 'viewport-control-group');
  controls.append(tiltControls, magnification);
  function cameraButton(group, glyph, label, action) {
    const button = make('button', 'viewport-control', glyph);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    group.append(button);
    return button;
  }

  cameraButton(tiltControls, '↑', 'Tilt up', () => tiltCamera(0.085));
  cameraButton(tiltControls, '↓', 'Tilt down', () => tiltCamera(-0.085));
  const zoomOut = cameraButton(magnification, '−', 'Zoom out', () => zoomAt(1 / 1.19));
  const zoomIn = cameraButton(magnification, '+', 'Zoom in', () => zoomAt(1.19));
  const reset = cameraButton(magnification, 'Fit', 'Reset 3D view', () => {
    tilt = DEFAULT_TILT;
    zoom = 1;
    panX = 0;
    panY = 0;
    resize();
  });
  reset.classList.add('viewport-fit');

  function tiltCamera(delta) {
    const next = clamp(tilt + delta, MIN_TILT, MAX_TILT);
    if (next === tilt) return;
    tilt = next;
    resize();
  }

  function zoomAt(factor, clientX, clientY) {
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom) return;
    const bounds = stage.getBoundingClientRect();
    const x = clientX == null ? (bounds.width - 28) / 2 : clientX - bounds.left;
    const y = clientY == null ? bounds.height / 2 : clientY - bounds.top;
    panX += (x - (bounds.width - 28) / 2 - panX) * (1 - next / zoom);
    panY += (y - bounds.height / 2 - panY) * (1 - next / zoom);
    zoom = next;
    resize();
  }

  function resize() {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function layout() {
    frame = 0;
    const { width, height } = stage.getBoundingClientRect();
    const nextProjection = [width, height, tilt, zoom, panX, panY];
    if (nextProjection.every((value, index) => value === projection[index])) return;
    projection = nextProjection;
    motion?.abort();
    if (!width || !height) {
      squarePositions = [];
      return;
    }

    const pitch = Math.sin(tilt);
    const planeHeight = SIZE * pitch;
    const layerGap = planeHeight + 0.94;
    const span = planeHeight + (SIZE - 1) * layerGap;
    const scale = zoom * Math.min((width - 82) / SIZE, (height - 32) / span);
    const centerX = (width - 28) / 2 + panX;
    const centerY = height / 2 + panY;

    function project(file, rank, layer) {
      return {
        x: centerX + (file - SIZE / 2) * scale,
        y: centerY - ((rank - SIZE / 2) * pitch + (layer - (SIZE - 1) / 2) * layerGap) * scale,
      };
    }

    for (const [index, guide] of guides.entries()) {
      const file = index * SIZE;
      const upper = project(file, SIZE, SIZE - 1);
      const lower = project(file, 0, 0);
      position(guide, upper.x, upper.y);
      guide.style.height = `${lower.y - upper.y}px`;
    }

    const filesX = scale / TILE;
    const rankSpacing = scale * pitch;
    const ranksY = rankSpacing / TILE;
    pieceSize = Math.min(42, rankSpacing * 1.4);
    stage.style.setProperty('--viewport-piece-size', `${pieceSize}px`);
    stage.style.setProperty('--viewport-hit-size', `${Math.min(35, rankSpacing * 0.95)}px`);
    stage.style.setProperty('--viewport-target-size', `${Math.min(18, rankSpacing * 0.8)}px`);
    zoomOut.disabled = zoom === MIN_ZOOM;
    zoomIn.disabled = zoom === MAX_ZOOM;

    for (let z = 0; z < SIZE; z += 1) {
      const origin = project(0, SIZE, z);
      boardPlanes[z].style.transform = `matrix(${filesX}, 0, 0, ${ranksY}, ${origin.x}, ${origin.y})`;
      position(labels[z], centerX + SIZE * scale / 2 + 14, centerY - (z - (SIZE - 1) / 2) * layerGap * scale);
    }

    squarePositions = markers.map((marker, index) => {
      const { x, y, z } = coords(index);
      const point = project(x + 0.5, y + 0.5, z);
      position(marker, point.x, point.y);
      marker.style.zIndex = Math.round((point.y - centerY) / scale * 10) + 512;
      return point;
    });
  }

  async function animateViewportMoves(entries, signal) {
    if (signal?.aborted) return;
    if (frame) cancelAnimationFrame(frame);
    layout();
    if (!squarePositions.length) return;

    motion?.abort();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    motion = controller;
    try {
      await animateMoves({
        surface: stage, entries, pieceArt, signal: controller.signal,
        square(index) {
          const point = squarePositions[index];
          return point && { ...point, size: pieceSize, image: markers[index].firstElementChild };
        },
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (motion === controller) motion = null;
    }
  }

  function updateFocus(index, focus = false) {
    buttons[focusIndex].tabIndex = -1;
    focusIndex = index;
    buttons[focusIndex].tabIndex = 0;
    if (!focus) return;
    buttons[focusIndex].focus({ preventScroll: true });
    const point = squarePositions[index];
    if (!point) return;
    const { width, height } = stage.getBoundingClientRect();
    const nextX = clamp(point.x, 20, width - 20);
    const nextY = clamp(point.y, 20, height - 20);
    if (nextX !== point.x || nextY !== point.y) {
      panX += nextX - point.x;
      panY += nextY - point.y;
      resize();
    }
  }

  function targetIndex(target) {
    const square = target.closest('[data-index]');
    return square ? Number(square.dataset.index) : null;
  }

  function activate(index) {
    updateFocus(index, true);
    onSquareClick(index);
  }

  stage.addEventListener('pointerdown', event => {
    if (![0, 1, 2].includes(event.button)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (stage.setPointerCapture && !stage.hasPointerCapture(event.pointerId)) stage.setPointerCapture(event.pointerId);
    if (pointers.size === 1) {
      const pan = event.shiftKey || event.button !== 0;
      gesture = { x: event.clientX, y: event.clientY, index: pan ? null : targetIndex(event.target), moved: false, pan };
    } else {
      gesture.moved = true;
      gesture.index = null;
    }
    event.preventDefault();
  });

  stage.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    if (pointers.size > 1) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
      const previousDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
      const nextDistance = Math.hypot(next.x - other.x, next.y - other.y);
      if (previousDistance) zoomAt(nextDistance / previousDistance, (next.x + other.x) / 2, (next.y + other.y) / 2);
      panX += (next.x - previous.x) / 2;
      panY += (next.y - previous.y) / 2;
      resize();
      return;
    }
    if (!gesture.moved && Math.hypot(next.x - gesture.x, next.y - gesture.y) < 5) return;
    gesture.moved = true;
    stage.classList.add('is-dragging');
    if (gesture.pan) {
      panX += next.x - previous.x;
      panY += next.y - previous.y;
      resize();
    } else {
      tiltCamera((previous.y - next.y) * 0.006);
    }
  });

  function endGesture(event) {
    if (!pointers.delete(event.pointerId) || pointers.size) return;
    const tapped = event.type === 'pointerup' && event.button === 0 && !gesture.moved;
    const index = gesture.index;
    gesture = null;
    stage.classList.remove('is-dragging');
    if (tapped && index != null) activate(index);
  }

  stage.addEventListener('pointerup', endGesture);
  stage.addEventListener('pointercancel', endGesture);
  stage.addEventListener('lostpointercapture', endGesture);
  stage.addEventListener('contextmenu', event => event.preventDefault());
  stage.addEventListener('wheel', event => {
    const amount = event.deltaY * (event.deltaMode === 1 ? 18 : 1);
    if (!amount || (amount > 0 ? zoom === MIN_ZOOM : zoom === MAX_ZOOM)) return;
    event.preventDefault();
    zoomAt(Math.exp(clamp(-amount * 0.0015, -0.6, 0.6)), event.clientX, event.clientY);
  }, { passive: false });

  stage.addEventListener('click', event => {
    if (event.detail !== 0 || event.button !== 0) return;
    const index = targetIndex(event.target);
    if (index != null) activate(index);
  });

  stage.addEventListener('keydown', event => {
    const shifts = {
      ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], ArrowDown: [0, -1, 0], ArrowUp: [0, 1, 0],
      PageDown: [0, 0, -1], PageUp: [0, 0, 1],
    };
    const shift = shifts[event.key];
    if (!shift || targetIndex(event.target) == null) return;
    event.preventDefault();
    const { x, y, z } = coords(focusIndex);
    const [dx, dy, dz] = shift;
    updateFocus(cell(clamp(x + dx, 0, SIZE - 1), clamp(y + dy, 0, SIZE - 1), clamp(z + dz, 0, SIZE - 1)), true);
  });

  new ResizeObserver(resize).observe(stage);

  return {
    resize,
    animateMoves: animateViewportMoves,
    render({ game, selected, legal, threats = new Set(), activeLayer, busy, checkedKing, voodooDanger }) {
      if (!stage.contains(document.activeElement)) {
        const { x, y } = coords(focusIndex);
        updateFocus(selected ?? cell(x, y, activeLayer));
      }
      stage.setAttribute('aria-busy', String(Boolean(busy)));
      const moves = new Map(legal.map(move => [move.to, move]));
      const targetLayers = new Set([...moves.keys()].map(index => coords(index).z));

      for (let z = 0; z < SIZE; z += 1) {
        boardPlanes[z].classList.toggle('is-active', z === activeLayer);
        labels[z].classList.toggle('is-active', z === activeLayer);
        labels[z].classList.toggle('has-target', targetLayers.has(z));
      }

      for (const [index, button] of buttons.entries()) {
        const marker = markers[index];
        const piece = game.board[index];
        const move = moves.get(index);
        const isSelected = index === selected;
        const checked = index === checkedKing;
        const threatened = threats.has(index);
        const danger = piece?.voodoo && voodooDanger;
        const label = squareLabel(index, piece, move, checked, threatened, danger);
        const imageType = piece?.voodoo ? 'v' : piece?.type;
        const imageKey = piece ? `${piece.side}-${imageType}` : '';

        button.classList.toggle('can-select', !busy && game.status === 'active' && piece?.side === 'player' && !piece.voodoo);
        button.classList.toggle('is-target', Boolean(move));
        button.classList.toggle('is-selected', isSelected);
        button.classList.toggle('is-threat', threatened);
        button.setAttribute('aria-label', label);
        if (isSelected) button.setAttribute('aria-pressed', 'true');
        else button.removeAttribute('aria-pressed');
        button.title = label;

        if ((marker.dataset.piece || '') !== imageKey) {
          if (piece) marker.replaceChildren(pieceArt(piece.side, imageType, 'viewport-piece'));
          else marker.replaceChildren();
          marker.dataset.piece = imageKey;
        }
        marker.hidden = !piece && !move;
        marker.classList.toggle('has-piece', Boolean(piece));
        marker.classList.toggle('is-target', Boolean(move));
        marker.classList.toggle('is-capture', move?.capture != null);
        marker.classList.toggle('is-selected', isSelected);
        marker.title = label;
      }
      resize();
    },
  };
}
