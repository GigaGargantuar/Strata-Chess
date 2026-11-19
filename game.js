export const SIZE = 8;
export const PROMOTIONS = ['q', 'r', 'b', 'n', 't'];
export const PIECE_NAMES = {
  p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King', t: 'Trishop',
};

const LAYER_SIZE = SIZE * SIZE;
const FILES = 'abcdefgh';
const BOT_BACK_RANK = 'rnbqkbnr';
const BOT_PROMOTIONS = ['q', 'r', 'b', 'n'];
const VOODOO_SPAWN_DELAY = 10;
const VALUES = [-1, 0, 1];
const ADJACENT = VALUES.flatMap(x => VALUES.flatMap(y => VALUES.map(z => [x, y, z])))
  .filter(vector => vector.some(Boolean));
const countAxes = vector => vector.filter(Boolean).length;
const PLANE_STEPS = ADJACENT.filter(([, , z]) => z === 0);
const PLANE_DIAGONALS = ADJACENT.filter(vector => countAxes(vector) === 2);
const AXIS_STEPS = ADJACENT.filter(vector => countAxes(vector) === 1);
const VERTICAL = ADJACENT.filter(([x, y]) => x === 0 && y === 0);
const SPACE_DIAGONALS = ADJACENT.filter(vector => countAxes(vector) === 3);
const KNIGHT_STEPS = [-2, -1, 0, 1, 2].flatMap(x => [-2, -1, 0, 1, 2]
  .flatMap(y => [-2, -1, 0, 1, 2].map(z => [x, y, z])))
  .filter(vector => countAxes(vector) === 2 && vector.map(Math.abs).includes(1)
    && vector.map(Math.abs).includes(2));

const PLAYER_VECTORS = {
  p: ADJACENT.filter(([x, y, z]) => y === 1 && (x !== 0 || z !== 0)),
  n: KNIGHT_STEPS,
  b: PLANE_DIAGONALS,
  r: VERTICAL,
  q: [...PLANE_DIAGONALS, ...AXIS_STEPS],
  k: ADJACENT,
  t: SPACE_DIAGONALS,
};
const BOT_VECTORS = {
  p: PLANE_STEPS.filter(([x, y]) => x !== 0 && y === -1),
  n: KNIGHT_STEPS.filter(([, , z]) => z === 0),
  b: PLANE_STEPS.filter(vector => countAxes(vector) === 2),
  r: PLANE_STEPS.filter(vector => countAxes(vector) === 1),
  q: PLANE_STEPS,
  k: PLANE_STEPS,
};
const SLIDERS = new Set(['b', 'r', 'q', 't']);

export function cell(x, y, z) {
  return z * LAYER_SIZE + y * SIZE + x;
}

export function coords(index) {
  return { x: index % SIZE, y: Math.floor(index / SIZE) % SIZE, z: Math.floor(index / LAYER_SIZE) };
}

export function squareName(index) {
  const { x, y, z } = coords(index);
  return `${FILES[x]}${y + 1}.${z + 1}`;
}

export function createGame() {
  const board = Array(SIZE ** 3).fill(null);
  for (let z = 0; z < SIZE; z += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      board[cell(x, 7, z)] = { type: BOT_BACK_RANK[x], side: 'bot', moved: false };
      board[cell(x, 6, z)] = { type: 'p', side: 'bot', moved: false };
      board[cell(x, 1, z)] = { type: 'p', side: 'player', moved: false };
    }
  }
  board[cell(4, 0, 4)] = { type: 'k', side: 'player', moved: false };
  return {
    board, enPassant: [], turn: 1, status: 'active', history: [],
    voodoo: null, voodooSpawn: null,
  };
}

export function cloneGame(game) {
  return {
    ...game,
    board: game.board.map(piece => piece && { ...piece }),
    enPassant: game.enPassant.map(right => ({ ...right })),
    history: [...game.history],
    voodoo: game.voodoo && { ...game.voodoo },
    voodooSpawn: game.voodooSpawn && { ...game.voodooSpawn },
  };
}

export function kingCell(game, side, layer) {
  const start = layer == null ? 0 : layer * LAYER_SIZE;
  const end = layer == null ? game.board.length : start + LAYER_SIZE;
  for (let index = start; index < end; index += 1) {
    const piece = game.board[index];
    if (piece?.side === side && piece.type === 'k') return index;
  }
  return -1;
}

