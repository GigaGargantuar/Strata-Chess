import {
  applyMove, attacks, cell, cloneGame, coords, crossLayerThreats, kingCell, legalBotKingMoves,
  legalBotMoves, squareAttacked,
} from './game.js';

const FILES = 'abcdefgh';
const VALUES = { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0, t: 340 };
const WORKER_URL = new URL('./vendor/stockfish-18-lite-single.js', import.meta.url);
const ESCAPE_LOOKAHEAD_LIMIT = 768;
let stockfish;
let queue = Promise.resolve();

function planarName(index) {
  const { x, y } = coords(index);
  return `${FILES[x]}${y + 1}`;
}

function uciMove(move) {
  return `${planarName(move.from)}${planarName(move.to)}${move.promotion || ''}`;
}

function attacksAs(type, from, to) {
  const horizontal = Math.abs(from.x - to.x);
  const vertical = Math.abs(to.y - from.y);
  return type === 'N' ? horizontal * vertical === 2 : horizontal > 0 && horizontal === vertical;
}

function projectPiece(piece, position, king, kingDestinations, nativePawn) {
  if (piece.side === 'bot') return piece.type;
  if (nativePawn || !['p', 'r', 't'].includes(piece.type)) return piece.type.toUpperCase();

  // Off-plane pieces and excess pawns still occupy a square in the 2D projection.
  return ['N', 'B'].filter(type => !attacksAs(type, position, king))
    .reduce((best, candidate) => {
      const attacksCount = type => kingDestinations
        .filter(target => attacksAs(type, position, target)).length;
      return best && attacksCount(best) <= attacksCount(candidate) ? best : candidate;
    }, null);
}

function stockfishFen(game, layer, legalMoves) {
  const botKing = coords(kingCell(game, 'bot', layer));
  const kingDestinations = legalMoves.filter(move => game.board[move.from].type === 'k')
    .flatMap(move => [coords(move.to), ...(move.castle ? [coords(move.castle.to)] : [])]);
  const passant = game.enPassant.find(right => right.side === 'player' && right.layer === layer);
  const nativePawns = new Set(passant ? [passant.pawn] : []);
  for (let index = cell(7, 6, layer); index >= cell(0, 1, layer) && nativePawns.size < 8; index -= 1) {
    const piece = game.board[index];
    if (piece?.side === 'player' && piece.type === 'p') nativePawns.add(index);
  }
  const ranks = [];
  for (let y = 7; y >= 0; y -= 1) {
    let occupied = '';
    let empty = 0;
    for (let x = 0; x < 8; x += 1) {
      const index = cell(x, y, layer);
      const piece = game.board[index];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) occupied += empty;
      occupied += projectPiece(piece, { x, y }, botKing, kingDestinations, nativePawns.has(index));
      empty = 0;
    }
    ranks.push(occupied + (empty || ''));
  }

  const homeKing = game.board[cell(4, 7, layer)];
  let castle = '';
  if (homeKing?.side === 'bot' && homeKing.type === 'k' && !homeKing.moved) {
    for (const [file, right] of [[7, 'k'], [0, 'q']]) {
      const rook = game.board[cell(file, 7, layer)];
      if (rook?.side === 'bot' && rook.type === 'r' && !rook.moved) castle += right;
    }
  }
  return `${ranks.join('/')} b ${castle || '-'} ${passant ? planarName(passant.through) : '-'} 0 ${game.turn}`;
}

function exchange(worker, command, accepts, timeout) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = event => {
      const lines = String(event.data).trim().split(/\r?\n/);
      const result = lines.find(accepts);
      if (result) {
        cleanup();
        resolve(result);
      }
    };
    const onError = event => {
      cleanup();
      reject(new Error(event.message || 'Stockfish worker failed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Stockfish response timed out'));
    }, timeout);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage(command);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function getStockfish() {
  if (stockfish) return stockfish;
  stockfish = new Worker(WORKER_URL);
  await exchange(stockfish, 'uci', line => line === 'uciok', 6500);
  stockfish.postMessage('setoption name Hash value 8');
  await exchange(stockfish, 'isready', line => line === 'readyok', 1500);
  return stockfish;
}

function withStockfish(task) {
  const result = queue.then(async () => {
    try {
      return await task(await getStockfish());
    } catch {
      stockfish?.terminate();
      stockfish = undefined;
      return null;
    }
  });
  queue = result;
  return result;
}

export async function warmStockfish() {
  return withStockfish(() => true);
}

function hasPotentialEscape(game, king, threats) {
  const origin = coords(king);
  for (let target = origin.z * 64; target < (origin.z + 1) * 64; target += 1) {
    const piece = game.board[target];
    if (distance(origin, coords(target)) === 1 && !threats.has(target)
      && !(piece?.side === 'player' && piece.type === 'k')) return true;
  }
  return false;
}

