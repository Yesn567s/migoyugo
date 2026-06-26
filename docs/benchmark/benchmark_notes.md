# Benchmark Notes

Benchmark ini adalah replikasi ringan untuk dokumentasi.

Untuk hasil final, tambahkan counter langsung di `ai_worker.js`:

```javascript
let totalNodes = 0;

function minimax(...) {
  totalNodes++;
  ...
}

self.postMessage({
  bestMove,
  bestScore,
  totalNodes,
  elapsedMs
});
```
