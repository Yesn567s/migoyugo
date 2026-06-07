// AI Worker - Runs minimax in background thread
const size = 8;
const MAX_DEPTH = 4;

// --- TIME MANAGEMENT ---
let searchAborted = false;
let searchEndTime = 0;
let nodesEvaluated = 0;

// --- THE ZOBRIST MEMORY BANK ---
const ttMap = new Map();

// 8x8 board = 64 squares. 4 piece types (P1 Migo, P1 Yugo, P2 Migo, P2 Yugo)
// 64 * 4 = 256 unique piece states.
const ZOBRIST_TABLE = new BigInt64Array(256);

// Initialize the table with random 64-bit integers once when the worker loads
for (let i = 0; i < 256; i++) {
  const low = BigInt(Math.floor(Math.random() * 0xffffffff));
  const high = BigInt(Math.floor(Math.random() * 0xffffffff));
  ZOBRIST_TABLE[i] = (high << 32n) | low;
}

// Helper to get the specific ID for a piece on a square
function getZobristIndex(row, col, player, isYugo) {
  const square = row * size + col;
  const pieceType = (player === 1 ? 0 : 2) + (isYugo ? 1 : 0);
  return square * 4 + pieceType;
}

// Track the live hash globally during the search
let currentHash = 0n;

// Calculate the hash from scratch ONLY ONCE at the start of the turn
function computeInitialHash(board) {
  let hash = 0n;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const tile = board[r][c];
      if (tile) {
        hash ^= ZOBRIST_TABLE[getZobristIndex(r, c, tile.player, tile.yugo)];
      }
    }
  }
  return hash;
}
// -----------------------------

self.onmessage = function (e) {
  ttMap.clear();
  const { board, playerColor, turn, maxDepth } = e.data;
  const searchMaxDepth = Number.isFinite(maxDepth) ? maxDepth : MAX_DEPTH;

  // --- NEW: Calculate the starting hash ---
  currentHash = computeInitialHash(board);

  // Get all legal moves
  const legalMoves = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, turn)) {
        legalMoves.push({ row: r, col: c });
      }
    }
  }

  if (legalMoves.length === 0) {
    self.postMessage({ bestMove: null, error: "noMoves" });
    return;
  }

  // Find best move using minimax
  let bestMove = legalMoves[0];
  let bestScore = -Infinity;

  // ==========================================
  // --- THE PANIC BUTTON ---
  // ==========================================

  // 1. Can the AI win instantly?
  const myIgoWins = getIgoThreatCells(board, turn);
  if (myIgoWins.length > 0) {
    self.postMessage({ bestMove: myIgoWins[0], bestScore: 99999 });
    return; // Skip the search and win the game immediately!
  }

  // 2. Is the human about to win instantly?
  const opponentIgoThreats = getIgoThreatCells(board, other(turn));
  let rootMoves = legalMoves;

  if (opponentIgoThreats.length > 0) {
    // Human is threatening an Igo. ONLY look at moves that block it!
    const threatSet = new Set(
      opponentIgoThreats.map((m) => `${m.row}:${m.col}`),
    );
    rootMoves = legalMoves.filter((m) => threatSet.has(`${m.row}:${m.col}`));
  } else {
    // 3. Normal blocking AND attacking logic
    const myCriticalCells = getCriticalCells(board, turn);
    const oppCriticalCells = getCriticalCells(board, other(turn));

    if (myCriticalCells.size > 0 || oppCriticalCells.size > 0) {
      rootMoves = legalMoves.filter(
        (move) =>
          myCriticalCells.has(`${move.row}:${move.col}`) ||
          oppCriticalCells.has(`${move.row}:${move.col}`),
      );
    }
  }

  const rootMaxMoves = 25;
  const movesToScore =
    rootMoves.length > 0
      ? rootMoves.slice(0, Math.min(rootMaxMoves, rootMoves.length))
      : legalMoves.slice(0, Math.min(rootMaxMoves, legalMoves.length));

  // ==========================================

  // Set the time limit (e.g., 1500 milliseconds = 1.5 seconds)
  // You can pass this from your main JS file via e.data!
  const timeLimitMs = e.data.timeLimitMs || Infinity;

  searchAborted = false;
  searchEndTime = performance.now() + timeLimitMs;
  nodesEvaluated = 0;

  let globalBestMove = movesToScore[0];
  let globalBestScore = -Infinity;

  // --- NEW: ITERATIVE DEEPENING LOOP ---
  // Start at depth 1 and keep going deeper until time runs out or we hit maxDepth
  for (let currentDepth = 1; currentDepth <= searchMaxDepth; currentDepth++) {
    let depthBestMove = movesToScore[0];
    let depthBestScore = -Infinity;

    for (const move of movesToScore) {
      const history = applyMove(board, move.row, move.col, turn);
      const nextPlayer = turn === 1 ? 2 : 1;

      const score = minimax(
        board,
        nextPlayer,
        currentDepth - 1, // How much further down to go
        -Infinity,
        Infinity,
        false,
        playerColor,
        currentDepth,
      );

      undoMove(board, history);

      // If time ran out mid-search, break out of this loop!
      if (searchAborted) break;

      if (score > depthBestScore) {
        depthBestScore = score;
        depthBestMove = move;
      }
    }

    // If we aborted during this depth, DO NOT use its incomplete results.
    // We rely on the globalBestMove from the PREVIOUS fully completed depth.
    if (searchAborted) {
      break;
    }

    // We fully completed this depth! Save the reliable results.
    globalBestMove = depthBestMove;
    globalBestScore = depthBestScore;

    // --- PRO TIP: Move Ordering ---
    // If we have time to go to the next depth, push the best move we just found
    // to the very front of the array. Searching the best move first makes Alpha-Beta pruning insanely fast.
    movesToScore.sort((a, b) =>
      a === depthBestMove ? -1 : b === depthBestMove ? 1 : 0,
    );
  }

  // Send back the best result we found before the buzzer rang
  self.postMessage({ bestMove: globalBestMove, bestScore: globalBestScore });
};

