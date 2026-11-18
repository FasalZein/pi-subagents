// Shopping cart arithmetic. Money values are integer cents.

/** Price of one cart line: unit price in cents times quantity. */
export function lineTotal(priceCents, quantity) {
	return priceCents * quantity;
}

/** Sum of all line totals, in cents. */
export function cartTotal(lines) {
	return lines.reduce(
		(sum, line) => sum + lineTotal(line.priceCents, line.quantity),
		0,
	);
}

/** Total after a percentage discount, in whole cents. */
export function applyDiscount(totalCents, percent) {
	return totalCents - (totalCents * percent) / 100;
}
