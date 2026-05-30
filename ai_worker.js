// AI Worker - Runs minimax in background thread
const size = 8;
const MAX_DEPTH = 4;

self.onmessage = function (e) {
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
  const rootMaxMoves = searchMaxDepth <= 1 ? 10 : searchMaxDepth === 2 ? 8 : 6;
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

  // Terminal states
  if (checkIgoOnBoard(board, aiPlayer)) {
    return 10000 - depth; // AI wins
  }
  if (checkIgoOnBoard(board, playerColor)) {
    return -10000 + depth; // Player wins
  }

  if (isBoardFullOnBoard(board)) {
    return evaluate(board, aiPlayer);
  }

  if (!hasLegalMovesOnBoard(board, player)) {
    return evaluate(board, aiPlayer);
  }

  // Depth limit
  if (depth >= maxDepth) {
    return evaluate(board, aiPlayer);
  }

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

  const maxMoves = depth <= 1 ? 10 : depth === 2 ? 8 : 6;
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

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of movesToExplore) {
      const newBoard = cloneBoard(board);
      simulateMove(newBoard, move.row, move.col, player);
      const nextPlayer = player === 1 ? 2 : 1;
      const moveScore = minimax(
        newBoard,
        nextPlayer,
        depth + 1,
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
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of movesToExplore) {
      const newBoard = cloneBoard(board);
      simulateMove(newBoard, move.row, move.col, player);
      const nextPlayer = player === 1 ? 2 : 1;
      const moveScore = minimax(
        newBoard,
        nextPlayer,
        depth + 1,
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
    return minEval;
  }
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

      if (playerYugos === 3 && empties === 1) score += 6500;
      if (playerMigos === 3 && empties === 1) score += 3200;
      if (playerMigos === 2 && empties === 2) score += 1100;

      if (opponentYugos === 3 && empties === 1) score += 9000;
      if (opponentMigos === 3 && empties === 1) score += 7000;
      if (opponentMigos === 2 && empties === 2) score += 1800;
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
        if (oppYugos === 3 || oppMigos === 3) {
          urgentCells.add(`${emptyCell[0]}:${emptyCell[1]}`);
        }
      }
    }
  }

  return urgentCells;
}

function evaluate(board, player) {
  const opponent = other(player);
  const stats = collectHeuristicStats(board);

  const playerPrefix = player === 1 ? "p1" : "p2";
  const opponentPrefix = opponent === 1 ? "p1" : "p2";

  let score = 0;

  // --- 1. TERMINAL STATES (Must be untouchably high) ---
  score += 1000000 * stats[`${playerPrefix}Igos`];
  score -= 1000000 * stats[`${opponentPrefix}Igos`];

  // --- 2. YUGO THREATS (Paths to instant win) ---
  score += 50000 * stats[`${playerPrefix}YugoOpen3s`];
  score += 10000 * stats[`${playerPrefix}YugoOpen2s`];
  score -= 90000 * stats[`${opponentPrefix}YugoOpen3s`];
  score -= 18000 * stats[`${opponentPrefix}YugoOpen2s`];

  // --- 3. MIGO THREATS (Paths to making a Yugo) ---
  score += 2000 * stats[`${playerPrefix}MigoDoubleThreats`];
  score += 800 * stats[`${playerPrefix}MigoOpen3s`];
  score += 250 * stats[`${playerPrefix}MigoOpen2s`];
  score -= 8000 * stats[`${opponentPrefix}MigoDoubleThreats`];
  score -= 25000 * stats[`${opponentPrefix}MigoOpen3s`];
  score -= 5000 * stats[`${opponentPrefix}MigoOpen2s`];

  // --- 4. YUGO POSITION & COUNT ---
  score += 1500 * stats[`${playerPrefix}CenterYugos`];
  score += 400 * stats[`${playerPrefix}EdgeYugos`];
  score -= 1600 * stats[`${opponentPrefix}CenterYugos`];
  score -= 450 * stats[`${opponentPrefix}EdgeYugos`];

  // --- 5. DYNAMIC BOARD CONTROL ---
  score += 500 * stats[`${playerPrefix}MigoSynergy`];
  score += 150 * stats[`${playerPrefix}MigoCenterControl`];
  score += 100 * stats[`${playerPrefix}MigoConnectivity`];
  score -= 200 * stats[`${playerPrefix}DeadLines`];

  return score;
}