function minimax(
  board,
  player,
  depth,
  alpha,
  beta,
  isMaximizing,
  playerColor,
  maxDepth,
) {
  const aiPlayer = playerColor === 1 ? 2 : 1;

  // --- NEW: TIME CHECK EVERY 1000 NODES ---
  if (++nodesEvaluated > 1000) {
    nodesEvaluated = 0;
    if (performance.now() > searchEndTime) {
      searchAborted = true;
    }
  }
  // If we ran out of time, immediately back out. The score doesn't matter because it gets thrown away.
  if (searchAborted) return 0;

  // --- 1. CHECK THE TRANSPOSITION TABLE ---
  const hash = currentHash;
  const remainingDepth = maxDepth - depth;

  if (ttMap.has(hash)) {
    const stored = ttMap.get(hash);
    // Only use the stored memory if we searched deep enough last time
    if (stored.remainingDepth >= remainingDepth) {
      if (stored.flag === "EXACT") return stored.score;
      if (stored.flag === "LOWERBOUND") alpha = Math.max(alpha, stored.score);
      if (stored.flag === "UPPERBOUND") beta = Math.min(beta, stored.score);
      if (alpha >= beta) return stored.score;
    }
  }

  // --- 2. TERMINAL STATES ---
  if (checkIgoOnBoard(board, aiPlayer)) return 10000 - depth;
  if (checkIgoOnBoard(board, playerColor)) return -10000 + depth;
  if (
    isBoardFullOnBoard(board) ||
    !hasLegalMovesOnBoard(board, player) ||
    depth >= maxDepth
  ) {
    return evaluate(board, aiPlayer);
  }

  // --- 3. GENERATE & SORT MOVES ---
  const legalMoves = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player)) {
        legalMoves.push({ row: r, col: c });
      }
    }
  }

  legalMoves.sort(
    (a, b) =>
      moveOrderScore(board, b, player) - moveOrderScore(board, a, player),
  );

  // Note: These limits are widened so the AI isn't wearing horse blinders
  const myCriticalCells = getCriticalCells(board, player);
  const oppCriticalCells = getCriticalCells(board, other(player));

  const criticalMoves =
    myCriticalCells.size > 0 || oppCriticalCells.size > 0
      ? legalMoves.filter(
          (move) =>
            myCriticalCells.has(`${move.row}:${move.col}`) ||
            oppCriticalCells.has(`${move.row}:${move.col}`),
        )
      : [];

  const maxMoves = 25;
  const movesToExplore =
    criticalMoves.length > 0
      ? criticalMoves.slice(0, Math.min(maxMoves, criticalMoves.length))
      : legalMoves.slice(0, Math.min(maxMoves, legalMoves.length));

  // --- 4. THE SEARCH LOOP ---
  let originalAlpha = alpha;
  let bestScore;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of movesToExplore) {
      const preMoveYugos = countYugosOnBoard(board, player);

      // FAST MUTATE
      const history = applyMove(board, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(board, player);
      const nextPlayer = player === 1 ? 2 : 1;
      // Allow a maximum of 2 depth extensions per search path to prevent infinite loops
      const MAX_EXTENSION = maxDepth + 2;
      const nextDepth =
        postMoveYugos > preMoveYugos && depth < MAX_EXTENSION
          ? depth
          : depth + 1;

      // Pass the SAME board into minimax
      const moveScore = minimax(
        board,
        nextPlayer,
        nextDepth,
        alpha,
        beta,
        false,
        playerColor,
        maxDepth,
      );

      // FAST UNDO
      undoMove(board, history);

      maxEval = Math.max(maxEval, moveScore);
      alpha = Math.max(alpha, moveScore);
      if (beta <= alpha) break;
    }
    bestScore = maxEval;
  } else {
    let minEval = Infinity;
    for (const move of movesToExplore) {
      const preMoveYugos = countYugosOnBoard(board, player);

      // FAST MUTATE
      const history = applyMove(board, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(board, player);
      const nextPlayer = player === 1 ? 2 : 1;
      const MAX_EXTENSION = maxDepth + 2;
      const nextDepth =
        postMoveYugos > preMoveYugos && depth < MAX_EXTENSION
          ? depth
          : depth + 1;

      // Pass the SAME board into minimax
      const moveScore = minimax(
        board,
        nextPlayer,
        nextDepth,
        alpha,
        beta,
        true,
        playerColor,
        maxDepth,
      );

      // FAST UNDO
      undoMove(board, history);

      minEval = Math.min(minEval, moveScore);
      beta = Math.min(beta, moveScore);
      if (beta <= alpha) break;
    }
    bestScore = minEval;
  }

  // --- 5. SAVE TO TRANSPOSITION TABLE ---
  let flag = "EXACT";
  if (bestScore <= originalAlpha) flag = "UPPERBOUND";
  else if (bestScore >= beta) flag = "LOWERBOUND";

  ttMap.set(hash, {
    score: bestScore,
    remainingDepth: remainingDepth,
    flag: flag,
  });

  return bestScore;
}

