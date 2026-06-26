# MIGOYUGO — Abstract Strategy Game with AI

![Migoyugo Hero](docs/images/hero.svg)

**Migoyugo** adalah game strategi abstrak berbasis web yang dimainkan di papan **8 × 8**. Pemain meletakkan bidak **Migo**, membentuk **Yugo**, lalu berusaha mencapai kondisi menang bernama **Igo**.

## Fitur Utama

- Papan **8 × 8** atau 64 kotak.
- Mode **Play Local**, **Play Against AI**, dan **How to Play**.
- Pemilihan warna pemain, nama pemain, dan **AI Processing Depth**.
- AI berjalan di background menggunakan **Web Worker**.
- AI memakai **Minimax**, **Alpha-Beta Pruning**, **Iterative Deepening**, **Zobrist Hashing**, dan **Transposition Table**.
- Fitur gameplay: **Undo**, **History**, **Resign**, skor Yugo, dan popup game over.
- Tampilan bertema cyberpunk dengan video background, grid overlay, dan efek neon.

## Preview

### Konsep Migo, Yugo, dan Igo

![Game Rules](docs/images/game-rules.svg)

### Arsitektur AI

![AI Architecture](docs/images/ai-architecture.svg)

### Zobrist Hashing

![Zobrist Hashing](docs/images/zobrist-hashing.svg)

## Teknologi

| Teknologi           | Fungsi                                               |
| ------------------- | ---------------------------------------------------- |
| HTML                | Struktur halaman menu, game, dan aturan              |
| CSS                 | Tampilan, layout, animasi, dan responsive design     |
| JavaScript          | Logika permainan, validasi langkah, dan render papan |
| Web Worker          | Menjalankan AI di background                         |
| Minimax             | Simulasi kemungkinan langkah                         |
| Alpha-Beta Pruning  | Mengurangi cabang pencarian yang tidak perlu         |
| Zobrist Hashing     | Membuat identitas unik untuk setiap kondisi papan    |
| Transposition Table | Menyimpan hasil evaluasi posisi                      |

## Struktur Project

```text
migoyugo/
├── index.html
├── rule.html
├── ai_game.html
├── ai_worker.js
├── ai_game.css
├── migoyugo.html
├── 3d_ai_game.html
├── assets/
│   ├── video/
│   │   └── smoke.mp4
│   └── sfx/
│       ├── white.mp3
│       ├── black.mp3
│       ├── form.mp3
│       └── Monkeys-Spinning-Monkeys(chosic.com).mp3
└── docs/
    ├── images/
    └── benchmark/
```

## Cara Menjalankan

Gunakan local server agar **Web Worker**, audio, video, dan asset dapat dipanggil dengan benar.

```bash
python -m http.server 8000
```

Lalu buka:

```text
http://localhost:8000
```

## Aturan Permainan

### Migo

```javascript
state.board[row][col] = { player: p, yugo: false };
```

Migo adalah bidak biasa yang baru diletakkan.

### Yugo

```javascript
state.board[anchor.row][anchor.col] = { player: p, yugo: true };
```

Yugo terbentuk ketika pemain membuat garis tepat 4 bidak miliknya sendiri.

### Igo

Igo adalah kondisi menang langsung ketika pemain memiliki 4 Yugo dalam satu garis horizontal, vertikal, atau diagonal.

### Wego

Wego terjadi ketika papan penuh atau tidak ada langkah legal. Pemain dengan jumlah Yugo terbanyak menang.

### Larangan Garis Panjang

```javascript
if (count > 4) return true;
```

Pemain tidak boleh membuat garis lebih dari 4 bidak dalam satu garis.

## Alur Aplikasi

```text
index.html
   ↓
pilih mode AI
   ↓
ai_game.html
   ↓
pemain memilih warna, nama, dan depth
   ↓
game membuat papan 8 × 8
   ↓
pemain bergerak
   ↓
jika giliran AI, board dikirim ke ai_worker.js
   ↓
AI menghitung bestMove
   ↓
game meletakkan bidak AI
```

## Kode Penting

### Membuat AI Worker

```javascript
const aiWorker = new Worker("ai_worker.js");
```

### Mengirim Data ke AI

```javascript
aiWorker.postMessage({
  board: state.board,
  playerColor: playerColor,
  turn: state.turn,
  maxDepth: aiMaxDepth,
});
```

### Menerima Langkah AI

```javascript
aiWorker.onmessage = (e) => {
  const { bestMove } = e.data;
  if (bestMove) placeTile(bestMove.row, bestMove.col);
};
```

## Benchmark Performa

Laporan lengkap tersedia di [`REPORT.md`](REPORT.md).

![Benchmark Nodes](docs/images/benchmark-nodes.svg)

![Benchmark Time](docs/images/benchmark-time.svg)

![Benchmark Reduction](docs/images/benchmark-reduction.svg)

## Catatan Benchmark

Benchmark ini adalah **benchmark replikasi logika pencarian** dengan `candidate_limit = 6` agar minimax murni tetap dapat dihitung. Untuk angka final, lakukan instrumentasi langsung pada `ai_worker.js` di browser target.