function spawnVoodoo(game, layer, turn) {
  const start = layer * LAYER_SIZE;
  const center = (SIZE - 1) / 2;
  let nearest = Infinity;
  let at = null;
  for (let square = start; square < start + LAYER_SIZE; square += 1) {
    if (game.board[square] || squareAttacked(game, square, 'bot')) continue;
    const { x, y } = coords(square);
    const distance = (x - center) ** 2 + (y - center) ** 2;
    if (distance < nearest) {
      nearest = distance;
      at = square;
    }
  }
  if (at == null) return null;
  game.voodoo = { at, lastTurn: turn, spawnLayer: layer };
  game.voodooSpawn = null;
  game.board[at] = { type: 'n', side: 'player', moved: true, voodoo: true };
  return { at };
}

function completedPlayerTurn(game) {
  return game.history.findLast(entry => entry.side === 'player' && !entry.voodoo)?.turn ?? game.turn - 1;
}

function armVoodooSpawn(game, turn) {
  if (game.voodoo || game.voodooSpawn) return;
  const savedLayer = game.voodooQualifiedLayers?.[0];
  if (savedLayer != null) {
    game.voodooSpawn = { layer: savedLayer, armedTurn: turn };
    return;
  }
  for (let layer = 0; layer < SIZE; layer += 1) {
    const start = layer * LAYER_SIZE;
    let pieces = 0;
    let kings = 0;
    for (let square = start; square < start + LAYER_SIZE; square += 1) {
      const piece = game.board[square];
      if (piece?.side !== 'bot') continue;
      pieces += 1;
      if (pieces > 2) break;
      if (piece.type === 'k') kings += 1;
    }
    if (pieces === 2 && kings === 1) {
      game.voodooSpawn = { layer, armedTurn: turn };
      return;
    }
  }
}

export function voodooSpawnProgress(game) {
  if (game.status !== 'active' || game.voodoo || !game.voodooSpawn) return null;
  const { layer, armedTurn, ready } = game.voodooSpawn;
  const remaining = ready ? 0 : Math.max(0, VOODOO_SPAWN_DELAY - (completedPlayerTurn(game) - armedTurn));
  return { layer, remaining };
}

export function settleVoodooSpawn(game, entry = game.history.at(-1)) {
  const progress = voodooSpawnProgress(game);
  if (!progress) return null;
  const { layer, remaining } = progress;
  if (remaining > 0 && (kingCell(game, 'bot', layer) < 0 || legalBotMoves(game, layer).length)) return null;
  const spawn = spawnVoodoo(game, layer, completedPlayerTurn(game));
  if (!spawn) game.voodooSpawn.ready = true;
  else if (entry) entry.voodooSpawn = spawn;
  return spawn;
}

export function restoreVoodoo(game) {
  if (game.status !== 'active') return game;
  if (game.voodoo?.pending) game.voodoo = null;
  armVoodooSpawn(game, completedPlayerTurn(game));
  settleVoodooSpawn(game, null);
  return game;
}

export function voodooProgress(game) {
  if (game.status !== 'active' || game.voodoo?.at == null) return null;
  const armies = game.board.filter(piece => piece?.side === 'bot' && piece.type === 'k').length;
  const interval = Math.max(1, armies);
  return { interval, remaining: Math.max(0, interval - (completedPlayerTurn(game) - game.voodoo.lastTurn)) };
}

function onBoard(x, y, z) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE && z >= 0 && z < SIZE;
}

function advance(from, [dx, dy, dz], distance = 1) {
  const { x, y, z } = coords(from);
  const nextX = x + dx * distance;
  const nextY = y + dy * distance;
  const nextZ = z + dz * distance;
  return onBoard(nextX, nextY, nextZ) ? cell(nextX, nextY, nextZ) : -1;
}

function vectors(piece) {
  return (piece.side === 'player' ? PLAYER_VECTORS : BOT_VECTORS)[piece.type] || [];
}

function blocksAttack(piece) {
  return piece && piece.type !== 'k';
}

export function attacks(game, from, target) {
  const piece = game.board[from];
  if (!piece || target < 0) return false;
  const range = SLIDERS.has(piece.type) ? SIZE : 2;
  for (const vector of vectors(piece)) {
    for (let distance = 1; distance < range; distance += 1) {
      const next = advance(from, vector, distance);
      if (next === target) return true;
      if (next < 0 || blocksAttack(game.board[next])) break;
    }
  }
  return false;
}

