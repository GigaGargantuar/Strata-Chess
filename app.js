import {
  PIECE_NAMES, applyMove, botTurns, cell, cloneGame, coords, createGame, crossLayerCheckedLayers,
  crossLayerThreats, finishTurn, isPlayerInCheck, kingCell, legalBotMoves, legalPlayerMoves,
  moveVoodooKnight, restoreVoodoo, settleVoodooSpawn, squareAttacked, voodooProgress, voodooSpawnProgress,
} from './game.js';
import { chooseBotMove, chooseEscapeMove, warmStockfish } from './bots.js';
import { mountVolume } from './volume.js';
import { createViewport } from './viewport.js';
import { animateMoves } from './move-motion.js';

const get = id => document.getElementById(id);
const board = get('board');
const announcement = get('announcement');
const promotionDialog = get('promotion-dialog');
const rulesDialog = get('rules-dialog');
const newDialog = get('new-dialog');
const storageKey = 'strata-chess:game:v1';
const layers = Array.from({ length: 8 }, (_, layer) => layer);
const files = 'abcdefgh';
const engineNames = { stockfish: 'Stockfish', tactical: 'Tactical bot' };
const layerList = new Intl.ListFormat('en', { type: 'conjunction' });
const layerButtons = [];
const squares = [];

let { game, layer, view } = loadProgress();
let selection = null;
let availableMoves = [];
let focusFile = 4;
let focusRank = 1;
let busy = false;
let activeReplies = [];
let moveMotion = null;
let renderedHistory = null;
let renderedCount = -1;

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.game?.board?.length === 512 && Array.isArray(saved.game.history)
        && Array.isArray(saved.game.enPassant) && Number.isInteger(saved.game.turn)
        && layers.includes(saved.layer)) {
      return {
        game: saved.game.history.length ? restoreVoodoo(saved.game) : createGame(),
        layer: saved.layer,
        view: saved.view === '2d' ? '2d' : '3d',
      };
    }
  } catch {
    // The board is also playable with blocked browser storage.
  }
  return { game: createGame(), layer: 4, view: '3d' };
}

function saveProgress() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ game, layer, view }));
  } catch {
    // Keep the active game in memory when browser storage is unavailable.
  }
}

function pieceImage(side, type, className) {
  const image = document.createElement('img');
  image.src = `./pieces/${side}-${type}.png`;
  image.alt = '';
  image.draggable = false;
  if (className) image.className = className;
  return image;
}

function positionName(index) {
  const { x, y } = coords(index);
  return `${files[x]}${y + 1}`;
}

function fullPosition(index) {
  return `${positionName(index)}, layer ${coords(index).z + 1}`;
}

function announce(message) {
  announcement.textContent = message;
}

function createControls() {
  for (const number of [...layers].reverse()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-button';
    button.textContent = String(number + 1).padStart(2, '0');
    button.addEventListener('click', () => setLayer(number));
    get('layer-buttons').append(button);
    layerButtons[number] = button;
  }

  for (let y = 7; y >= 0; y -= 1) {
    for (let x = 0; x < 8; x += 1) {
      const square = document.createElement('button');
      square.type = 'button';
      square.dataset.file = x;
      square.dataset.rank = y;
      square.addEventListener('click', () => selectSquare(cell(x, y, layer)));
      board.append(square);
      squares.push({ square, x, y });
    }
  }
}

function setLayer(nextLayer) {
  if (!layers.includes(nextLayer) || nextLayer === layer) return;
  const restoreFocus = board.contains(document.activeElement);
  if (view === '2d') moveMotion?.abort();
  layer = nextLayer;
  render();
  if (!busy) saveProgress();
  if (restoreFocus) moveBoardFocus(focusFile, focusRank);
  announce(`Layer ${layer + 1}${availableMoves.some(move => coords(move.to).z === layer) ? ', legal moves available' : ''}.`);
}

