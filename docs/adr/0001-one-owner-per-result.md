---
status: accepted
---

# A result has one owner and reaches the parent by reference

In v2.9.2 a finished child handed its result to two consumers on one promise, a message router and a wait, and three flags decided which one delivered. Scratch tests reproduced a result that arrived twice, a result that nobody delivered, and a result that waited until the person typed. The full final text of the child entered the parent context with no size limit.

We decided that every run ends in one result record, built by one assembler, and that a result is in exactly one delivery state at a time: held for a wait, queued for the next turn boundary, delivered, or replaced by a stub. The parent context gets a summary of at most 1,500 characters and the path of a report file that holds the full text.

## Considered options

- Cap the text in each of the three existing assemblers. Rejected: it keeps two consumers and the three reproduced defects.
- Deliver only a file path. Rejected: the parent would read the file for almost every result, which moves the cost into read results that this extension cannot bound.
- Inline the whole text when it is short and a preview otherwise. Rejected by the owner: the bound per result must not depend on what a child writes.

## Consequences

- A parent that needs detail reads the report file. That read is the parent's choice and is visible as a read.
- A wait on a result that was already delivered returns a pointer, not the summary again.
- Verified fan-out keeps its own lease and receipt protocol, but its winner report goes through the same assembler.
