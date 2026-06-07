// ==========================================
// MIGOYUGO AI WORKER - GOD MODE (TIME-PATCHED)
// Features: Transposition Table, Iterative Deepening,
// Killer Moves, Alpha-Beta Pruning, Native Array Evaluator,
// Aggressive Time Cutoff
// ==========================================

const size = 8;
const MAX_DEPTH = 6;
const MAX_THINK_TIME = 2000; // AI berpikir maksimal 2000ms (2 Detik)

const ttMap = new Map();
const killerMoves = Array.from({ length: 30 }, () => []);
let searchStartTime = 0;
let timeIsUp = false;
let nodesEvaluated = 0;

// Re-usable buffer agar tidak membuang-buang memori (Zero Garbage Collection)
const lineBuffer = new Int8Array(8);

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

self.onmessage = function (e) {
  ttMap.clear();
  for (let i = 0; i < 30; i++) killerMoves[i] = [];

  const { board, playerColor, turn, maxDepth } = e.data;
  searchStartTime = Date.now();
  timeIsUp = false;
  nodesEvaluated = 0;

  let bestMoveGlobal = null;
  let bestScoreGlobal = -Infinity;

  const legalMoves = getLegalMovesOnBoard(board, turn);
  if (legalMoves.length === 0) {
    self.postMessage({ bestMove: null, error: "noMoves" });
    return;
  }

  let targetDepth = Number.isFinite(maxDepth) ? maxDepth : MAX_DEPTH;

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

    if (!timeIsUp) {
      bestMoveGlobal = currentBestMove || bestMoveGlobal;
      bestScoreGlobal = currentBestScore;
    }

    // Jika menemukan Igo (Menang Telak), berhenti mencari
    if (bestScoreGlobal > 8000) break;
  }

  // Paksa fallback jika entah kenapa gagal menemukan langkah karena waktu habis di iterasi pertama
  if (!bestMoveGlobal && legalMoves.length > 0) bestMoveGlobal = legalMoves[0];

  self.postMessage({ bestMove: bestMoveGlobal, bestScore: bestScoreGlobal });
};

// ==========================================
// CORE ALGORITHM: MINIMAX DENGAN ALPHA-BETA
// ==========================================
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
  // Pengecekan waktu HANYA dilakukan setiap 1024 langkah agar CPU tidak ngelag
  nodesEvaluated++;
  if ((nodesEvaluated & 1023) === 0) {
    if (Date.now() - searchStartTime > MAX_THINK_TIME) {
      timeIsUp = true;
    }
  }

  if (timeIsUp) return 0;

  const aiPlayer = playerColor === 1 ? 2 : 1;

  // 1. Cek Transposition Table (Memori)
  const hash = hashBoard(board);
  const remainingDepth = maxDepth - depth;
  if (ttMap.has(hash)) {
    const stored = ttMap.get(hash);
    if (stored.remainingDepth >= remainingDepth) {
      if (stored.flag === "EXACT") return stored.score;
      if (stored.flag === "LOWERBOUND") alpha = Math.max(alpha, stored.score);
      if (stored.flag === "UPPERBOUND") beta = Math.min(beta, stored.score);
      if (alpha >= beta) return stored.score;
    }
  }

  // 3. Kondisi Terminal
  if (checkIgoOnBoard(board, aiPlayer)) return 10000 - depth;
  if (checkIgoOnBoard(board, playerColor)) return -10000 + depth;
  if (
    isBoardFullOnBoard(board) ||
    !hasLegalMovesOnBoard(board, player) ||
    depth >= maxDepth
  ) {
    return evaluate(board, aiPlayer);
  }

  // 4. Sortir Langkah & Filter Blokir Darurat
  const legalMoves = getLegalMovesOnBoard(board, player);
  legalMoves.sort(
    (a, b) =>
      moveOrderScore(board, b, player, depth) -
      moveOrderScore(board, a, player, depth),
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

  // 5. Rekursi Pencarian
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

      if (beta <= alpha) {
        // KILLER MOVE RECORDING
        if (depth < 30) {
          const km = killerMoves[depth];
          if (!km.find((m) => m.row === move.row && m.col === move.col)) {
            km.unshift(move);
            if (km.length > 2) km.pop();
          }
        }
        break; // Beta Cutoff
      }
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

      if (beta <= alpha) {
        // KILLER MOVE RECORDING
        if (depth < 30) {
          const km = killerMoves[depth];
          if (!km.find((m) => m.row === move.row && m.col === move.col)) {
            km.unshift(move);
            if (km.length > 2) km.pop();
          }
        }
        break; // Alpha Cutoff
      }
    }
    bestScore = minEval;
  }

  // 6. Simpan ke Memori (TT)
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

  // 3. Heatmap
  totalScore += calculateHeatmap(board, aiPlayer);
  totalScore -= calculateHeatmap(board, humanPlayer);

  return totalScore;
}

