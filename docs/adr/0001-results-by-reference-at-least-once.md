---
status: accepted
---

# A result reaches the parent by reference, at least once

In v2.9.2 a finished child handed its result to two consumers on one promise, a message router and a wait, and three flags decided which one delivered. Scratch tests reproduced a result that arrived twice in full, a result that nobody delivered, and a result that waited until the person typed. The child's full final text entered the parent context with no size limit.

We decided that every run that ends while its parent process watches it ends in one result record, built by one assembler. The parent context gets a summary of at most 1,500 characters and the path of a report file that holds the full text. One module owns delivery: it hands each result over by itself, to a wait or in a message, and never parks it. Delivery is at least once. The extension does not prove that the model read a result. A result that the parent did not see is fetched again by run id or found in a list of recent runs, and every copy has the same size limit, so a duplicate is cheap.

Changed on 2026-11-18 by the owner, after two plan reviews. The first version proved receipt: a result counted as received only when a later model request held it, a failed workflow script gave its results back once, and received results shrank to stubs under context pressure. Both reviews found that Pi offers no reliable point to observe receipt. A later handler can change a request, compaction and context edits can remove the entry that carries a result, and a competing wait can claim a give-back twice. The proof cost more than the duplicates it prevented.

Changed on 2026-11-24 by the owner: the wait tool (subagent_wait) is removed, as upstream removed it. A result now goes to the launch or resume call that waits for it, or else in a message; nothing else takes it. A result that the parent did not see is found by the report path that each result message and fold stub names, or in record.json of its run folder, not by a lookup tool.

## Considered options

- Cap the text in each of the three existing assemblers. Rejected: it keeps two consumers and the reproduced defects.
- Deliver only a file path. Rejected: the parent would read the file for almost every result, and this extension cannot bound those reads.
- Inline the whole text when it is short and a preview otherwise. Rejected by the owner: the bound per result must not depend on what a child writes.
- Exactly once, with observed receipt and a give-back after a failed script. Rejected after the second review, for the reasons above.

## Consequences

- A parent that needs detail reads the report file, as a visible choice.
- After a workflow script fails, nothing comes back by itself; the parent recovers the results by lookup.
- Removing delivered results from the parent context waits until Pi offers a final read-only dispatch hook, or until measurements show that capped summaries still dominate parent input.
- Verified fan-out keeps its v2.9.2 lease, receipt and adoption; only its text is capped. Its adoption can deliver a winner again, within the cap.
- A child that outlives its parent gets no result record. The one exception is a verified fan-out winner, which the origin or an authorized ancestor can adopt after the origin exits.