function setView(nextView) {
  if (view === nextView) return;
  moveMotion?.abort();
  view = nextView;
  render();
  if (!busy) saveProgress();
}

function renderView() {
  const show3d = view === '3d';
  get('viewport').hidden = !show3d;
  get('volume-heading-main').hidden = !show3d;
  get('board-area').hidden = show3d;
  get('layer-heading-title').hidden = show3d;
  get('layer-arrows').hidden = show3d;
  get('layer-shortcut').hidden = show3d;
  get('volume-card').hidden = show3d;
  get('view-3d').setAttribute('aria-pressed', String(show3d));
  get('view-2d').setAttribute('aria-pressed', String(!show3d));
}

function renderLayers(kingLayer, clearedLayers, targetLayers) {
  for (const number of layers) {
    const button = layerButtons[number];
    const active = number === layer;
    const king = number === kingLayer;
    const cleared = clearedLayers.includes(number);
    const target = targetLayers.includes(number);
    button.classList.toggle('is-active', active);
    button.classList.toggle('is-king', king);
    button.classList.toggle('is-cleared', cleared);
    button.classList.toggle('is-target', target);
    button.setAttribute('aria-pressed', String(active));
    const label = [`Layer ${number + 1}`, king && 'your king', cleared && 'army defeated', target && 'legal destinations'].filter(Boolean).join(', ');
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  get('view-layer').textContent = layer + 1;
  get('previous-layer').disabled = layer === 0;
  get('next-layer').disabled = layer === 7;
  const badge = get('layer-badge');
  const kingHere = kingLayer === layer;
  badge.hidden = view === '3d' || (!kingHere && !clearedLayers.includes(layer));
  badge.dataset.kind = kingHere ? 'king' : 'cleared';
  badge.lastChild.textContent = kingHere ? 'Your king' : 'Army defeated';
}

function renderBoard(checkedKing, threats, threatenedBotKing, voodooDanger) {
  const destinations = new Map(availableMoves.map(move => [move.to, move]));
  const lastMove = game.history.findLast(entry => coords(entry.from).z === layer || entry.layer === layer);
  const highlights = lastMove ? [lastMove.from, lastMove.to] : [];
  if (lastMove?.castle) highlights.push(lastMove.castle.from, lastMove.castle.to);
  board.setAttribute('aria-label', `Layer ${layer + 1} chessboard`);
  board.setAttribute('aria-busy', String(busy));

  for (const { square, x, y } of squares) {
    const index = cell(x, y, layer);
    const piece = game.board[index];
    const move = destinations.get(index);
    const selected = index === selection;
    square.className = 'square';
    square.classList.toggle('is-dark', (x + y) % 2 === 0);
    square.classList.toggle('can-select', !busy && game.status === 'active' && piece?.side === 'player' && !piece.voodoo);
    square.classList.toggle('is-selected', selected);
    square.classList.toggle('is-move', Boolean(move));
    square.classList.toggle('is-capture', move?.capture != null);
    square.classList.toggle('is-last', highlights.includes(index));
    square.classList.toggle('is-cross-threat', threats.has(index));
    square.classList.toggle('is-cross-check', index === threatenedBotKing);
    square.classList.toggle('is-voodoo', Boolean(piece?.voodoo));
    square.tabIndex = x === focusFile && y === focusRank ? 0 : -1;
    const details = [positionName(index)];
    if (piece?.voodoo) details.push('your Voodoo Knight', voodooDanger ? 'under attack' : 'moves on its own');
    else if (piece) details.push(`${piece.side === 'player' ? 'your' : 'opposing'} ${PIECE_NAMES[piece.type].toLowerCase()}`);
    if (move) details.push(move.capture == null ? 'legal move' : 'legal capture');
    if (index === checkedKing) details.push('in check');
    if (threats.has(index)) details.push('covered by your pieces from another layer');
    square.setAttribute('aria-label', details.join(', '));
    if (selected) square.setAttribute('aria-pressed', 'true');
    else square.removeAttribute('aria-pressed');
    const imageType = piece?.voodoo ? 'v' : piece?.type;
    const imageKey = piece ? `${piece.side}-${imageType}` : '';
    if ((square.dataset.piece || '') !== imageKey) {
      if (piece) square.replaceChildren(pieceImage(piece.side, imageType, 'piece'));
      else square.replaceChildren();
      square.dataset.piece = imageKey;
    }
  }
}

function renderHint(kingLayer, inCheck) {
  let hint = 'Select a piece to see its legal moves.';
  if (busy) hint = activeReplies.length ? 'Waiting for the opposing replies.' : 'Moving pieces.';
  else if (game.status !== 'active') hint = 'Start a new game to play again.';
  else if (selection !== null) {
    const selected = game.board[selection];
    const count = new Set(availableMoves.map(move => move.to)).size;
    const localCount = new Set(availableMoves.filter(move => coords(move.to).z === layer).map(move => move.to)).size;
    const label = `${PIECE_NAMES[selected.type]} on ${fullPosition(selection)}`;
    if (!count) hint = `${label} has no legal moves.`;
    else if (view === '3d') hint = `${label} · ${count} legal ${count === 1 ? 'destination' : 'destinations'}`;
    else if (!localCount) hint = `${label} can move on highlighted layers.`;
    else hint = `${label} · ${localCount} ${localCount === 1 ? 'move' : 'moves'} here`;
  } else if (inCheck) hint = `Your king is in check on layer ${kingLayer + 1}.`;
  get('board-hint').textContent = hint;
}

function renderStatus(kingLayer, inCheck, clearedLayers, threatenedBotKing) {
  let title = 'Your turn';
  let message = 'Capture opposing kings and exhaust their pawns.';
  let state = 'ready';
  const activeReply = activeReplies.find(reply => reply.layer === layer) ?? activeReplies[0];
  if (busy && activeReply) {
    const multiple = activeReplies.length > 1;
    const movingLayers = layerList.format(activeReplies.map(reply => String(reply.layer + 1)));
    if (activeReplies.every(reply => reply.emergency)) {
      title = 'Cross-layer escape';
      message = multiple ? `Kings on layers ${movingLayers} are looking for safe squares.`
        : `The king on layer ${movingLayers} is looking for a safe square.`;
    } else {
      title = multiple ? 'Opponents’ turn' : 'Opponent’s turn';
      message = multiple ? `Opponents on layers ${movingLayers} are moving.`
        : `${engineNames[activeReply.engine]} is moving on layer ${activeReply.layer + 1}.`;
    }
    state = 'thinking';
  } else if (game.status === 'won') {
    title = 'You win';
    message = 'You cleared all eight layers.';
  } else if (game.status === 'lost') {
    const voodooLost = game.lossReason === 'voodoo';
    title = voodooLost ? 'Voodoo Knight captured' : 'Checkmate';
    message = voodooLost ? 'Your king perished.' : 'Your king has no escape on any layer.';
    state = 'lost';
  } else if (game.status === 'draw') {
    title = 'Stalemate';
    message = 'You have no legal move, and your king is safe.';
    state = 'draw';
  } else if (inCheck) {
    title = 'King in check';
    message = `Protect your king on layer ${kingLayer + 1}. Look for escapes on neighboring layers.`;
    state = 'check';
  }
  get('turn-title').textContent = title;
  if (get('turn-message').textContent !== message) get('turn-message').textContent = message;
  get('turn-indicator').dataset.state = state;
  get('turn-number').textContent = `TURN ${String(game.turn).padStart(2, '0')}`;
  const activeLayer = activeReply?.layer ?? layer;
  const label = activeLayer === kingLayer ? 'King’s layer' : 'Opponent on layer';
  get('engine-label').textContent = `${label} ${activeLayer + 1}`;
  get('engine-value').textContent = clearedLayers.includes(activeLayer)
    ? 'Army defeated'
    : engineNames[activeReply?.engine ?? (activeLayer === kingLayer ? 'stockfish' : 'tactical')];
  const crossMessage = get('cross-threat-message');
  crossMessage.hidden = threatenedBotKing < 0;
  crossMessage.textContent = threatenedBotKing < 0 ? '' : `Layer ${layer + 1} king under cross-layer attack`;
}

function renderVoodoo(danger) {
  const tracker = get('voodoo-tracker');
  const at = game.voodoo?.at;
  const progress = voodooProgress(game);
  const spawn = voodooSpawnProgress(game);
  tracker.hidden = !spawn && (at == null || !progress);
  if (tracker.hidden) return;
  tracker.classList.toggle('is-danger', danger);
  if (spawn) {
    const spawnLayer = spawn.layer + 1;
    const countdown = spawn.remaining > 0 ? `Spawns in ${spawn.remaining}` : 'Waiting for a safe square';
    get('voodoo-location').textContent = `Spawn layer ${spawnLayer}`;
    get('voodoo-countdown').textContent = countdown;
    tracker.setAttribute('aria-label', `View Voodoo Knight spawn layer ${spawnLayer}. ${countdown}${spawn.remaining > 0 ? ' player turns' : ''}.`);
    return;
  }
  const location = fullPosition(at);
  const countdown = progress.remaining > 0 ? `Hops in ${progress.remaining}` : 'Ready to hop';
  get('voodoo-location').textContent = `${location}${danger ? ' · Under attack' : ''}`;
  get('voodoo-countdown').textContent = countdown;
  tracker.setAttribute('aria-label', `View Voodoo Knight at ${location}. ${countdown}. Hops every ${progress.interval === 1 ? 'turn' : `${progress.interval} turns`}.${danger ? ' Under attack.' : ''}`);
}

function renderLog() {
  if (renderedHistory === game.history && renderedCount === game.history.length) return;
  renderedHistory = game.history;
  renderedCount = game.history.length;
  const log = get('move-log');
  get('log-count').textContent = renderedCount;
  if (!renderedCount) {
    const empty = document.createElement('p');
    empty.className = 'log-empty';
    empty.textContent = 'Moves will appear here as you play.';
    log.replaceChildren(empty);
    return;
  }
  const list = document.createElement('ol');
  list.className = 'log-list';
  for (const entry of [...game.history].reverse()) {
    const row = document.createElement('li');
    row.className = 'log-row';
    const fromLayer = coords(entry.from).z;
    const from = positionName(entry.from);
    const to = positionName(entry.to);
    const symbol = entry.captured ? '×' : '→';
    const notation = document.createElement('strong');
    notation.textContent = `${entry.voodoo ? 'Voodoo hop · ' : ''}${from} ${symbol} ${to}`;
    if (entry.promotion) notation.textContent += ` · ${PIECE_NAMES[entry.promotion]}`;
    if (entry.captured?.voodoo) notation.textContent += ' · Voodoo Knight captured';
    if (entry.captured?.type === 'k') {
      notation.textContent += ' · King taken';
      notation.className = 'log-crown';
    }
    const actor = entry.side === 'player' ? 'You' : (engineNames[entry.engine] ?? 'Opponent');
    const label = document.createElement('small');
    const layerLabel = fromLayer === entry.layer ? `Layer ${entry.layer + 1}` : `Layers ${fromLayer + 1} → ${entry.layer + 1}`;
    label.textContent = entry.side === 'player' ? layerLabel : `${actor} · ${layerLabel}`;
    const moveDetail = document.createElement('div');
    moveDetail.append(notation);
    let successionText = '';
    if (entry.succession) {
      const succession = document.createElement('span');
      succession.className = 'log-succession';
      successionText = `Pawn crowned on ${positionName(entry.succession.at)}`;
      succession.textContent = successionText;
      moveDetail.append(succession);
    }
    let spawnText = '';
    if (entry.voodooSpawn) {
      const spawn = document.createElement('span');
      spawn.className = 'log-voodoo';
      spawnText = `Voodoo Knight appeared on ${fullPosition(entry.voodooSpawn.at)}`;
      spawn.textContent = spawnText;
      moveDetail.append(spawn);
    }
    row.title = `${entry.voodoo ? 'Voodoo Knight' : `${actor} · ${PIECE_NAMES[entry.type]}`} · Turn ${entry.turn}`;
    row.setAttribute('aria-label', [row.title, notation.textContent, layerLabel, successionText, spawnText].filter(Boolean).join(', '));
    row.append(pieceImage(entry.side, entry.voodoo ? 'v' : entry.type), moveDetail, label);
    list.append(row);
  }
  log.replaceChildren(list);
  log.scrollTop = 0;
}

function render() {
  const king = kingCell(game, 'player');
  const kingLayer = king < 0 ? -1 : coords(king).z;
  const inCheck = king >= 0 && isPlayerInCheck(game);
  const clearedLayers = layers.filter(number => kingCell(game, 'bot', number) < 0);
  const opponentKing = kingCell(game, 'bot', layer);
  const threats = opponentKing < 0 ? new Set() : crossLayerThreats(game, layer);
  const threatenedBotKing = threats.has(opponentKing) ? opponentKing : -1;
  const voodooDanger = game.voodoo?.at != null && squareAttacked(game, game.voodoo.at, 'bot');
  const targetLayers = [...new Set(availableMoves.map(move => coords(move.to).z))];
  get('capture-count').textContent = clearedLayers.length;
  renderView();
  get('threat-key').hidden = threats.size === 0;
  const progress = get('capture-progress');
  progress.setAttribute('aria-valuenow', String(clearedLayers.length));
  for (const [index, marker] of Array.from(progress.children).entries()) {
    marker.classList.toggle('is-captured', index < clearedLayers.length);
  }
  renderLayers(kingLayer, clearedLayers, targetLayers);
  renderBoard(inCheck ? king : -1, threats, threatenedBotKing, voodooDanger);
  renderHint(kingLayer, inCheck);
  renderStatus(kingLayer, inCheck, clearedLayers, threatenedBotKing);
  renderVoodoo(voodooDanger);
  renderLog();
  if (view === '3d') {
    viewport.render({
      game, selected: selection, legal: availableMoves, threats, activeLayer: layer, busy,
      checkedKing: inCheck ? king : -1, voodooDanger,
    });
  } else {
    volume.update({ layer, kingLayer, clearedLayers, targetLayers });
  }
}

async function showMoves(entries) {
  render();
  const motion = new AbortController();
  moveMotion = motion;
  try {
    if (view === '3d') {
      await viewport.animateMoves(entries, motion.signal);
    } else {
      const { width, height } = board.getBoundingClientRect();
      if (!width || !height) return;
      const square = index => {
        const { x, y, z } = coords(index);
        if (z !== layer) return null;
        const { square: target } = squares[(7 - y) * 8 + x];
        return {
          x: (x + 0.5) * width / 8,
          y: (7.5 - y) * height / 8,
          size: Math.min(width, height) * 0.84 / 8,
          image: target.firstElementChild,
        };
      };
      await animateMoves({ surface: board, entries, square, pieceArt: pieceImage, signal: motion.signal });
    }
  } finally {
    if (moveMotion === motion) moveMotion = null;
  }
}

function clearSelection() {
  selection = null;
  availableMoves = [];
}

function selectSquare(index) {
  if (busy || game.status !== 'active') return;
  const { x, y, z } = coords(index);
  focusFile = x;
  focusRank = y;
  const layerChanged = z !== layer;
  if (layerChanged) {
    layer = z;
    saveProgress();
  }
  if (game.board[index]?.voodoo) {
    clearSelection();
    render();
    announce('The Voodoo Knight moves on its own.');
    return;
  }
  const destinations = availableMoves.filter(move => move.to === index);
  if (destinations.length > 1) {
    if (layerChanged) render();
    showPromotion(destinations);
    return;
  }
  if (destinations.length === 1) {
    void playMove(destinations[0]);
    return;
  }
  if (selection !== index && game.board[index]?.side === 'player') {
    selection = index;
    availableMoves = legalPlayerMoves(game, index);
    const count = new Set(availableMoves.map(move => move.to)).size;
    const piece = PIECE_NAMES[game.board[index].type];
    announce(`${piece} selected on ${fullPosition(index)}. ${count} legal ${count === 1 ? 'move' : 'moves'}.`);
  } else {
    clearSelection();
    announce('Selection cleared.');
  }
  render();
}

function showPromotion(destinations) {
  const choices = get('promotion-options');
  choices.replaceChildren();
  for (const move of destinations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'promotion-option';
    const label = document.createElement('span');
    label.textContent = PIECE_NAMES[move.promotion];
    button.append(pieceImage('player', move.promotion), label);
    button.addEventListener('click', () => {
      promotionDialog.close();
      void playMove(move);
    });
    choices.append(button);
  }
  promotionDialog.showModal();
}

const pause = duration => new Promise(resolve => window.setTimeout(resolve, duration));

function decideReply(position, { layer, engine, emergency }) {
  const choose = emergency ? chooseEscapeMove : chooseBotMove;
  return choose(position, layer, engine);
}

async function resolveReplies(currentGame, replies) {
  const position = cloneGame(currentGame);
  const [plans] = await Promise.all([
    Promise.all(replies.map(reply => decideReply(position, reply))),
    pause(300),
  ]);
  if (currentGame !== game) return false;
  const fatal = plans.find(({ move }) => position.board[move?.capture]?.voodoo);
  if (fatal) {
    const entry = applyMove(currentGame, { ...fatal.move, engine: fatal.engine });
    if (entry) await showMoves([entry]);
    return Boolean(entry) && currentGame === game;
  }
  const entries = [];
  for (const [index, reply] of replies.entries()) {
    let { move, engine } = plans[index];
    if (entries.length && reply.emergency) {
      if (!crossLayerCheckedLayers(currentGame).some(check => check.layer === reply.layer)) continue;
      ({ move, engine } = await decideReply(currentGame, reply));
    } else if (entries.length) {
      const legal = legalBotMoves(currentGame, reply.layer);
      const matchingMove = move && legal.find(candidate => candidate.from === move.from
        && candidate.to === move.to && candidate.promotion === move.promotion);
      if (matchingMove) move = matchingMove;
      else if (legal.length) ({ move, engine } = await decideReply(currentGame, reply));
      else move = null;
    }
    if (currentGame !== game) return false;
    const entry = move && applyMove(currentGame, { ...move, engine });
    if (entry) {
      settleVoodooSpawn(currentGame);
      entries.push(entry);
    }
    if (currentGame.status !== 'active') break;
  }
  if (entries.length) await showMoves(entries);
  return entries.length > 0 && currentGame === game;
}

async function resolveCrossLayerChecks(currentGame) {
  const seen = new Set();
  while (currentGame === game && currentGame.status === 'active') {
    const checks = crossLayerCheckedLayers(currentGame);
    if (!checks.length) return;
    const key = JSON.stringify([currentGame.board, currentGame.enPassant]);
    if (seen.has(key)) return;
    seen.add(key);
    activeReplies = checks.map(check => ({ ...check, emergency: true }));
    render();
    if (!await resolveReplies(currentGame, activeReplies)) return;
  }
}

async function playMove(move) {
  const currentGame = game;
  const historyStart = game.history.length;
  const previousCountdown = voodooSpawnProgress(game);
  const previousHopInterval = voodooProgress(game)?.interval;
  clearSelection();
  const entry = applyMove(game, move);
  if (!entry) {
    render();
    return;
  }
  busy = true;
  await showMoves([entry]);
  if (currentGame !== game) return;
  const voodooMove = moveVoodooKnight(game);
  activeReplies = botTurns(game, move, voodooMove);
  if (voodooMove) {
    await showMoves([voodooMove]);
    if (currentGame !== game) return;
  }
  if (activeReplies.length) {
    if (!voodooMove) render();
    if (await resolveReplies(currentGame, activeReplies)) await resolveCrossLayerChecks(currentGame);
    if (currentGame !== game) return;
  }
  activeReplies = [];
  busy = false;
  finishTurn(game);
  saveProgress();
  render();
  const nextTurn = game.status === 'active' ? 'Your turn.' : get('turn-title').textContent;
  const notices = game.history.slice(historyStart).flatMap(entry => [
    entry.succession && `Opposing pawn crowned on ${fullPosition(entry.succession.at)}.`,
    entry.voodooSpawn && `Voodoo Knight appeared on ${fullPosition(entry.voodooSpawn.at)}.`,
    entry.voodoo && `Voodoo Knight hopped to ${fullPosition(entry.to)}.`,
  ].filter(Boolean));
  const countdown = voodooSpawnProgress(game);
  if (!previousCountdown && countdown) {
    notices.push(`Voodoo Knight spawn countdown started on layer ${countdown.layer + 1}.`);
  }
  const hopInterval = voodooProgress(game)?.interval;
  if (hopInterval != null && previousHopInterval != null && hopInterval < previousHopInterval) {
    notices.push(`The Voodoo Knight now hops every ${hopInterval === 1 ? 'turn' : `${hopInterval} turns`}.`);
  }
  announce([...notices, nextTurn].join(' '));
}

function moveBoardFocus(x, y) {
  board.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1');
  focusFile = Math.max(0, Math.min(7, x));
  focusRank = Math.max(0, Math.min(7, y));
  const next = board.querySelector(`[data-file="${focusFile}"][data-rank="${focusRank}"]`);
  next.tabIndex = 0;
  next.focus();
}

function resetGame() {
  moveMotion?.abort();
  game = createGame();
  layer = 4;
  focusFile = 4;
  focusRank = 1;
  activeReplies = [];
  busy = false;
  clearSelection();
  saveProgress();
  render();
  announce('New game. Your king is on layer 5.');
}

createControls();
const volume = mountVolume(get('volume'), setLayer);
const viewport = createViewport(get('viewport'), { onSquareClick: selectSquare, pieceArt: pieceImage });
render();
void warmStockfish();

get('previous-layer').addEventListener('click', () => setLayer(layer - 1));
get('next-layer').addEventListener('click', () => setLayer(layer + 1));
get('view-3d').addEventListener('click', () => setView('3d'));
get('view-2d').addEventListener('click', () => setView('2d'));
get('voodoo-tracker').addEventListener('click', () => {
  const countdown = voodooSpawnProgress(game);
  if (countdown) {
    setLayer(countdown.layer);
    return;
  }
  if (game.voodoo?.at == null) return;
  const { x, y, z } = coords(game.voodoo.at);
  setLayer(z);
  if (view === '2d') moveBoardFocus(x, y);
});
get('rules-button').addEventListener('click', () => rulesDialog.showModal());
get('new-button').addEventListener('click', () => {
  if (game.history.length) newDialog.showModal();
  else resetGame();
});
get('confirm-new').addEventListener('click', () => {
  newDialog.close();
  resetGame();
});
for (const button of document.querySelectorAll('.close-dialog')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

board.addEventListener('keydown', event => {
  const shifts = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (!shifts[event.key]) return;
  event.preventDefault();
  const [x, y] = shifts[event.key];
  moveBoardFocus(Number(event.target.dataset.file) + x, Number(event.target.dataset.rank) + y);
});

document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]')) return;
  if (/^[1-8]$/.test(event.key)) setLayer(Number(event.key) - 1);
  if (event.key === 'Escape' && selection !== null) {
    clearSelection();
    render();
    announce('Selection cleared.');
  }
});
