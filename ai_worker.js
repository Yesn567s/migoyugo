// AI Worker - Runs minimax in background thread
const size = 8;
const MAX_DEPTH = 4;

// --- NEW: THE MEMORY BANK ---
const ttMap = new Map();

// Pre-allocate the memory array once
const HASH_BUFFER = new Array(64);

function hashBoard(board) {
  let idx = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = board[r][c];
      // Fast branchless assignment
      HASH_BUFFER[idx++] = t
        ? t.player === 1
          ? t.yugo
            ? "3"
            : "1"
          : t.yugo
            ? "4"
            : "2"
        : "0";
    }
  }
  // V8 optimizes array.join heavily
  return HASH_BUFFER.join("");
}
// -----------------------------

self.onmessage = function (e) {
  ttMap.clear();
  const { board, playerColor, turn, maxDepth } = e.data;
  const searchMaxDepth = Number.isFinite(maxDepth) ? maxDepth : MAX_DEPTH;

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

  for (const move of movesToScore) {
    // FAST MUTATE
    const history = applyMove(board, move.row, move.col, turn);
    const nextPlayer = turn === 1 ? 2 : 1;

    // Pass the SAME board into minimax, not a clone
    const score = minimax(
      board,
      nextPlayer,
      1,
      -Infinity,
      Infinity,
      false,
      playerColor,
      searchMaxDepth,
    );

    // FAST UNDO
    undoMove(board, history);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  self.postMessage({ bestMove, bestScore });
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

  // --- 1. CHECK THE TRANSPOSITION TABLE ---
  const hash = hashBoard(board);
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
  };

  // 1. Save the empty tile state before placing the piece
  history.changes.push({ r: row, c: col, prev: null });
  board[row][col] = { player, yugo: false };

  const lines = findAllStraightLinesOnBoard(board, row, col, player);

  if (lines.length > 0) {
    const tilesAffected = [];
    const existingYugos = [];

    // Map out all the tiles involved in the line (String-free!)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const [r, c] = line[j];

        // Fast deduplication array search
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

    // 2. Save the state of every affected tile BEFORE wiping it
    for (let i = 0; i < tilesAffected.length; i++) {
      const { r, c } = tilesAffected[i];
      if (r !== row || c !== col) {
        history.changes.push({ r, c, prev: board[r][c] });
      }
      board[r][c] = null; // Wipe it
    }

    // 3. Re-place Yugos
    for (let i = 0; i < existingYugos.length; i++) {
      const { r, c } = existingYugos[i];
      board[r][c] = { player, yugo: true };
    }
    board[row][col] = { player, yugo: true };
  }

  return history;
}