function getTileVal(tile, aiPlayer, humanPlayer) {
  if (!tile) return 0;
  if (tile.player === aiPlayer) return tile.yugo ? 3 : 1;
  if (tile.player === humanPlayer) return tile.yugo ? 4 : 2;
  return 0;
}

function evaluateAllLines(board, aiPlayer, humanPlayer) {
  let score = 0;

  // Rows
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++)
      lineBuffer[c] = getTileVal(board[r][c], aiPlayer, humanPlayer);
    score += evaluateLineNative(lineBuffer, size);
  }
  // Cols
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++)
      lineBuffer[r] = getTileVal(board[r][c], aiPlayer, humanPlayer);
    score += evaluateLineNative(lineBuffer, size);
  }
  // Diagonals (Top-Left to Bottom-Right)
  for (let d = -(size - 4); d <= size - 4; d++) {
    let len = 0;
    for (let r = 0; r < size; r++) {
      let c = r - d;
      if (c >= 0 && c < size)
        lineBuffer[len++] = getTileVal(board[r][c], aiPlayer, humanPlayer);
    }
    if (len >= 4) score += evaluateLineNative(lineBuffer, len);
  }
  // Diagonals (Top-Right to Bottom-Left)
  for (let d = 3; d <= size * 2 - 4; d++) {
    let len = 0;
    for (let r = 0; r < size; r++) {
      let c = d - r;
      if (c >= 0 && c < size)
        lineBuffer[len++] = getTileVal(board[r][c], aiPlayer, humanPlayer);
    }
    if (len >= 4) score += evaluateLineNative(lineBuffer, len);
  }
  return score;
}

function evaluateLineNative(lineArr, len) {
  let score = 0;
  for (let i = 0; i < len; i++) {
    const v0 = lineArr[i];
    const v1 = i + 1 < len ? lineArr[i + 1] : -1;
    const v2 = i + 2 < len ? lineArr[i + 2] : -1;
    const v3 = i + 3 < len ? lineArr[i + 3] : -1;
    const v4 = i + 4 < len ? lineArr[i + 4] : -1;
    const v5 = i + 5 < len ? lineArr[i + 5] : -1;

    // AI Yugo Patterns
    if (v0 === 3 && v1 === 0 && v2 === 3) score += 45000;
    if (v0 === 3 && v1 === 0 && v2 === 0 && v3 === 3) score += 20000;
    if (v0 === 3 && v1 === 3 && v2 === 3 && v3 === 0) score += 100000;
    if (v0 === 0 && v1 === 3 && v2 === 3 && v3 === 3) score += 100000;
    if (v0 === 3 && v1 === 1 && v2 === 1 && v3 === 0) score += 60000;
    if (v0 === 0 && v1 === 1 && v2 === 1 && v3 === 3) score += 60000;
    if (v0 === 3 && v1 === 1 && v2 === 0 && v3 === 3) score += 90000;
    if (v0 === 3 && v1 === 0 && v2 === 1 && v3 === 3) score += 90000;
    if (v0 === 0 && v1 === 3 && v2 === 3 && v3 === 0) score += 40000;
    if (v0 === 0 && v1 === 3 && v2 === 0 && v3 === 3 && v4 === 0)
      score += 40000;

    // AI Migo Patterns
    if (v0 === 0 && v1 === 1 && v2 === 1 && v3 === 1 && v4 === 0) score += 800;
    if (v0 === 0 && v1 === 1 && v2 === 0 && v3 === 1 && v4 === 1) score += 800;
    if (v0 === 1 && v1 === 1 && v2 === 0 && v3 === 1 && v4 === 0) score += 800;
    if (v0 === 0 && v1 === 0 && v2 === 1 && v3 === 1 && v4 === 0 && v5 === 0)
      score += 250;

    // AI Overlines Trap Penalti
    if (v0 === 1 && v1 === 0 && v2 === 1 && v3 === 1 && v4 === 1) score -= 500;
    if (v0 === 1 && v1 === 1 && v2 === 1 && v3 === 0 && v4 === 1) score -= 500;
    if (v0 === 1 && v1 === 1 && v2 === 0 && v3 === 1 && v4 === 1) score -= 500;

    // Opponent Yugo Patterns (Sangat Bahaya)
    if (v0 === 4 && v1 === 0 && v2 === 4) score -= 60000;
    if (v0 === 4 && v1 === 0 && v2 === 0 && v3 === 4) score -= 15000;
    if (v0 === 4 && v1 === 4 && v2 === 4 && v3 === 0) score -= 150000;
    if (v0 === 0 && v1 === 4 && v2 === 4 && v3 === 4) score -= 150000;
    if (v0 === 4 && v1 === 2 && v2 === 2 && v3 === 0) score -= 80000;
    if (v0 === 0 && v1 === 2 && v2 === 2 && v3 === 4) score -= 80000;
    if (v0 === 4 && v1 === 2 && v2 === 0 && v3 === 4) score -= 100000;
    if (v0 === 4 && v1 === 0 && v2 === 2 && v3 === 4) score -= 100000;
    if (v0 === 0 && v1 === 4 && v2 === 4 && v3 === 0) score -= 40000;

    // Opponent Migo Patterns
    if (v0 === 0 && v1 === 2 && v2 === 2 && v3 === 2 && v4 === 0) score -= 3000;
    if (v0 === 0 && v1 === 2 && v2 === 0 && v3 === 2 && v4 === 2) score -= 3000;
    if (v0 === 2 && v1 === 2 && v2 === 0 && v3 === 2 && v4 === 0) score -= 3000;
    if (v0 === 0 && v1 === 0 && v2 === 2 && v3 === 2 && v4 === 0 && v5 === 0)
      score -= 900;
  }
  return score;
}

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
        heatScore += tile.yugo ? heatGrid[r][c] * 5 : heatGrid[r][c];
      }
    }
  }
  return heatScore;
}

