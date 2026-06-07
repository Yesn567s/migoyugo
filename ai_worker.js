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

function hashBoard(board) {
  let str = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = board[r][c];
      str += t
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
  return str;
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

  // 1. ITERATIVE DEEPENING LOOP
  for (
    let currentSearchDepth = 1;
    currentSearchDepth <= targetDepth;
    currentSearchDepth++
  ) {
    if (timeIsUp) break;

    let currentBestMove = null;
    let currentBestScore = -Infinity;

    // Prioritaskan langkah terbaik dari depth sebelumnya (Best Move Ordering)
    legalMoves.sort((a, b) => {
      if (
        bestMoveGlobal &&
        a.row === bestMoveGlobal.row &&
        a.col === bestMoveGlobal.col
      )
        return -1;
      if (
        bestMoveGlobal &&
        b.row === bestMoveGlobal.row &&
        b.col === bestMoveGlobal.col
      )
        return 1;
      return (
        moveOrderScore(board, b, turn, 0) - moveOrderScore(board, a, turn, 0)
      );
    });

    let alpha = -Infinity;
    let beta = Infinity;

    for (const move of legalMoves) {
      if (timeIsUp) break;

      const nextBoard = cloneBoard(board);
      simulateMove(nextBoard, move.row, move.col, turn);
      const nextPlayer = turn === 1 ? 2 : 1;

      const score = minimax(
        nextBoard,
        nextPlayer,
        1, // Start depth counter
        alpha,
        beta,
        false, // Lawan akan me-minimize
        playerColor,
        currentSearchDepth,
      );

      if (!timeIsUp && score > currentBestScore) {
        currentBestScore = score;
        currentBestMove = move;
      }
      alpha = Math.max(alpha, score);
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

  const maxMoves = depth <= 1 ? 25 : depth === 2 ? 20 : 15;
  const urgentBlockCells = getUrgentBlockCells(board, other(player));
  const urgentMoves =
    urgentBlockCells.size > 0
      ? legalMoves.filter((move) =>
          urgentBlockCells.has(`${move.row}:${move.col}`),
        )
      : [];

  const movesToExplore =
    urgentMoves.length > 0
      ? urgentMoves.slice(0, Math.min(maxMoves, urgentMoves.length))
      : legalMoves.slice(0, Math.min(maxMoves, legalMoves.length));

  // 5. Rekursi Pencarian
  let originalAlpha = alpha;
  let bestScore;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of movesToExplore) {
      const newBoard = cloneBoard(board);
      const preMoveYugos = countYugosOnBoard(board, player);

      simulateMove(newBoard, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(newBoard, player);
      const nextPlayer = other(player);
      const nextDepth = postMoveYugos > preMoveYugos ? depth : depth + 1; // Horizon Fix

      const moveScore = minimax(
        newBoard,
        nextPlayer,
        nextDepth,
        alpha,
        beta,
        false,
        playerColor,
        maxDepth,
      );
      if (timeIsUp) return 0;

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
      const newBoard = cloneBoard(board);
      const preMoveYugos = countYugosOnBoard(board, player);

      simulateMove(newBoard, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(newBoard, player);
      const nextPlayer = other(player);
      const nextDepth = postMoveYugos > preMoveYugos ? depth : depth + 1;

      const moveScore = minimax(
        newBoard,
        nextPlayer,
        nextDepth,
        alpha,
        beta,
        true,
        playerColor,
        maxDepth,
      );
      if (timeIsUp) return 0;

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

// ==========================================
// MASTER EVALUATOR (10X LEBIH CEPAT TANPA STRING)
// ==========================================
function evaluate(board, aiPlayer) {
  const humanPlayer = other(aiPlayer);
  let totalScore = 0;

  // 1. Ekonomi Yugo
  let myYugos = countYugosOnBoard(board, aiPlayer);
  let oppYugos = countYugosOnBoard(board, humanPlayer);
  totalScore += myYugos * 10000;
  totalScore -= oppYugos * 12000;

  // 2. Pemindaian Pola Array Cepat (Native)
  totalScore += evaluateAllLines(board, aiPlayer, humanPlayer);

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

      const totalPlayer = pYugos + pMigos;
      if (totalPlayer === 3 && empties === 1) score += 6500;
      if (totalPlayer === 2 && empties === 2) score += 1100;

      const totalOpponent = oYugos + oMigos;
      if (totalOpponent === 3 && empties === 1) score += 9000; // Blokir ancaman lawan
      if (totalOpponent === 2 && empties === 1) score += 5000;
    }
  }
  return score;
}

function getUrgentBlockCells(board, threatenedPlayer) {
  const urgentCells = new Set();
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      for (const [dr, dc] of directions) {
        let oppPieces = 0,
          empties = 0,
          emptyCell = null,
          invalid = false;

        for (let step = 0; step < 4; step += 1) {
          const nextRow = row + step * dr;
          const nextCol = col + step * dc;
          if (
            nextRow < 0 ||
            nextRow >= size ||
            nextCol < 0 ||
            nextCol >= size
          ) {
            invalid = true;
            break;
          }

          const tile = board[nextRow][nextCol];
          if (!tile) {
            empties += 1;
            emptyCell = [nextRow, nextCol];
          } else if (tile.player === threatenedPlayer) {
            oppPieces += 1;
          } else {
            invalid = true;
            break;
          }
        }
        if (invalid || empties !== 1 || !emptyCell) continue;
        if (oppPieces === 3) urgentCells.add(`${emptyCell[0]}:${emptyCell[1]}`);
      }
    }
  }
  return urgentCells;
}

// ==========================================
// CORE BOARD MECHANICS
// ==========================================
function cloneBoard(board) {
  return board.map((row) => row.map((tile) => (tile ? { ...tile } : null)));
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

    for (const { r, c } of existingYugos) board[r][c] = { player, yugo: true };
    board[row][col] = { player, yugo: true };
  }
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
    for (let i = 1; i < 8; i++) {
      const nr = row + i * dr,
        nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      count++;
    }
    for (let i = 1; i < 8; i++) {
      const nr = row - i * dr,
        nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      count++;
    }
    if (count > 4) return true;
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