function applyMove(board, row, col, player) {
  const history = {
    row: row,
    col: col,
    changes: [],
    hashToggles: [], // NEW: Track what we flip to easily undo it
  };

  // 1. Place the new Migo
  history.changes.push({ r: row, c: col, prev: null });
  board[row][col] = { player, yugo: false };

  // Toggle the hash for the placed Migo
  const placedMigoKey = ZOBRIST_TABLE[getZobristIndex(row, col, player, false)];
  currentHash ^= placedMigoKey;
  history.hashToggles.push(placedMigoKey);

  const lines = findAllStraightLinesOnBoard(board, row, col, player);

  if (lines.length > 0) {
    const tilesAffected = [];
    const existingYugos = [];

    // Map out all the tiles involved in the line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const [r, c] = line[j];

        let alreadyAdded = false;
        for (let k = 0; k < tilesAffected.length; k++) {
          if (tilesAffected[k].r === r && tilesAffected[k].c === c) {
            alreadyAdded = true;
            break;
          }
        }

        if (!alreadyAdded) {
          tilesAffected.push({ r, c });
          const tile = board[r][c];
          if (tile && tile.yugo) existingYugos.push({ r, c });
        }
      }
    }

    // 2. Save state & Wipe affected tiles
    for (let i = 0; i < tilesAffected.length; i++) {
      const { r, c } = tilesAffected[i];
      const prevTile = board[r][c];

      if (r !== row || c !== col) {
        history.changes.push({ r, c, prev: prevTile });
      }

      // Toggle hash to REMOVE the piece (it works instantly!)
      if (prevTile) {
        const removeKey =
          ZOBRIST_TABLE[getZobristIndex(r, c, prevTile.player, prevTile.yugo)];
        currentHash ^= removeKey;
        history.hashToggles.push(removeKey);
      }

      board[r][c] = null;
    }

    // 3. Re-place existing Yugos
    for (let i = 0; i < existingYugos.length; i++) {
      const { r, c } = existingYugos[i];
      board[r][c] = { player, yugo: true };

      // Toggle hash to ADD the Yugo back
      const yugoKey = ZOBRIST_TABLE[getZobristIndex(r, c, player, true)];
      currentHash ^= yugoKey;
      history.hashToggles.push(yugoKey);
    }

    // 4. Transform the placed Migo into a Yugo
    board[row][col] = { player, yugo: true };
    const newYugoKey = ZOBRIST_TABLE[getZobristIndex(row, col, player, true)];
    currentHash ^= newYugoKey;
    history.hashToggles.push(newYugoKey);
  }

  return history;
}

function undoMove(board, history) {
  // Restore the board state
  for (const change of history.changes) {
    board[change.r][change.c] = change.prev;
  }

  // Revert the exact hash changes (XOR is its own inverse!)
  for (const toggleKey of history.hashToggles) {
    currentHash ^= toggleKey;
  }
}

function other(player) {
  return player === 1 ? 2 : 1;
}

function getLegalMovesOnBoard(board, player) {
  const legalMoves = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player)) {
        legalMoves.push({ row: r, col: c });
      }
    }
  }
  return legalMoves;
}

function countImmediateWinsOnBoard(board, player) {
  return countExactFourCompletionMoves(board, player);
}