export function squareAttacked(game, target, hostileSide, attackerLayer) {
  if (target < 0) return false;
  const layer = hostileSide === 'bot' ? coords(target).z : attackerLayer;
  const start = layer == null ? 0 : layer * LAYER_SIZE;
  const end = layer == null ? game.board.length : start + LAYER_SIZE;
  for (let from = start; from < end; from += 1) {
    if (game.board[from]?.side === hostileSide && attacks(game, from, target)) return true;
  }
  return false;
}

export function crossLayerThreats(game, layer) {
  const threats = new Set();
  for (let from = 0; from < game.board.length; from += 1) {
    const piece = game.board[from];
    if (piece?.side !== 'player') continue;
    const layerOffset = layer - coords(from).z;
    if (layerOffset === 0) continue;
    const range = SLIDERS.has(piece.type) ? SIZE : 2;
    for (const vector of vectors(piece)) {
      const distance = layerOffset / vector[2];
      if (!Number.isInteger(distance) || distance < 1 || distance >= range) continue;
      const target = advance(from, vector, distance);
      if (target < 0) continue;
      let step = 1;
      while (step < distance && !blocksAttack(game.board[advance(from, vector, step)])) step += 1;
      if (step === distance) threats.add(target);
    }
  }
  return threats;
}

export function isPlayerInCheck(game) {
  return squareAttacked(game, kingCell(game, 'player'), 'bot');
}

export function isBotInCheck(game, layer) {
  return squareAttacked(game, kingCell(game, 'bot', layer), 'player');
}

function canCapture(piece, target) {
  return target && target.side !== piece.side && !(piece.side === 'bot' && target.type === 'k');
}

function addPawnMove(moves, piece, move) {
  if (coords(move.to).y === (piece.side === 'player' ? 7 : 0)) {
    const promotions = piece.side === 'player' ? PROMOTIONS : BOT_PROMOTIONS;
    for (const promotion of promotions) moves.push({ ...move, promotion });
  } else {
    moves.push(move);
  }
}

function pawnMoves(game, from, piece) {
  const moves = [];
  const direction = piece.side === 'player' ? 1 : -1;
  const forward = [0, direction, 0];
  const next = advance(from, forward);
  if (next >= 0 && !game.board[next]) {
    addPawnMove(moves, piece, { from, to: next });
    const homeRank = piece.side === 'player' ? 1 : 6;
    const double = advance(from, forward, 2);
    if (!piece.moved && coords(from).y === homeRank && !game.board[double]) {
      moves.push({ from, to: double, doubleStep: true });
    }
  }
  for (const vector of vectors(piece)) {
    const to = advance(from, vector);
    if (to < 0) continue;
    if (canCapture(piece, game.board[to])) {
      addPawnMove(moves, piece, { from, to, capture: to });
    } else if (!game.board[to]) {
      const right = game.enPassant.find(option => option.through === to && option.side !== piece.side
        && game.board[option.pawn]?.type === 'p' && game.board[option.pawn].side === option.side);
      if (right) addPawnMove(moves, piece, { from, to, capture: right.pawn });
    }
  }
  return moves;
}

function castleMoves(game, from, piece) {
  if (piece.side !== 'bot' || piece.moved || piece.type !== 'k') return [];
  const { x, y, z } = coords(from);
  if (x !== 4 || y !== 7 || isBotInCheck(game, z)) return [];
  const castles = [
    { rookFile: 7, empty: [5, 6], kingFile: 6, rookDestination: 5 },
    { rookFile: 0, empty: [1, 2, 3], kingFile: 2, rookDestination: 3 },
  ];
  return castles.flatMap(({ rookFile, empty, kingFile, rookDestination }) => {
    const rookFrom = cell(rookFile, y, z);
    const rookTo = cell(rookDestination, y, z);
    const rook = game.board[rookFrom];
    if (rook?.side !== piece.side || rook.type !== 'r' || rook.moved
      || empty.some(file => game.board[cell(file, y, z)])) return [];
    const crossing = previewMove(game, { from, to: rookTo });
    if (squareAttacked(crossing, rookTo, 'player')) return [];
    return [{ from, to: cell(kingFile, y, z), castle: { from: rookFrom, to: rookTo } }];
  });
}

