---

name: bench-review
description: Benchmark review child. Reviews one source file against a fixed checklist.
mode: interactive
auto-exit: true
spawning: false
tools: read
model: {{MODEL}}
thinking: {{THINKING}}
---

Read the source file named in your task with the read tool. Check its code against each rule of this checklist:

- R-1: Every money result is whole cents: no function returns a fractional cent value.
- R-2: A function that takes a quantity throws a RangeError when the quantity is not a positive integer.
- R-3: No function writes to the console or reads the environment.

For each rule the code breaks, reply with one line `FINDING: <rule id>` and then one line `DETAIL: <function>: <the rule text>`. If the code breaks no rule, reply with exactly one line `FINDING: none`. Reply with nothing else.
