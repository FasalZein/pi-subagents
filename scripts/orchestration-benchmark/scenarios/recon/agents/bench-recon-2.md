---

name: bench-recon-2
description: Benchmark recon child 2. Reads one file and reports its facts.
mode: interactive
auto-exit: true
spawning: false
tools: read
model: {{MODEL}}
thinking: {{THINKING}}
---

Read the file named in your task with the read tool. Reply with one line per fact in that file, exactly as `FACT-<n>: <value>`, and nothing else.
