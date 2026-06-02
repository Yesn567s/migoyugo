// AI Worker - Runs minimax in background thread
const size = 8;
const MAX_DEPTH = 4;

// --- NEW: THE MEMORY BANK ---
const ttMap = new Map();

function hashBoard(board) {
  let str = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = board[r][c];
      // Converts the board into a fast 64-character string ID
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

  const rootUrgentBlockCells = getUrgentBlockCells(board, other(turn));
  const rootMaxMoves = 25;
  const rootMoves =
    rootUrgentBlockCells.size > 0
      ? legalMoves.filter((move) =>
          rootUrgentBlockCells.has(`${move.row}:${move.col}`),
        )
      : legalMoves;
  const movesToScore =
    rootMoves.length > 0
      ? rootMoves.slice(0, Math.min(rootMaxMoves, rootMoves.length))
      : legalMoves.slice(0, Math.min(rootMaxMoves, legalMoves.length));

  for (const move of movesToScore) {
    const nextBoard = cloneBoard(board);
    simulateMove(nextBoard, move.row, move.col, turn);
    const nextPlayer = turn === 1 ? 2 : 1;
    const score = minimax(
      nextBoard,
      nextPlayer,
      1,
      -Infinity,
      Infinity,
      false,
      playerColor,
      searchMaxDepth,
    );

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

  // --- 4. THE SEARCH LOOP ---
  let originalAlpha = alpha;
  let bestScore;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of movesToExplore) {
      const newBoard = cloneBoard(board);
      const preMoveYugos = countYugosOnBoard(board, player); // Check how many Yugos exist

      simulateMove(newBoard, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(newBoard, player); // Check if we made a new one
      const nextPlayer = player === 1 ? 2 : 1;

      // THE HORIZON FIX: If we formed a Yugo, don't increase the depth counter!
      const nextDepth = postMoveYugos > preMoveYugos ? depth : depth + 1;

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
      maxEval = Math.max(maxEval, moveScore);
      alpha = Math.max(alpha, moveScore);
      if (beta <= alpha) break;
    }
    bestScore = maxEval;
  } else {
    let minEval = Infinity;
    for (const move of movesToExplore) {
      const newBoard = cloneBoard(board);
      const preMoveYugos = countYugosOnBoard(board, player);

      simulateMove(newBoard, move.row, move.col, player);

      const postMoveYugos = countYugosOnBoard(newBoard, player);
      const nextPlayer = player === 1 ? 2 : 1;

      // THE HORIZON FIX: Give the opponent the same courtesy extension
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
        if (tile && tile.yugo) {
          existingYugos.push({ r, c });
        }
      }
    }

    for (const key of tilesToRemove) {
      const [r, c] = key.split(":").map(Number);
      board[r][c] = null;
    }

    for (const { r, c } of existingYugos) {
      board[r][c] = { player, yugo: true };
    }

    board[row][col] = { player, yugo: true };
  }
}

function cloneBoard(board) {
  return board.map((row) => row.map((tile) => (tile ? { ...tile } : null)));
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
      else if (totalPlayerPieces === 3 && empties === 1) score += 6500;
      if (totalPlayerPieces === 2 && empties === 2) score += 1100;

      // --- OPPONENT'S DEFENSIVE SORTING ---
      const totalOpponentPieces = opponentYugos + opponentMigos;

      // 1. INSTANT BLOCKS (Highest Priority)
      if (opponentYugos === 3 && empties === 1) score += 49000;
      else if (totalOpponentPieces === 3 && empties === 1) score += 20000;

      // 2. YUGO PANIC (Catch Open 2 Yugos!)
      if (opponentYugos === 2 && empties === 2) score += 25000;
      if (opponentYugos === 2 && empties === 1) score += 15000;

      // 3. THE FIX: The Real Open 2 Block (Empties MUST be 2!)
      if (totalOpponentPieces === 2 && empties === 2) score += 8000;
      if (totalOpponentPieces === 2 && empties === 1) score += 5000;
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
        let oppMigos = 0;
        let oppYugos = 0;
        let empties = 0;
        let emptyCell = null;
        let invalid = false;

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
            if (tile.yugo) oppYugos += 1;
            else oppMigos += 1;
          } else {
            // Window contains the other side, so it is not an urgent block line.
            invalid = true;
            break;
          }
        }

        if (invalid || empties !== 1 || !emptyCell) continue;
        if (oppYugos + oppMigos === 3) {
          urgentCells.add(`${emptyCell[0]}:${emptyCell[1]}`);
        }
      }
    }
  }

  return urgentCells;
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

  // --- 2. STRING PATTERN SCANNING (The Brains) ---
  // We extract all lines into strings to detect Misdirections, Sandwiches, and Traps
  let allLines = extractAllLinesAsStrings(board, aiPlayer, humanPlayer);

  for (let lineStr of allLines) {
    totalScore += evaluateLineString(lineStr);
  }

  // --- 3. HEATMAP ---
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
  } else {
    // STANDARD MIGO THREATS
    if (lineStr.includes("01110")) score += 800; // Open 3
    if (lineStr.includes("01011") || lineStr.includes("11010")) score += 800; // Broken 3
    if (lineStr.includes("001100")) score += 250; // Open 2
  }

  // AI YUGO NETWORKS & SANDWICHES (Massively Buffed!)
  if (lineStr.includes("0333") || lineStr.includes("3330")) score += 100000;
  if (lineStr.includes("303")) score += 45000;
  if (lineStr.includes("3110") || lineStr.includes("0113")) score += 60000; // Anchor Extension (was 25k)
  if (lineStr.includes("3003")) score += 20000; // Yugo Sandwich Gap (was 5k)
  if (lineStr.includes("3103") || lineStr.includes("3013")) score += 90000; // Lethal Sandwich (was 35k)
  if (lineStr.includes("03030") || lineStr.includes("0330")) score += 40000; // Sniper Network (was 15k)

  // =====================================
  // OPPONENT PENALTIES (Defensive Blocks)
  // =====================================
  if (lineStr.includes("02220")) score -= 3000; // Opp Open 3
  if (lineStr.includes("02022") || lineStr.includes("22020")) score -= 3000; // Opp Broken 3
  if (lineStr.includes("002200")) score -= 900; // Opp Open 2

  // OPPONENT YUGO NETWORKS (Terrifying threats)
  if (lineStr.includes("0440")) score -= 40000;
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
    let count = 1; // The piece being placed counts as 1

    // Check positive direction
    for (let i = 1; i < 8; i++) {
      const nr = row + i * dr;
      const nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];

      // THE FIX: Stop counting if it is empty, opponent's, OR A YUGO!
      // The Overline restriction only applies to Migos.
      if (!tile || tile.player !== player || tile.yugo) break;
      count++;
    }

    // Check negative direction
    for (let i = 1; i < 8; i++) {
      const nr = row - i * dr;
      const nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];

      if (!tile || tile.player !== player || tile.yugo) break;
      count++;
    }

    if (count > 4) return true;
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