function undoMove(board, history) {
  // Read the history and restore the exact previous state of every touched tile
  for (const change of history.changes) {
    board[change.r][change.c] = change.prev;
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

  // --- 5. STRING PATTERN SCANNING (Sandwiches & Traps) ---
  let allLines = extractAllLinesAsStrings(board, aiPlayer, humanPlayer);
  for (let lineStr of allLines) {
    totalScore += evaluateLineString(lineStr);
  }

  // --- 6. HEATMAP ---
  totalScore += calculateHeatmap(board, aiPlayer);
  totalScore -= calculateHeatmap(board, humanPlayer);

  return totalScore;
}

// ==========================================
// STRING EXTRACTOR (Converts the 2D Board into text)
// ==========================================
function extractAllLinesAsStrings(board, aiPlayer, humanPlayer) {
  const lines = [];

  // Helper to map your objects to string characters:
  // "0" = Empty | "1" = AI Migo | "3" = AI Yugo | "2" = Human Migo | "4" = Human Yugo
  function tileChar(r, c) {
    const tile = board[r][c];
    if (!tile) return "0";
    if (tile.player === aiPlayer) return tile.yugo ? "3" : "1";
    if (tile.player === humanPlayer) return tile.yugo ? "4" : "2";
    return "0";
  }

  // Extract Rows
  for (let r = 0; r < size; r++) {
    let rowStr = "";
    for (let c = 0; c < size; c++) rowStr += tileChar(r, c);
    lines.push(rowStr);
  }

  // Extract Columns
  for (let c = 0; c < size; c++) {
    let colStr = "";
    for (let r = 0; r < size; r++) colStr += tileChar(r, c);
    lines.push(colStr);
  }

  // Extract Diagonals (Top-left to Bottom-right)
  for (let d = -(size - 4); d <= size - 4; d++) {
    let diagStr = "";
    for (let r = 0; r < size; r++) {
      let c = r - d;
      if (c >= 0 && c < size) diagStr += tileChar(r, c);
    }
    if (diagStr.length >= 4) lines.push(diagStr);
  }

  // Extract Diagonals (Top-right to Bottom-left)
  for (let d = 3; d <= size * 2 - 4; d++) {
    let diagStr = "";
    for (let r = 0; r < size; r++) {
      let c = d - r;
      if (c >= 0 && c < size) diagStr += tileChar(r, c);
    }
    if (diagStr.length >= 4) lines.push(diagStr);
  }

  return lines;
}

// ==========================================
// THE PATTERN SCANNER
// ==========================================
function evaluateLineString(lineStr) {
  let score = 0;

  // OVERLINE TRAPS (If it creates 5, penalize heavily!)
  if (
    lineStr.includes("10111") ||
    lineStr.includes("11101") ||
    lineStr.includes("11011")
  ) {
    score -= 500;
  }

  // --- THE FIX: Collapse Yugos into Migos for basic threat detection ---
  // 1 = AI, 2 = Human
  const simpleStr = lineStr.replace(/3/g, "1").replace(/4/g, "2");

  if (simpleStr.includes("01110")) score += 1500; // AI Open 3
  if (simpleStr.includes("01011") || simpleStr.includes("11010")) score += 800; // AI Broken 3
  if (simpleStr.includes("001100")) score += 250; // AI Open 2

  if (simpleStr.includes("02220")) score -= 5000; // Opp Open 3 (Massive penalty)
  if (simpleStr.includes("02022") || simpleStr.includes("22020")) score -= 3000; // Opp Broken 3
  if (simpleStr.includes("002200")) score -= 900; // Opp Open 2

  // --- NEW: THE CATERPILLAR DEFENSE (Yugos are reusable!) ---
  // 4 = Opponent Yugo, 2 = Opponent Migo
  if (lineStr.includes("0240") || lineStr.includes("0420")) score -= 25000; // Yugo-backed Open 2
  if (lineStr.includes("0224") || lineStr.includes("4220")) score -= 60000; // Yugo-backed Open 3
  if (lineStr.includes("0242") || lineStr.includes("2420")) score -= 60000;
  if (lineStr.includes("0244") || lineStr.includes("4420")) score -= 150000; // 2 Yugos + Migo (Lethal)

  // --- AI'S OWN CATERPILLAR OFFENSE ---
  // 3 = AI Yugo, 1 = AI Migo
  if (lineStr.includes("0130") || lineStr.includes("0310")) score += 15000;
  if (lineStr.includes("0113") || lineStr.includes("3110")) score += 40000;
  if (lineStr.includes("0131") || lineStr.includes("1310")) score += 40000;
  if (lineStr.includes("0133") || lineStr.includes("3310")) score += 90000;

  // OPPONENT YUGO NETWORKS (Terrifying threats)
  if (lineStr.includes("0440")) score -= 100000;
  if (lineStr.includes("2440") || lineStr.includes("0442")) score -= 50000;
  if (lineStr.includes("2444") || lineStr.includes("4442")) score -= 150000;
  if (lineStr.includes("0444") || lineStr.includes("4440")) score -= 150000;
  if (lineStr.includes("404")) score -= 60000;
  if (lineStr.includes("4220") || lineStr.includes("0224")) score -= 80000;
  if (lineStr.includes("4004")) score -= 15000;
  if (lineStr.includes("4204") || lineStr.includes("4024")) score -= 100000;

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