function countDoubleThreatsOnBoard(board, player) {
  const threats = new Map();
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      for (const [dr, dc] of directions) {
        const cells = [];
        let blocked = false;

        for (let step = 0; step < 4; step += 1) {
          const nextRow = row + step * dr;
          const nextCol = col + step * dc;
          if (
            nextRow < 0 ||
            nextRow >= size ||
            nextCol < 0 ||
            nextCol >= size
          ) {
            blocked = true;
            break;
          }
          cells.push([nextRow, nextCol]);
        }

        if (blocked) continue;

        let playerCount = 0;
        let emptyCell = null;
        for (const [nextRow, nextCol] of cells) {
          const tile = board[nextRow][nextCol];
          if (!tile) {
            if (emptyCell) {
              emptyCell = null;
              break;
            }
            emptyCell = [nextRow, nextCol];
          } else if (tile.player === player) {
            playerCount += 1;
          } else {
            emptyCell = null;
            break;
          }
        }

        if (playerCount === 3 && emptyCell) {
          const key = `${emptyCell[0]}:${emptyCell[1]}`;
          threats.set(key, (threats.get(key) || 0) + 1);
        }
      }
    }
  }

  let count = 0;
  for (const value of threats.values()) {
    if (value >= 2) count += 1;
  }
  return count;
}

function countExactFourCompletionMoves(board, player) {
  const winningMoves = new Set();
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      for (const [dr, dc] of directions) {
        const cells = [];
        let blocked = false;

        for (let step = 0; step < 4; step += 1) {
          const nextRow = row + step * dr;
          const nextCol = col + step * dc;
          if (
            nextRow < 0 ||
            nextRow >= size ||
            nextCol < 0 ||
            nextCol >= size
          ) {
            blocked = true;
            break;
          }
          cells.push([nextRow, nextCol]);
        }

        if (blocked) continue;

        let playerCount = 0;
        let emptyCell = null;
        for (const [nextRow, nextCol] of cells) {
          const tile = board[nextRow][nextCol];
          if (!tile) {
            if (emptyCell) {
              emptyCell = null;
              break;
            }
            emptyCell = [nextRow, nextCol];
          } else if (tile.player === player) {
            playerCount += 1;
          } else {
            emptyCell = null;
            break;
          }
        }

        if (playerCount === 3 && emptyCell) {
          winningMoves.add(`${emptyCell[0]}:${emptyCell[1]}`);
        }
      }
    }
  }

  return winningMoves.size;
}

function countOpenSequencesOnBoard(board, player, targetLength) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  let count = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile || tile.player !== player) continue;

      for (const [dr, dc] of directions) {
        const prevRow = row - dr;
        const prevCol = col - dc;
        if (
          prevRow >= 0 &&
          prevRow < size &&
          prevCol >= 0 &&
          prevCol < size &&
          board[prevRow][prevCol] &&
          board[prevRow][prevCol].player === player
        ) {
          continue;
        }

        let currentRow = row;
        let currentCol = col;
        let length = 0;

        while (
          currentRow >= 0 &&
          currentRow < size &&
          currentCol >= 0 &&
          currentCol < size
        ) {
          const currentTile = board[currentRow][currentCol];
          if (!currentTile || currentTile.player !== player) break;
          length += 1;
          currentRow += dr;
          currentCol += dc;
        }

        if (length !== targetLength) continue;

        const beforeRow = row - dr;
        const beforeCol = col - dc;
        const openBefore =
          beforeRow >= 0 &&
          beforeRow < size &&
          beforeCol >= 0 &&
          beforeCol < size &&
          !board[beforeRow][beforeCol];
        const openAfter =
          currentRow >= 0 &&
          currentRow < size &&
          currentCol >= 0 &&
          currentCol < size &&
          !board[currentRow][currentCol];

        if (openBefore && openAfter) {
          count += 1;
        }
      }
    }
  }

  return count;
}

function centerControlOnBoard(board, player) {
  const center = (size - 1) / 2;
  let score = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile || tile.player !== player) continue;

      const distance = Math.abs(row - center) + Math.abs(col - center);
      score += Math.max(0, 4 - distance / 2);
    }
  }

  return score;
}

function connectivityOnBoard(board, player) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  let pairs = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile || tile.player !== player) continue;

      for (const [dr, dc] of directions) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (
          nextRow >= 0 &&
          nextRow < size &&
          nextCol >= 0 &&
          nextCol < size &&
          board[nextRow][nextCol] &&
          board[nextRow][nextCol].player === player
        ) {
          pairs += 1;
        }
      }
    }
  }

  return pairs;
}

function influenceOnBoard(board, player) {
  const influenced = new Set();

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile || tile.player !== player) continue;

      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (
            nextRow < 0 ||
            nextRow >= size ||
            nextCol < 0 ||
            nextCol >= size
          ) {
            continue;
          }
          if (!board[nextRow][nextCol]) {
            influenced.add(`${nextRow}:${nextCol}`);
          }
        }
      }
    }
  }

  return influenced.size;
}

function expansionPotentialOnBoard(board, player) {
  let score = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (board[row][col]) continue;
      if (wouldCreateLongLineOnBoard(board, row, col, player)) continue;

      let adjacentFriendly = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (
            nextRow < 0 ||
            nextRow >= size ||
            nextCol < 0 ||
            nextCol >= size
          ) {
            continue;
          }
          const tile = board[nextRow][nextCol];
          if (tile && tile.player === player) {
            adjacentFriendly += 1;
          }
        }
      }

      if (adjacentFriendly > 0) {
        score += adjacentFriendly;
      }
    }
  }

  return score;
}

