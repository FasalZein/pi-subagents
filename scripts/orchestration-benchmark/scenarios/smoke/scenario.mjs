// Smoke scenario: one child reads a planted code word. It tests the launcher only.
export default {
	name: "smoke",
	prompt:
		'Call the subagent tool once with name "smoke-reader", agent "bench-smoke-reader" and task "Read smoke-note.txt and report the code word.". Do not read any file yourself. When the child\'s result arrives, reply with exactly one line: ANSWER: <code word>',
	expectedAnswer: "lantern-4127",
	// The answer must come through exactly these children, in this order.
	expectedChildRoles: ["bench-smoke-reader"],
	// What each child role must do: read these fixture files and return this result,
	// which must reach the parent before its answer.
	childResults: {
		"bench-smoke-reader": {
			returns: "lantern-4127",
			reads: ["smoke-note.txt"],
		},
	},
	// The parent may call only these tools; a direct read is wrong delegation.
	parentToolAllowlist: ["subagent"],
	// Tools whose source file proves that the extension loaded from the checkout.
	parentLoadTool: "subagent",
	// The child has auto-exit: pi-subagents then registers caller_ping, not subagent_done.
	childLoadTool: "caller_ping",
};