function pseudoMoves(game, from) {
  const piece = game.board[from];
  if (piece.type === 'p') return pawnMoves(game, from, piece);
  const moves = [];
  const range = SLIDERS.has(piece.type) ? SIZE : 2;
  for (const vector of vectors(piece)) {
    for (let distance = 1; distance < range; distance += 1) {
      const to = advance(from, vector, distance);
      if (to < 0) break;
      const target = game.board[to];
      if (!target) moves.push({ from, to });
      if (canCapture(piece, target)) moves.push({ from, to, capture: to });
      if (target) break;
    }
  }
  moves.push(...castleMoves(game, from, piece));
  return moves;
}

function crownSuccessor(board, layer) {
  const start = layer * LAYER_SIZE;
  const game = { board };
  const playerKing = kingCell(game, 'player', layer);
  let firstPawn;
  let safeSuccessor;
  let legalSuccessor;
  for (let square = start; square < start + LAYER_SIZE; square += 1) {
    const pawn = board[square];
    if (pawn?.side !== 'bot' || pawn.type !== 'p') continue;
    firstPawn ??= square;
    board[square] = { ...pawn, type: 'k', moved: true };
    const safe = !squareAttacked(game, square, 'player');
    const playerSafe = !squareAttacked(game, playerKing, 'bot');
    if (safe && playerSafe) return { at: square };
    if (safe) safeSuccessor ??= square;
    if (playerSafe) legalSuccessor ??= square;
    board[square] = pawn;
  }
  const at = safeSuccessor ?? legalSuccessor ?? firstPawn;
  if (at != null) {
    board[at] = { ...board[at], type: 'k', moved: true };
    return { at };
  }
  for (let square = start; square < start + LAYER_SIZE; square += 1) {
    if (board[square]?.side === 'bot') board[square] = null;
  }
  return undefined;
}

function movePieces(board, move) {
  const piece = board[move.from];
  const captured = move.capture == null ? null : board[move.capture];
  board[move.from] = null;
  if (captured) board[move.capture] = null;
  board[move.to] = { ...piece, type: move.promotion || piece.type, moved: true };
  if (move.castle) {
    board[move.castle.to] = { ...board[move.castle.from], moved: true };
    board[move.castle.from] = null;
  }
  const succession = captured?.type === 'k' && captured.side === 'bot'
    ? crownSuccessor(board, coords(move.capture).z)
    : undefined;
  return { captured, succession };
}

function previewMove(game, move) {
  const board = [...game.board];
  movePieces(board, move);
  return { board };
}

export function legalPlayerMoves(game, from) {
  if (game.status !== 'active') return [];
  const start = from ?? 0;
  const end = from == null ? game.board.length : from + 1;
  const moves = [];
  for (let square = start; square < end; square += 1) {
    const piece = game.board[square];
    if (piece?.side !== 'player' || piece.voodoo) continue;
    for (const move of pseudoMoves(game, square)) {
      if (!isPlayerInCheck(previewMove(game, move))) moves.push(move);
    }
  }
  return moves;
}

function safeBotKingMoves(game, king, layer, threats) {
  return pseudoMoves(game, king).filter(move => !threats.has(move.to)
    && !squareAttacked(previewMove(game, move), move.to, 'player', layer));
}

export function legalBotKingMoves(game, layer, threats) {
  const king = kingCell(game, 'bot', layer);
  if (game.status !== 'active' || king < 0) return [];
  return safeBotKingMoves(game, king, layer, threats ?? crossLayerThreats(game, layer));
}

export function legalBotMoves(game, layer, threats) {
  const king = kingCell(game, 'bot', layer);
  if (game.status !== 'active' || king < 0) return [];
  const crossThreats = threats ?? crossLayerThreats(game, layer);
  const kingMoves = safeBotKingMoves(game, king, layer, crossThreats);
  if (crossThreats.has(king) && kingMoves.length) return kingMoves;
  const start = layer * LAYER_SIZE;
  const moves = [];
  // A planar reply can change occupancy at a crossing attack ray's endpoint only.
  for (let square = start; square < start + LAYER_SIZE; square += 1) {
    if (game.board[square]?.side !== 'bot') continue;
    if (square === king) {
      moves.push(...kingMoves);
      continue;
    }
    for (const move of pseudoMoves(game, square)) {
      if (!squareAttacked(previewMove(game, move), king, 'player', layer)) moves.push(move);
    }
  }
  return moves;
}