function moveOrderScore(board, move, player) {
  const center = (size - 1) / 2;
  const opponent = other(player);
  let score = 0;

  const distanceToCenter =
    Math.abs(move.row - center) + Math.abs(move.col - center);
  score += 10 - distanceToCenter;

  score += tacticalMoveBonus(board, move, player, opponent);

  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nextRow = move.row + dr;
      const nextCol = move.col + dc;
      if (nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size) {
        continue;
      }
      const tile = board[nextRow][nextCol];
      if (!tile) continue;
      if (tile.player === player) {
        score += 4;
      } else {
        score += 2;
      }
    }
  }

  return score;
}

function tacticalMoveBonus(board, move, player, opponent) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  let score = 0;

  for (const [dr, dc] of directions) {
    for (let offset = 0; offset < 4; offset += 1) {
      const startRow = move.row - offset * dr;
      const startCol = move.col - offset * dc;

      let playerMigos = 0;
      let playerYugos = 0;
      let opponentMigos = 0;
      let opponentYugos = 0;
      let empties = 0;
      let moveIsInWindow = false;
      let invalid = false;

      for (let step = 0; step < 4; step += 1) {
        const row = startRow + step * dr;
        const col = startCol + step * dc;
        if (row < 0 || row >= size || col < 0 || col >= size) {
          invalid = true;
          break;
        }
        if (row === move.row && col === move.col) moveIsInWindow = true;

        const tile = board[row][col];
        if (!tile) {
          empties += 1;
        } else if (tile.player === player) {
          if (tile.yugo) playerYugos += 1;
          else playerMigos += 1;
        } else if (tile.player === opponent) {
          if (tile.yugo) opponentYugos += 1;
          else opponentMigos += 1;
        }
      }

      if (invalid || !moveIsInWindow) continue;

      // --- AI'S OFFENSIVE SORTING ---
      const totalPlayerPieces = playerYugos + playerMigos;

      if (playerYugos === 3 && empties === 1) score += 50000;
      else if (playerYugos >= 1 && totalPlayerPieces === 3 && empties === 1)
        score += 15000; // Caterpillar attack!
      else if (totalPlayerPieces === 3 && empties === 1) score += 6500;

      if (playerYugos >= 1 && totalPlayerPieces === 2 && empties === 2)
        score += 8000; // Start caterpillar
      else if (totalPlayerPieces === 2 && empties === 2) score += 1100;

      // --- OPPONENT'S DEFENSIVE SORTING ---
      const totalOpponentPieces = opponentYugos + opponentMigos;

      // 1. INSTANT BLOCKS (Highest Priority)
      if (opponentYugos === 3 && empties === 1) score += 49000;
      else if (opponentYugos >= 1 && totalOpponentPieces === 3 && empties === 1)
        score += 35000; // Block caterpillar!
      else if (totalOpponentPieces === 3 && empties === 1) score += 20000;

      // 2. YUGO PANIC
      if (opponentYugos === 2 && empties === 2) score += 25000;
      if (opponentYugos === 2 && empties === 1) score += 15000;

      // 3. THE CATERPILLAR OPEN 2 FIX
      if (opponentYugos >= 1 && totalOpponentPieces === 2 && empties === 2)
        score += 18000; // Block early caterpillar!
      else if (totalOpponentPieces === 2 && empties === 2) score += 8000;

      if (totalOpponentPieces === 2 && empties === 1) score += 5000;
    }
  }

  return score;
}

function getCriticalCells(board, player) {
  const cells = new Set();
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      for (const [dr, dc] of directions) {
        let playerCount = 0;
        let empties = 0;
        let emptyCell = null;
        let invalid = false;

        for (let step = 0; step < 4; step += 1) {
          const nr = row + step * dr;
          const nc = col + step * dc;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
            invalid = true;
            break;
          }

          const tile = board[nr][nc];
          if (!tile) {
            empties += 1;
            emptyCell = `${nr}:${nc}`;
          } else if (tile.player === player) {
            // Treats both Migos and Yugos equally as pieces
            playerCount += 1;
          } else {
            invalid = true;
            break;
          }
        }

        if (!invalid && playerCount === 3 && empties === 1 && emptyCell) {
          cells.add(emptyCell);
        }
      }
    }
  }
  return cells;
}