// ==========================================
// PENGURUTAN LANGKAH (MOVE ORDERING)
// ==========================================
function moveOrderScore(board, move, player, depth) {
  let score = 0;

  // 1. Killer Move Bonus
  if (depth < 30) {
    const killers = killerMoves[depth];
    for (const km of killers) {
      if (km && km.row === move.row && km.col === move.col) {
        return 50000; // Prioritas sangat tinggi
      }
    }
  }

  // 2. Evaluasi Taktikal
  const center = (size - 1) / 2;
  const opponent = other(player);
  const distanceToCenter =
    Math.abs(move.row - center) + Math.abs(move.col - center);
  score += 10 - distanceToCenter;
  score += tacticalMoveBonus(board, move, player, opponent);

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

      let pMigos = 0,
        pYugos = 0,
        oMigos = 0,
        oYugos = 0,
        empties = 0;
      let moveIsInWindow = false,
        invalid = false;

      for (let step = 0; step < 4; step += 1) {
        const row = startRow + step * dr;
        const col = startCol + step * dc;
        if (row < 0 || row >= size || col < 0 || col >= size) {
          invalid = true;
          break;
        }
        if (row === move.row && col === move.col) moveIsInWindow = true;

        const tile = board[row][col];
        if (!tile) empties += 1;
        else if (tile.player === player) {
          tile.yugo ? pYugos++ : pMigos++;
        } else if (tile.player === opponent) {
          tile.yugo ? oYugos++ : oMigos++;
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
// CORE BOARD MECHANICS
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

function simulateMove(board, row, col, player) {
  board[row][col] = { player, yugo: false };
  const lines = findAllStraightLinesOnBoard(board, row, col, player);
  if (lines.length > 0) {
    const tilesToRemove = new Set();
    const existingYugos = [];

    for (const line of lines) {
      for (const [r, c] of line) {
        tilesToRemove.add(`${r}:${c}`);
        const tile = board[r][c];
        if (tile && tile.yugo) existingYugos.push({ r, c });
      }
    }

    for (const key of tilesToRemove) {
      const [r, c] = key.split(":").map(Number);
      board[r][c] = null;
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

function getLegalMovesOnBoard(board, player) {
  const legalMoves = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player)) {
        legalMoves.push({ row: r, col: c });
      }
    }
  }
  return legalMoves;
}

function hasLegalMovesOnBoard(board, player) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player))
        return true;
    }
  }
  return false;
}

function isBoardFullOnBoard(board) {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!board[row][col]) return false;
    }
  }
  return true;
}

function countYugosOnBoard(board, player) {
  let count = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const tile = board[row][col];
      if (tile && tile.player === player && tile.yugo) count++;
    }
  }
  return count;
}

function other(player) {
  return player === 1 ? 2 : 1;
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
      const nr = row + i * dr,
        nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      line.push([nr, nc]);
    }
    for (let i = 1; i < 4; i++) {
      const nr = row - i * dr,
        nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      line.unshift([nr, nc]);
    }
    if (line.length === 4) validLines.push(line);
  }
  return validLines;
}

function checkIgoOnBoard(board, player) {
  const yugos = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const tile = board[row][col];
      if (tile && tile.player === player && tile.yugo) yugos.push([row, col]);
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
        const nr = row + i * dr,
          nc = col + i * dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
        if (!yugoSet.has(`${nr}:${nc}`)) break;
        count++;
      }
      for (let i = 1; i < 4; i++) {
        const nr = row - i * dr,
          nc = col - i * dc;
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
