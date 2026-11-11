/* THE PLAN TABLE A CARD STATEMENT PRINTS. HNB's card statement lists its instalment charges as "Instalment Principle - 3/12" (no shop, no total) and, on a later page, "Your Instalment Purchases":
 * reference/shop, total months, total amount, remaining months, remaining amount. That table is what names the plan and gives its real total; without it a plan was filed as "Principle" with a total
 * guessed as twelve of this month's charge. Evidence only: a line is attached to a table row when ONE row's money (total / months) is this charge's amount, and the table row is internally consistent. */
const MONEY = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}', num = text => Number(String(text).replace(/,/g, ''));
const LINE = new RegExp(`^\\s*(\\d{5,})\\s*[/\\\\]\\s*(.+?)\\s+(\\d{1,2})\\s+(${MONEY})\\s+(\\d{1,2})\\s+(${MONEY})\\s*$`);

/* NATIONS TRUST BANK's "Your Installment Summary": merchant, original purchase amount, amount outstanding, REMAINING instalments as "23/24" (23 still to pay of 24) and the next instalment's amount.
 * "SINGER 24M NATIONS PAY  125,260.00  120,040.83  23/24  5,219.17". It is evidence only when its own figures agree: the instalment times the months is the original amount, and the
 * original amount less the instalments already paid is what is outstanding (to the cent, with a cent of rounding for each month). */
const NTB_LINE = new RegExp(`^\\s*([A-Za-z].*?)\\s+(${MONEY})\\s+(${MONEY})\\s+(\\d{1,2})\\s*/\\s*(\\d{1,2})\\s+(${MONEY})\\s*$`);
const NTB_BRAND = /\b\d{1,2}\s*m\b|\bnations\s*(?:easy\s*)?pay\b/gi;
function ntbPlan(line) {
    const m = NTB_LINE.exec(line);
    if (!m) return null;
    const total = num(m[2]), outstanding = num(m[3]), remainingMonths = Number(m[4]), months = Number(m[5]), monthly = num(m[6]);
    const name = m[1].replace(NTB_BRAND, ' ').replace(/[^A-Za-z0-9&' .-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').trim();
    if (name.length < 2 || months < 2 || remainingMonths < 0 || remainingMonths > months || !(total > 0) || !(monthly > 0) || outstanding > total + 0.01) return null;
    if (Math.abs(monthly * months - total) > months * 0.01 + 0.01) return null;                        // the instalment and the months must tell the original amount
    if (Math.abs(total - monthly * (months - remainingMonths) - outstanding) > (months - remainingMonths) * 0.01 + 0.02 && Math.abs(monthly * remainingMonths - outstanding) > remainingMonths * 0.01 + 0.02) return null;   // …and what is still owed
    return { ref: `ntb-${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${Math.round(total * 100)}`, name: name.slice(0, 60), months, total, remainingMonths, remainingAmount: outstanding, monthly };
}

/** The plans a statement's text lists, each as { ref, name, months, total, remainingMonths, remainingAmount }; lines that do not add up are left out. */
export function readPlanTable(text) {
    const plans = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const ntb = ntbPlan(line);
        if (ntb) { plans.push(ntb); continue; }
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