// ==========================================
// THE NEW MASTER EVALUATOR
// ==========================================
function evaluate(board, aiPlayer) {
  const humanPlayer = other(aiPlayer);
  let totalScore = 0;

  // --- 1. YUGO ECONOMY ---
  let myYugos = countYugosOnBoard(board, aiPlayer);
  let oppYugos = countYugosOnBoard(board, humanPlayer);
  totalScore += myYugos * 10000;
  totalScore -= oppYugos * 12000;

  // --- 2. IGO THREATS (Instant Game Over) ---
  let myIgoThreats = getIgoThreatCells(board, aiPlayer).length;
  let oppIgoThreats = getIgoThreatCells(board, humanPlayer).length;
  totalScore += myIgoThreats * 100000;
  totalScore -= oppIgoThreats * 200000;

  // --- 3. GUARANTEED YUGO THREATS (The Fix!) ---
  let myThreats = countImmediateWinsOnBoard(board, aiPlayer);
  let oppThreats = countImmediateWinsOnBoard(board, humanPlayer);
  totalScore += myThreats * 5000;
  totalScore -= oppThreats * 80000; // MASSIVE PANIC: Block 3-in-a-row immediately!

  // --- 4. OPEN 2s (Catch them before they become 3s!) ---
  let myOpen2s = countOpenSequencesOnBoard(board, aiPlayer, 2);
  let oppOpen2s = countOpenSequencesOnBoard(board, humanPlayer, 2);
  totalScore += myOpen2s * 1500;
  totalScore -= oppOpen2s * 40000; // SHUT DOWN Open 2s at all costs!

  // --- 5. FAST INTEGER PATTERN SCANNING ---
  totalScore += evaluateAllLinesFast(board, aiPlayer, humanPlayer);

  // --- 6. HEATMAP ---
  totalScore += calculateHeatmap(board, aiPlayer);
  totalScore -= calculateHeatmap(board, humanPlayer);

  return totalScore;
}

// ==========================================
// FAST INTEGER PATTERN SCANNER (No Strings!)
// ==========================================
const lineBuffer = new Int8Array(8);

function evaluateAllLinesFast(board, aiPlayer, humanPlayer) {
  let totalScore = 0;

  // Map to Ints: 0=Empty, 1=AI Migo, 2=AI Yugo, 3=Hum Migo, 4=Hum Yugo
  function getVal(r, c) {
    const t = board[r][c];
    if (!t) return 0;
    if (t.player === aiPlayer) return t.yugo ? 2 : 1;
    return t.yugo ? 4 : 3;
  }

  // Extracts a line into our reusable buffer, then scores it
  function scanAndScore(startX, startY, dX, dY, length) {
    for (let i = 0; i < length; i++) {
      lineBuffer[i] = getVal(startX + i * dX, startY + i * dY);
    }
    totalScore += scoreLineBuffer(length);
  }

  // 1. Rows
  for (let r = 0; r < size; r++) scanAndScore(r, 0, 0, 1, size);

  // 2. Columns
  for (let c = 0; c < size; c++) scanAndScore(0, c, 1, 0, size);

  // 3. Diagonals (Top-left to Bottom-right)
  for (let d = -(size - 4); d <= size - 4; d++) {
    let len = 0;
    for (let r = 0; r < size; r++) {
      let c = r - d;
      if (c >= 0 && c < size) lineBuffer[len++] = getVal(r, c);
    }
    if (len >= 4) totalScore += scoreLineBuffer(len);
  }

  // 4. Diagonals (Top-right to Bottom-left)
  for (let d = 3; d <= size * 2 - 4; d++) {
    let len = 0;
    for (let r = 0; r < size; r++) {
      let c = d - r;
      if (c >= 0 && c < size) lineBuffer[len++] = getVal(r, c);
    }
    if (len >= 4) totalScore += scoreLineBuffer(len);
  }

  return totalScore;
}