function collectHeuristicStats(board) {
  const stats = {
    p1Igos: 0,
    p2Igos: 0,
    p1YugoOpen3s: 0,
    p2YugoOpen3s: 0,
    p1YugoOpen2s: 0,
    p2YugoOpen2s: 0,
    p1MigoDoubleThreats: 0,
    p2MigoDoubleThreats: 0,
    p1MigoOpen3s: 0,
    p2MigoOpen3s: 0,
    p1MigoOpen2s: 0,
    p2MigoOpen2s: 0,
    p1CenterYugos: 0,
    p2CenterYugos: 0,
    p1EdgeYugos: 0,
    p2EdgeYugos: 0,
    p1MigoSynergy: 0,
    p2MigoSynergy: 0,
    p1MigoCenterControl: 0,
    p2MigoCenterControl: 0,
    p1MigoConnectivity: 0,
    p2MigoConnectivity: 0,
    p1DeadLines: 0,
    p2DeadLines: 0,
  };

  const player1AllMigos = new Set();
  const player2AllMigos = new Set();
  const player1ActiveMigos = new Set();
  const player2ActiveMigos = new Set();

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const tile = board[row][col];
      if (!tile) continue;

      const key = `${row}:${col}`;
      const isCenter = row >= 2 && row <= 5 && col >= 2 && col <= 5;
      const isEdge =
        row === 0 || row === size - 1 || col === 0 || col === size - 1;

      if (tile.player === 1) {
        if (tile.yugo) {
          if (isCenter) stats.p1CenterYugos += 1;
          if (isEdge) stats.p1EdgeYugos += 1;
        } else {
          player1AllMigos.add(key);
          if (isCenter) stats.p1MigoCenterControl += 1;
        }
      } else {
        if (tile.yugo) {
          if (isCenter) stats.p2CenterYugos += 1;
          if (isEdge) stats.p2EdgeYugos += 1;
        } else {
          player2AllMigos.add(key);
          if (isCenter) stats.p2MigoCenterControl += 1;
        }
      }
    }
  }

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
        let p1Migos = 0;
        let p1Yugos = 0;
        let p2Migos = 0;
        let p2Yugos = 0;
        let empties = 0;
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

          cells.push([nextRow, nextCol]);
          const tile = board[nextRow][nextCol];
          if (!tile) {
            empties += 1;
          } else if (tile.player === 1) {
            if (tile.yugo) p1Yugos += 1;
            else p1Migos += 1;
          } else if (tile.player === 2) {
            if (tile.yugo) p2Yugos += 1;
            else p2Migos += 1;
          }
        }

        if (invalid) continue;

        if (p1Yugos === 4) stats.p1Igos += 1;
        if (p2Yugos === 4) stats.p2Igos += 1;

        if (p1Yugos === 3 && empties === 1 && p2Migos + p2Yugos === 0) {
          stats.p1YugoOpen3s += 1;
        }
        if (p2Yugos === 3 && empties === 1 && p1Migos + p1Yugos === 0) {
          stats.p2YugoOpen3s += 1;
        }
        if (p1Yugos === 2 && empties === 2 && p2Migos + p2Yugos === 0) {
          stats.p1YugoOpen2s += 1;
        }
        if (p2Yugos === 2 && empties === 2 && p1Migos + p1Yugos === 0) {
          stats.p2YugoOpen2s += 1;
        }

        if (p1Migos === 3 && empties === 1 && p2Migos + p2Yugos === 0) {
          stats.p1MigoOpen3s += 1;
          cells.forEach(([nextRow, nextCol]) => {
            const tile = board[nextRow][nextCol];
            if (tile && tile.player === 1 && !tile.yugo) {
              player1ActiveMigos.add(`${nextRow}:${nextCol}`);
            }
          });
        }
        if (p2Migos === 3 && empties === 1 && p1Migos + p1Yugos === 0) {
          stats.p2MigoOpen3s += 1;
          cells.forEach(([nextRow, nextCol]) => {
            const tile = board[nextRow][nextCol];
            if (tile && tile.player === 2 && !tile.yugo) {
              player2ActiveMigos.add(`${nextRow}:${nextCol}`);
            }
          });
        }

        if (p1Migos === 2 && empties === 2 && p2Migos + p2Yugos === 0) {
          stats.p1MigoOpen2s += 1;
          cells.forEach(([nextRow, nextCol]) => {
            const tile = board[nextRow][nextCol];
            if (tile && tile.player === 1 && !tile.yugo) {
              player1ActiveMigos.add(`${nextRow}:${nextCol}`);
            }
          });
        }
        if (p2Migos === 2 && empties === 2 && p1Migos + p1Yugos === 0) {
          stats.p2MigoOpen2s += 1;
          cells.forEach(([nextRow, nextCol]) => {
            const tile = board[nextRow][nextCol];
            if (tile && tile.player === 2 && !tile.yugo) {
              player2ActiveMigos.add(`${nextRow}:${nextCol}`);
            }
          });
        }

        const player1Pieces = p1Migos + p1Yugos;
        const player2Pieces = p2Migos + p2Yugos;

        if (p2Migos + p2Yugos > 0 && p1Migos + p1Yugos > 0) {
          cells.forEach(([nextRow, nextCol]) => {
            const tile = board[nextRow][nextCol];
            if (tile && tile.player === 1 && !tile.yugo) {
              stats.p1DeadLines += 1;
            }
            if (tile && tile.player === 2 && !tile.yugo) {
              stats.p2DeadLines += 1;
            }
          });
        } else {
          if (player1Pieces >= 2 && player2Pieces === 0 && empties >= 1) {
            cells.forEach(([nextRow, nextCol]) => {
              const tile = board[nextRow][nextCol];
              if (tile && tile.player === 1 && !tile.yugo) {
                player1ActiveMigos.add(`${nextRow}:${nextCol}`);
              }
            });
          }
          if (player2Pieces >= 2 && player1Pieces === 0 && empties >= 1) {
            cells.forEach(([nextRow, nextCol]) => {
              const tile = board[nextRow][nextCol];
              if (tile && tile.player === 2 && !tile.yugo) {
                player2ActiveMigos.add(`${nextRow}:${nextCol}`);
              }
            });
          }

          if (player1Pieces > 0 && player2Pieces === 0) {
            if (player1Pieces >= 2 && empties >= 1) stats.p1MigoSynergy += 1;
          } else if (player2Pieces > 0 && player1Pieces === 0) {
            if (player2Pieces >= 2 && empties >= 1) stats.p2MigoSynergy += 1;
          }
        }
      }
    }
  }

  stats.p1DeadLines += Math.max(
    0,
    player1AllMigos.size - player1ActiveMigos.size,
  );
  stats.p2DeadLines += Math.max(
    0,
    player2AllMigos.size - player2ActiveMigos.size,
  );

  stats.p1MigoConnectivity = countMigoConnectivity(board, 1);
  stats.p2MigoConnectivity = countMigoConnectivity(board, 2);

  return stats;
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
    for (let i = 1; i < 8; i++) {
      const nr = row + i * dr;
      const nc = col + i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
      count++;
    }
    for (let i = 1; i < 8; i++) {
      const nr = row - i * dr;
      const nc = col - i * dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const tile = board[nr][nc];
      if (!tile || tile.player !== player) break;
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
