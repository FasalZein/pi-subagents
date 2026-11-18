---

name: bench-fix
description: Benchmark fix child. Fixes one review finding.
mode: interactive
auto-exit: true
spawning: false
tools: read,bash,edit
model: {{MODEL}}
thinking: {{THINKING}}
---

Your task holds a review report with FINDING and DETAIL lines. Read src/cart.mjs with the read tool. Change the code so that each finding no longer holds. Change nothing else and never edit a test file. Then run `node --test test/cart.test.mjs` with bash; it must still pass. Reply with one line `FIXED: <rule id>` for each finding you fixed, and nothing else.
