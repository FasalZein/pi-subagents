---
status: accepted
---

# A result has one owner and reaches the parent by reference

In v2.9.2 a finished child handed its result to two consumers on one promise, a message router and a wait, and three flags decided which one delivered. Scratch tests reproduced a result that arrived twice, a result that nobody delivered, and a result that waited until the person typed. The full final text of the child entered the parent context with no size limit.

We decided that every run that ends while its parent process watches it ends in one result record, built by one assembler. A result is identified by its run id and its generation, and it is in exactly one state at a time: held for a wait, queued for the next turn boundary, delivered, received, or replaced by a stub. The parent context gets a summary of at most 1,500 characters and the path of a report file that holds the full text.

Amended 2026-11-18 after the plan review. Delivery is not receipt. A result counts as received only when a later model request of the parent contains it, or contains the result of the workflow script that waited for it and that script did not fail. When the script fails or is aborted after its wait returned, its results go out once as a message. After Esc, such a message waits in the session for the next prompt and does not start a turn.

## Considered options

- Cap the text in each of the three existing assemblers. Rejected: it keeps two consumers and the three reproduced defects.
- Deliver only a file path. Rejected: the parent would read the file for almost every result, which moves the cost into read results that this extension cannot bound.
- Inline the whole text when it is short and a preview otherwise. Rejected by the owner: the bound per result must not depend on what a child writes.
- Receipt at handoff (a wait returned it, or its message was committed). Rejected: a script that throws after its wait loses the results without notice, and a verified fan-out winner returned into a script never gets a receipt, so adoption delivers it again.
- Results for children that end after the parent process exited, written by a daemon or adopted by a resumed parent. Rejected for now: no agent definition of the owner uses parent-close-policy: continue, and the child's own session file and exit record stay for a resume by hand.

## Consequences

- A parent that needs detail reads the report file. That read is the parent's choice and is visible as a read.
- A wait on a result that was already delivered returns its record without the summary: outcome, typed, data and report file.
- The record and the report are written once per run id and generation, the report first. A verified fan-out retry adds a generation instead of overwriting.
- Verified fan-out keeps its own lease and authorization protocol, but its winner report goes through the same assembler, and its receipt is written at the receipt point, not by searching the parent session file.
- The extension follows each nested wait to the codemode call that made it, through the parent call id that Pi puts on nested calls.
- A child that outlives its parent gets no result record from the extension.