function scoreLineBuffer(len) {
  let score = 0;

  const isAI = (t) => t === 1 || t === 2;
  const isHum = (t) => t === 3 || t === 4;
  const isEmp = (t) => t === 0;

  // --- Size 3 Windows ---
  for (let i = 0; i <= len - 3; i++) {
    const t1 = lineBuffer[i],
      t2 = lineBuffer[i + 1],
      t3 = lineBuffer[i + 2];
    if (t1 === 4 && t2 === 0 && t3 === 4) score -= 60000; // Hum 404 Yugo Trap
  }

  // --- Size 4 Windows ---
  for (let i = 0; i <= len - 4; i++) {
    const t1 = lineBuffer[i],
      t2 = lineBuffer[i + 1],
      t3 = lineBuffer[i + 2],
      t4 = lineBuffer[i + 3];

    // AI Caterpillar Offense
    if (
      (t1 === 0 && t2 === 1 && t3 === 2 && t4 === 0) ||
      (t1 === 0 && t2 === 2 && t3 === 1 && t4 === 0)
    )
      score += 15000;
    if (
      (t1 === 0 && t2 === 1 && t3 === 1 && t4 === 2) ||
      (t1 === 2 && t2 === 1 && t3 === 1 && t4 === 0)
    )
      score += 40000;
    if (
      (t1 === 0 && t2 === 1 && t3 === 2 && t4 === 1) ||
      (t1 === 1 && t2 === 2 && t3 === 1 && t4 === 0)
    )
      score += 40000;
    if (
      (t1 === 0 && t2 === 1 && t3 === 2 && t4 === 2) ||
      (t1 === 2 && t2 === 2 && t3 === 1 && t4 === 0)
    )
      score += 90000;

    // Human Caterpillar Defense
    if (
      (t1 === 0 && t2 === 3 && t3 === 4 && t4 === 0) ||
      (t1 === 0 && t2 === 4 && t3 === 3 && t4 === 0)
    )
      score -= 25000;
    if (
      (t1 === 0 && t2 === 3 && t3 === 3 && t4 === 4) ||
      (t1 === 4 && t2 === 3 && t3 === 3 && t4 === 0)
    )
      score -= 60000; // Combines the 80000 rule
    if (
      (t1 === 0 && t2 === 3 && t3 === 4 && t4 === 3) ||
      (t1 === 3 && t2 === 4 && t3 === 3 && t4 === 0)
    )
      score -= 60000;
    if (
      (t1 === 0 && t2 === 3 && t3 === 4 && t4 === 4) ||
      (t1 === 4 && t2 === 4 && t3 === 3 && t4 === 0)
    )
      score -= 150000;

    // Human Yugo Networks
    if (t1 === 0 && t2 === 4 && t3 === 4 && t4 === 0) score -= 100000;
    if (
      (t1 === 3 && t2 === 4 && t3 === 4 && t4 === 0) ||
      (t1 === 0 && t2 === 4 && t3 === 4 && t4 === 3)
    )
      score -= 50000;
    if (
      (t1 === 3 && t2 === 4 && t3 === 4 && t4 === 4) ||
      (t1 === 4 && t2 === 4 && t3 === 4 && t4 === 3)
    )
      score -= 150000;
    if (
      (t1 === 0 && t2 === 4 && t3 === 4 && t4 === 4) ||
      (t1 === 4 && t2 === 4 && t3 === 4 && t4 === 0)
    )
      score -= 150000;
    if (t1 === 4 && t2 === 0 && t3 === 0 && t4 === 4) score -= 15000;
    if (
      (t1 === 4 && t2 === 3 && t3 === 0 && t4 === 4) ||
      (t1 === 4 && t2 === 0 && t3 === 3 && t4 === 4)
    )
      score -= 100000;
  }

  // --- Size 5 Windows (General Lines) ---
  for (let i = 0; i <= len - 5; i++) {
    const t1 = lineBuffer[i],
      t2 = lineBuffer[i + 1],
      t3 = lineBuffer[i + 2],
      t4 = lineBuffer[i + 3],
      t5 = lineBuffer[i + 4];

    // Overline Penalty (Prevent building 5+)
    if (isAI(t1) && isEmp(t2) && isAI(t3) && isAI(t4) && isAI(t5)) score -= 500;
    if (isAI(t1) && isAI(t2) && isAI(t3) && isEmp(t4) && isAI(t5)) score -= 500;
    if (isAI(t1) && isAI(t2) && isEmp(t3) && isAI(t4) && isAI(t5)) score -= 500;

    // AI Basic Threats
    if (isEmp(t1) && isAI(t2) && isAI(t3) && isAI(t4) && isEmp(t5))
      score += 1500; // Open 3
    if (
      (isEmp(t1) && isAI(t2) && isEmp(t3) && isAI(t4) && isAI(t5)) ||
      (isAI(t1) && isAI(t2) && isEmp(t3) && isAI(t4) && isEmp(t5))
    )
      score += 800; // Broken 3

    // Human Basic Threats
    if (isEmp(t1) && isHum(t2) && isHum(t3) && isHum(t4) && isEmp(t5))
      score -= 5000; // Open 3
    if (
      (isEmp(t1) && isHum(t2) && isEmp(t3) && isHum(t4) && isHum(t5)) ||
      (isHum(t1) && isHum(t2) && isEmp(t3) && isHum(t4) && isEmp(t5))
    )
      score -= 3000; // Broken 3
  }

  // --- Size 6 Windows ---
  for (let i = 0; i <= len - 6; i++) {
    const t1 = lineBuffer[i],
      t2 = lineBuffer[i + 1],
      t3 = lineBuffer[i + 2],
      t4 = lineBuffer[i + 3],
      t5 = lineBuffer[i + 4],
      t6 = lineBuffer[i + 5];

    // Open 2s
    if (
      isEmp(t1) &&
      isEmp(t2) &&
      isAI(t3) &&
      isAI(t4) &&
      isEmp(t5) &&
      isEmp(t6)
    )
      score += 250;
    if (
      isEmp(t1) &&
      isEmp(t2) &&
      isHum(t3) &&
      isHum(t4) &&
      isEmp(t5) &&
      isEmp(t6)
    )
      score -= 900;
  }

  return score;
}