export function applyMove(game, move) {
  const piece = game.board[move.from];
  if (game.status !== 'active' || !piece || (piece.voodoo && !move.voodoo)) return null;
  const layer = coords(move.to).z;
  const { captured, succession } = movePieces(game.board, move);
  if (piece.voodoo) {
    game.voodoo = { ...game.voodoo, at: move.to, lastTurn: game.turn };
    game.enPassant = game.enPassant.filter(right => right.through !== move.to && right.pawn !== move.capture);
  } else if (piece.side === 'player') {
    game.enPassant = [];
  } else {
    game.enPassant = game.enPassant.filter(right => {
      if (right.layer !== layer) return true;
      const pawn = game.board[right.pawn];
      return right.side === 'bot' && pawn?.side === 'bot' && pawn.type === 'p' && !game.board[right.through];
    });
  }
  if (move.doubleStep) {
    game.enPassant.push({ through: (move.from + move.to) / 2, pawn: move.to, side: piece.side, layer });
  }
  const symbol = captured ? '×' : '→';
  const promotion = move.promotion ? ` = ${PIECE_NAMES[move.promotion]}` : '';
  const label = `${squareName(move.from)} ${symbol} ${squareName(move.to)}${promotion}`;
  const entry = { ...move, side: piece.side, type: piece.type, captured, label, turn: game.turn, layer };
  const armyCleared = captured?.type === 'k' && captured.side === 'bot' && !succession;
  if (succession) entry.succession = succession;
  game.history.push(entry);
  if (captured?.voodoo) {
    const playerKing = kingCell(game, 'player');
    if (playerKing >= 0) game.board[playerKing] = null;
    game.voodoo = { ...game.voodoo, at: null };
    game.status = 'lost';
    game.lossReason = 'voodoo';
  } else if (armyCleared && kingCell(game, 'bot') < 0) {
    game.status = 'won';
  } else if (piece.side === 'player' && !piece.voodoo) {
    armVoodooSpawn(game, game.turn);
    settleVoodooSpawn(game, entry);
  }
  return entry;
}

export function moveVoodooKnight(game, random = Math.random) {
  const last = game.history.at(-1);
  if (last?.turn !== game.turn || last.side !== 'player' || last.voodoo) return null;
  if (voodooProgress(game)?.remaining !== 0) return null;
  const moves = pseudoMoves(game, game.voodoo.at).filter(move => {
    if (move.capture != null && squareAttacked(game, move.to, 'bot')) return false;
    const position = previewMove(game, move);
    return !squareAttacked(position, move.to, 'bot');
  });
  if (!moves.length) {
    game.voodoo.lastTurn = game.turn;
    return null;
  }
  return applyMove(game, { ...moves[Math.floor(random() * moves.length)], voodoo: true });
}

export function crossLayerCheckedLayers(game) {
  if (game.status !== 'active') return [];
  const kingLayer = coords(kingCell(game, 'player')).z;
  const checked = [];
  for (let layer = 0; layer < SIZE; layer += 1) {
    const king = kingCell(game, 'bot', layer);
    if (king >= 0 && crossLayerThreats(game, layer).has(king)) {
      checked.push({ layer, engine: layer === kingLayer ? 'stockfish' : 'tactical' });
    }
  }
  return checked;
}

export function botTurns(game, playerMove, voodooMove) {
  if (game.status !== 'active') return [];
  const king = kingCell(game, 'player');
  const kingLayer = king < 0 ? -1 : coords(king).z;
  const layers = new Set([kingLayer, coords(playerMove.to).z]);
  if (voodooMove) layers.add(coords(voodooMove.to).z);
  const replies = [...layers].filter(layer => layer >= 0 && kingCell(game, 'bot', layer) >= 0)
    .map(layer => ({ layer, engine: layer === kingLayer ? 'stockfish' : 'tactical' }));
  for (const reply of crossLayerCheckedLayers(game)) {
    if (!layers.has(reply.layer)) replies.push({ ...reply, emergency: true });
  }
  return replies;
}

export function finishTurn(game) {
  if (game.status !== 'active') return game.status;
  game.enPassant = game.enPassant.filter(right => right.side === 'bot');
  if (legalPlayerMoves(game).length === 0) {
    game.status = isPlayerInCheck(game) ? 'lost' : 'draw';
  } else {
    game.turn += 1;
  }
  return game.status;
}
