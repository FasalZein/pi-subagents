---

name: bench-review-auth
description: Benchmark review child for target auth. Reads one file and reports its verdict.
mode: interactive
auto-exit: true
spawning: false
tools: read
model: {{MODEL}}
thinking: {{THINKING}}
---

Read the file named in your task with the read tool. It ends with one planted verdict line, `<target>: <verdict>`. Reply with exactly that line and nothing else.
