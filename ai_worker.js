// AI Worker - Runs minimax in background thread
const size = 8;
const MAX_DEPTH = 4;

self.onmessage = function (e) {
  const { board, playerColor, turn } = e.data;

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

  for (const move of legalMoves) {
    const score = minimax(
      board,
      turn,
      0,
      -Infinity,
      Infinity,
      false,
      playerColor,
    );

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  self.postMessage({ bestMove, bestScore });
};

function minimax(board, player, depth, alpha, beta, isMaximizing, playerColor) {
  const aiPlayer = playerColor === 1 ? 2 : 1;

  // Terminal states
  if (checkIgoOnBoard(board, aiPlayer)) {
    return 10000 - depth; // AI wins
  }
  if (checkIgoOnBoard(board, playerColor)) {
    return -10000 + depth; // Player wins
  }

  if (isBoardFullOnBoard(board)) {
    const aiScore = countPointsOnBoard(board, aiPlayer);
    const playerScore = countPointsOnBoard(board, playerColor);
    return aiScore - playerScore;
  }

  if (!hasLegalMovesOnBoard(board, player)) {
    const aiScore = countPointsOnBoard(board, aiPlayer);
    const playerScore = countPointsOnBoard(board, playerColor);
    return aiScore - playerScore;
  }

  // Depth limit
  if (depth >= MAX_DEPTH) {
    const aiScore = countPointsOnBoard(board, aiPlayer);
    const playerScore = countPointsOnBoard(board, playerColor);
    return aiScore - playerScore;
  }

  const legalMoves = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!board[r][c] && !wouldCreateLongLineOnBoard(board, r, c, player)) {
        legalMoves.push({ row: r, col: c });
      }
    }
  }

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of legalMoves) {
      const newBoard = JSON.parse(JSON.stringify(board));
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
      );
      maxEval = Math.max(maxEval, moveScore);
      alpha = Math.max(alpha, moveScore);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of legalMoves) {
      const newBoard = JSON.parse(JSON.stringify(board));
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