function movesThatOpenKingEscapes(game, layer, king, moves, threats) {
  if (moves.some(move => move.from === king)) return moves;
  if (!hasPotentialEscape(game, king, threats)) return [];

  // UCI has no way to score cross-layer threats. Penalize moves that leave
  // fewer safe exits before the selected engine evaluates the resulting tier.
  const openings = moves.map(move => {
    const next = cloneGame(game);
    applyMove(next, move);
    return { move, next, exits: legalBotKingMoves(next, layer, threats).length };
  });
  const bestCount = Math.max(...openings.map(opening => opening.exits));
  if (bestCount > 0) return openings.filter(opening => opening.exits === bestCount).map(opening => opening.move);

  // Search shorter routes first. A proved opening makes the next escape
  // search shorter, even when several supporting moves are needed.
  const search = openings.map(({ move, next }) => ({ move, next, setups: 1 }));
  const seen = new Set();
  const proven = new Set();
  const start = layer * 64;
  let shortest = Infinity;
  let explored = 0;
  for (const { move, next, setups } of search) {
    if (setups >= shortest) break;
    for (const reply of legalBotMoves(next, layer, threats)) {
      if (explored === ESCAPE_LOOKAHEAD_LIMIT) return [...proven];
      explored += 1;
      const result = cloneGame(next);
      applyMove(result, reply);
      if (legalBotKingMoves(result, layer, threats).length) {
        shortest = setups + 1;
        proven.add(move);
        break;
      }
      if (setups + 1 >= shortest) continue;
      const key = JSON.stringify([result.board.slice(start, start + 64), result.enPassant]);
      if (seen.has(key)) continue;
      seen.add(key);
      search.push({ move, next: result, setups: setups + 1 });
    }
  }
  return [...proven];
}

function searchStockfish(game, layer, moves) {
  return withStockfish(async worker => {
    const byUci = new Map(moves.map(move => [uciMove(move), move]));
    worker.postMessage(`position fen ${stockfishFen(game, layer, moves)}`);
    const command = `go movetime 170 depth 9 searchmoves ${[...byUci.keys()].join(' ')}`;
    const result = await exchange(worker, command, line => line.startsWith('bestmove '), 1800);
    return byUci.get(result.split(/\s+/)[1]) || null;
  });
}

function distance(from, to) {
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
}

function pursuitScore(game, targets, move) {
  const piece = game.board[move.from];
  const next = cloneGame(game);
  applyMove(next, move);
  const from = coords(move.from);
  const to = coords(move.to);
  const occupiedTargets = targets.filter(target => target !== move.capture);
  const captured = move.capture == null ? 0 : VALUES[game.board[move.capture].type];
  const promotion = move.promotion ? VALUES[move.promotion] - VALUES.p : 0;
  const threatens = occupiedTargets.some(target => attacks(next, move.to, target));
  const threatened = squareAttacked(next, move.to, 'player');
  const chase = occupiedTargets.length
    ? Math.min(...occupiedTargets.map(target => distance(from, coords(target))))
      - Math.min(...occupiedTargets.map(target => distance(to, coords(target))))
    : 0;
  const development = !piece.moved && ['n', 'b'].includes(piece.type) ? 6 : 0;
  const center = (7 - Math.abs(3.5 - to.x) - Math.abs(3.5 - to.y)) * 1.5;
  return captured * 1.4 + promotion + (threatens ? 28 : 0) + chase * 8 + development + center
    - (threatened ? VALUES[move.promotion || piece.type] * 0.68 : 0)
    - (piece.type === 'k' && !move.castle ? 15 : 0);
}

function chooseTacticalMove(game, layer, moves) {
  const targets = [];
  for (let index = layer * 64; index < (layer + 1) * 64; index += 1) {
    if (game.board[index]?.side === 'player') targets.push(index);
  }
  let bestMove = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const score = pursuitScore(game, targets, move);
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  return bestMove;
}

async function selectBotMove(game, layer, engine, emergencyOnly) {
  const king = kingCell(game, 'bot', layer);
  const threats = crossLayerThreats(game, layer);
  const checked = threats.has(king);
  if (emergencyOnly && !checked) return { move: null, engine };
  const moves = legalBotMoves(game, layer, threats);
  if (!moves.length) return { move: null, engine };
  const fatalCaptures = moves.filter(move => {
    const captured = game.board[move.capture];
    return captured?.side === 'player' && captured.type === 'n' && captured.voodoo === true;
  });
  const escapeMoves = checked && !fatalCaptures.length
    ? movesThatOpenKingEscapes(game, layer, king, moves, threats) : [];
  const preferredMoves = fatalCaptures.length ? fatalCaptures : escapeMoves;
  const candidates = preferredMoves.length || emergencyOnly ? preferredMoves : moves;
  if (!candidates.length) return { move: null, engine };
  if (engine === 'stockfish') {
    const move = await searchStockfish(game, layer, candidates);
    if (move) return { move, engine };
  }
  return { move: chooseTacticalMove(game, layer, candidates), engine: 'tactical' };
}

export function chooseBotMove(game, layer, engine) {
  return selectBotMove(game, layer, engine, false);
}

export function chooseEscapeMove(game, layer, engine) {
  return selectBotMove(game, layer, engine, true);
}
