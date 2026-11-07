/* THE PLAN TABLE A CARD STATEMENT PRINTS. HNB's card statement lists its instalment charges as "Instalment Principle - 3/12" (no shop, no total) and, on a later page, "Your Instalment Purchases":
 * reference/shop, total months, total amount, remaining months, remaining amount. That table is what names the plan and gives its real total; without it a plan was filed as "Principle" with a total
 * guessed as twelve of this month's charge. Evidence only: a line is attached to a table row when ONE row's money (total / months) is this charge's amount, and the table row is internally consistent. */
const MONEY = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}', num = text => Number(String(text).replace(/,/g, ''));
const LINE = new RegExp(`^\\s*(\\d{5,})\\s*[/\\\\]\\s*(.+?)\\s+(\\d{1,2})\\s+(${MONEY})\\s+(\\d{1,2})\\s+(${MONEY})\\s*$`);

/** The plans a statement's text lists, each as { ref, name, months, total, remainingMonths, remainingAmount }; lines that do not add up are left out. */
export function readPlanTable(text) {
    const plans = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = LINE.exec(line);
        if (!m) continue;
        const months = Number(m[3]), total = num(m[4]), remainingMonths = Number(m[5]), remainingAmount = num(m[6]);
        const name = m[2].replace(/\s*\([A-Za-z]{0,4}\)?\s*$/, '').replace(/\s+/g, ' ').trim();     // the table cuts a long name off with "(LAN"
        if (name.length < 2 || months < 2 || !(total > 0) || remainingMonths > months || remainingAmount > total + 0.01) continue;
        if (Math.abs(remainingAmount - total * remainingMonths / months) > total * 0.01) continue;      // the months and the money must tell the same story
        plans.push({ ref: m[1], name: name.slice(0, 60), months, total, remainingMonths, remainingAmount });
    }
    return plans;
}

/** The ONE table row a charge of `amount` belongs to (its monthly money, to the cent), or null: two rows with the same monthly money cannot be told apart, so neither is guessed. */
export function planFor(table, amount, of = 0) {
    const hits = (table || []).filter(plan => Math.abs(plan.total / plan.months - Number(amount)) <= 0.02 && (!(of >= 2) || plan.months === of));
    return hits.length === 1 ? hits[0] : null;
}
