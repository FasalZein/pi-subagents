import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount, cartTotal, lineTotal } from "../src/cart.mjs";

test("lineTotal multiplies the unit price by the quantity", () => {
	assert.equal(lineTotal(250, 3), 750);
});

test("cartTotal sums the line totals", () => {
	assert.equal(
		cartTotal([
			{ priceCents: 250, quantity: 2 },
			{ priceCents: 99, quantity: 1 },
		]),
		599,
	);
});

test("applyDiscount returns whole cents", () => {
	assert.equal(applyDiscount(1000, 10), 900);
	assert.equal(applyDiscount(999, 15), 849);
});
