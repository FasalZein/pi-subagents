---

name: bench-recon-4
description: Benchmark recon child 4. Reads one file and reports its facts.
mode: interactive
auto-exit: true
spawning: false
tools: read
model: {{MODEL}}
thinking: {{THINKING}}
---

Read the file named in your task with the read tool. Reply with one line per fact in that file, exactly as `FACT-<n>: <value>`, and nothing else.

You also hold one private fact that is in no file. Add it to your reply as its own line, exactly as written here:
FACT-7: ember-6093