// ==========================================
// THE POSITIONAL HEATMAP
// ==========================================
function calculateHeatmap(board, player) {
  let heatScore = 0;
  const heatGrid = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 2, 2, 2, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 1, 0],
    [0, 1, 2, 2, 2, 2, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const tile = board[r][c];
      if (tile && tile.player === player) {
        if (tile.yugo) {
          heatScore += heatGrid[r][c] * 5; // Yugos in the center are brutal
        } else {
          heatScore += heatGrid[r][c];
        }
      }
    }
  }
  return heatScore;
}

function countMigoConnectivity(board, player) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  let pairs = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile || tile.player !== player || tile.yugo) continue;

      for (const [dr, dc] of directions) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size) {
          continue;
        }
        const nextTile = board[nextRow][nextCol];
        if (nextTile && nextTile.player === player && !nextTile.yugo) {
          pairs += 1;
        }
      }
    }
  }

  return pairs;
}

function getMigoHeatmapValue(row, col) {
  const center = 3.5;
  const distance = Math.abs(row - center) + Math.abs(col - center);
  if (distance <= 1.5) return 4;
  if (distance <= 3) return 3;
  if (distance <= 4.5) return 2;
  return 1;
}

function countYugosOnBoard(board, player) {
  let count = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (tile && tile.player === player && tile.yugo) {
        count += 1;
      }
    }
  }
  return count;
}

function wouldCreateLongLineOnBoard(board, row, col, player) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (const [dr, dc] of directions) {
    let count = 1;

    // Check positive
    for (let i = 1; i < 5; i++) {
      // Check up to 5
      const nr = row + i * dr;
      const nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      // IF it's your own Migo, it increases the count.
      // If it's a Yugo, it DOES NOT break the line, but it IS part of the line.
      if (tile && tile.player === player) count++;
      else break;
    }

    // Check negative
    for (let i = 1; i < 5; i++) {
      const nr = row - i * dr;
      const nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (tile && tile.player === player) count++;
      else break;
    }

    if (count >= 5) return true; // CRITICAL: Stop any move that creates 5+
  }
  return false;
}

function hasLegalMovesOnBoard(board, player) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player)) {
        return true;
      }
    }
  }
  return false;
}

function findAllStraightLinesOnBoard(board, row, col, player) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  const validLines = [];

  for (const [dr, dc] of directions) {
    const line = [[row, col]];
    for (let i = 1; i < 4; i++) {
      const nr = row + i * dr;
      const nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      line.push([nr, nc]);
    }
    for (let i = 1; i < 4; i++) {
      const nr = row - i * dr;
      const nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      line.unshift([nr, nc]);
    }

    if (line.length === 4) {
      validLines.push(line);
    }
  }
  return validLines;
}

function checkIgoOnBoard(board, player) {
  const yugos = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (tile && tile.player === player && tile.yugo) {
        yugos.push([row, col]);
      }
    }
  }
  const yugoSet = new Set(yugos.map(([row, col]) => `${row}:${col}`));

  for (const [row, col] of yugos) {
    const directions = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];
    for (const [dr, dc] of directions) {
      let count = 1;
      for (let i = 1; i < 4; i++) {
        const nr = row + i * dr;
        const nc = col + i * dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
        if (!yugoSet.has(`${nr}:${nc}`)) break;
        count++;
      }
      for (let i = 1; i < 4; i++) {
        const nr = row - i * dr;
        const nc = col - i * dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
        if (!yugoSet.has(`${nr}:${nc}`)) break;
        count++;
      }
      if (count === 4) return true;
    }
  }
  return false;
}

function isBoardFullOnBoard(board) {
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!board[row][col]) return false;
    }
  }
  return true;
}

function countPointsOnBoard(board, player) {
  let count = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (tile && tile.player === player && tile.yugo) count++;
    }
  }
  return count;
}

// kalau ada 3 yugo dan 1 kosong
function getIgoThreatCells(board, player) {
  const threatCells = [];
  const directions = [
    [0, 1], // Horizontal
    [1, 0], // Vertical
    [1, 1], // Diagonal Down-Right
    [1, -1], // Diagonal Down-Left
  ];

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      for (const [dr, dc] of directions) {
        let yugoCount = 0;
        let empties = 0;
        let emptyCell = null;
        let invalid = false;

        // Slide a 4-square window
        for (let step = 0; step < 4; step++) {
          const nr = row + step * dr;
          const nc = col + step * dc;

          // Out of bounds check
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
            invalid = true;
            break;
          }

          const tile = board[nr][nc];
          if (!tile) {
            empties++;
            emptyCell = { row: nr, col: nc };
          } else if (tile.player === player && tile.yugo) {
            yugoCount++;
          } else {
            // Window contains opponent's piece or a standard Migo
            invalid = true;
            break;
          }
        }

        // If the window is a valid instant-win threat
        if (!invalid && yugoCount === 3 && empties === 1 && emptyCell) {
          // Fast deduplication (No JSON.stringify!)
          if (
            !threatCells.some(
              (c) => c.row === emptyCell.row && c.col === emptyCell.col,
            )
          ) {
            threatCells.push(emptyCell);
          }
        }
      }
    }
  }

  return threatCells;
}
