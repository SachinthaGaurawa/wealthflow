// Invented, structure-faithful stand-ins for the data an emailed Smart Statement
// carries INSIDE itself (the real files were opened to learn the shape; every
// figure here is made up). Amounts are handled in whole cents so a generated
// ledger is exact by construction.
const money = c => (c / 100).toFixed(2).replace(/\.00$/, '');
const dmy = iso => `${iso.slice(8)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = iso => `${iso.slice(8)}-${MON[Number(iso.slice(5, 7)) - 1]}`;
const q = s => JSON.stringify(String(s));

/** account: { kind: 'savings'|'current', number, currency?, opening (cents), rows: [{ date:'2026-01-02', details, ref, debit, credit }] (cents) } */
export function ntbAccountScript(account, varName) {
    const kind = account.kind || 'savings';
    let balance = account.opening, runDebit = 0, runCredit = 0, totalDebit = 0, totalCredit = 0;
    const pushes = account.rows.map(r => {
        const debit = r.debit || 0, credit = r.credit || 0;
        balance += credit - debit; runDebit += debit; runCredit += credit; totalDebit += debit; totalCredit += credit;
        const b = r.balance !== undefined ? r.balance : balance;
        const shown = kind === 'savings'
            ? `${kind}TransactionDate: ${q(short(r.date))}, ${kind}TransactionValueDate: ${q(short(r.date))}, ${kind}TransactionDetails: ${q(r.details)}, ${kind}TransactionRefNo: ${q(' ' + (r.ref || ''))}, ${kind}TransactionChqNo: "", `
            : `${kind}TransactionDate: ${q(short(r.date))}, ${kind}TransactionValueDate: ${q(short(r.date))}, ${kind}TransactionDetails: ${q(r.details)}, ${kind}TransactionRefNo: ${q(' ' + (r.ref || ''))}, ${kind}TransactionChqNo: "", `;
        return `${varName}.push({ transactionDateFull: ${q(dmy(r.date))}, ${shown}transactionDebit: ${q(money(debit))}, transactionCredit: ${q(money(credit))}, runningDebitTotal: ${q(money(r.runDebit ?? runDebit))}, runningCreditTotal: ${q(money(r.runCredit ?? runCredit))}, runningTotal: ${q(money(b))}, ${kind}TransactionBalance: 0 });`;
    });
    const closing = account.closing !== undefined ? account.closing : balance;
    const meta = kind === 'savings'
        ? `savingsAccountNo: ${q(account.number)}, savingsAccountType: "Savings - MaxBonus", savingsCurrency: ${q(account.currency || 'LKR')}, savingsDeposit: ${q(money(account.deposits ?? totalCredit))}, savingsWithdrawal: ${q(money(account.withdrawals ?? totalDebit))}, savingsBalance: ${q(money(closing))}, savingsBfBalance: ${q(money(account.opening))}, savingsAvilableToWithdraw: "0", savingsAccountStatus: "Active", savingsJointAccountHolders: ""`
        : `currentAccountNo: ${q(account.number)}, currentCurrency: ${q(account.currency || 'LKR')}, currentCredit: ${q(money(account.deposits ?? totalCredit))}, currentDebit: ${q(money(account.withdrawals ?? totalDebit))}, currentBalance: ${q(money(closing))}, bfBalance: ${q(money(account.opening))}, currentODLimit: "0", currentAvailableToWithdraw: "0", currentOpenDate: "01-01-2020", currentJointAccountHolders: ""`;
    return `var ${varName} = [];\n${pushes.join('\ntotalCreditsForAllAccounts += 0\n')}\n${kind}DataList.push({ ${meta}, transactionData: ${varName} });\n`;
}

export function ntbDoc({ accounts, period = '01-01-2026 to 31-01-2026', overview = true, extra = '' }) {
    const savings = accounts.filter(a => (a.kind || 'savings') === 'savings'), current = accounts.filter(a => a.kind === 'current');
    const close = a => (a.closing !== undefined ? a.closing : a.opening + a.rows.reduce((s, r) => s + (r.credit || 0) - (r.debit || 0), 0));
    const sum = list => list.reduce((s, a) => s + close(a), 0);
    const script = `//Header\nvar statementPeriod = "${period}"\nvar savingsAmount = "${overview ? money(sum(savings)) : '0'}"; var currentAmount = "${overview ? money(sum(current)) : '0'}"; var fixedDepositAmount = "0"; var investmentAmount = "0"; var loansAmount = "0"; var leasingAmount = "0";\n`
        + 'var savingsDataList = []; var currentDataList = []; var leasingDataList = []; var loanDataList = []; var investmentDataList = [];\n'
        + savings.map((a, i) => ntbAccountScript({ ...a, kind: 'savings' }, `stData${i ? i : ''}`)).join('')
        + current.map((a, i) => ntbAccountScript({ ...a, kind: 'current' }, `ctData${i ? i : ''}`)).join('')
        + extra
        + '\nfunction loadSavingsTable(index){ let object = savingsDataList[index]; document.getElementById("x").innerHTML = object.savingsAccountNo; }\n';
    return `<html><body><div id="x"></div><script>var customer_cif_no = "1";</script><script>${script}</script><script>var pdfContent = "JVBERi0x";</script></body></html>`;
}

/** card: { cardNo, txs: [{ post:'13 JUL', tx?, description, ccy?, amount (cents), converted? (cents), dir:'Dr'|'Cr' }] } */
export function amexDoc({ cards, cycle = { year: 2026, monthValue: 8, dayOfMonth: 10 }, opening, closing, payment, credits, period = '11-Jul-2026 to 10-Aug-2026', extraSummary = {}, pdf = null }) {
    const all = cards.flatMap(c => c.txs);
    const cr = all.filter(t => t.dir === 'Cr').reduce((s, t) => s + (t.converted ?? t.amount), 0);
    const dr = all.filter(t => t.dir === 'Dr').reduce((s, t) => s + (t.converted ?? t.amount), 0);
    const close = closing !== undefined ? closing : opening - cr + dr;
    const summary = { id: 1, cardId: 2, batchId: 3, cycleDate: { ...cycle, month: 'AUGUST', chronology: { id: 'ISO' } }, openingBalance: opening / 100, purchases: dr / 100, cashAdvances: 0, interest: 0, charges: 0,
        payment: (payment ?? cr) / 100, credits: (credits ?? 0) / 100, closingBalance: close / 100, ...extraSummary };
    const list = cards.map(c => ({ cardNo: c.cardNo, primaryCardStatus: 'true', consumerTransactions: c.txs.map((t, i) => ({ txId: 1000 + i, postDate: t.post, txDate: t.tx || t.post, description: t.description,
        txCurrency: t.ccy || 'LKR', txAmount: t.amount / 100, txConvertedAmount: (t.converted ?? t.amount) / 100, crDr: t.dir, generatedDate: null })) }));
    const script = `// <![CDATA[\nvar statementPeriod = "${period}";\nvar cardTransactionsSummaryData = ${JSON.stringify(summary)}; var cardTransactionsDataList = ${JSON.stringify(list)};\n// ]]>`;
    return `<html><body><script>${script}</script><script>let pdfContent = "${pdf ? pdf.toString('base64') : 'JVBERi0x'}";</script></body></html>`;
}

/** A one-page text PDF, for the PDF a bank packs into its statement. */
export function textPdf(texts) {
    const stream = `BT /F1 12 Tf 50 750 Td ${texts.map((t, i) => `${i ? '0 -20 Td ' : ''}(${t.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
    let out = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const start = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
}

export const savingsRows = [
    { date: '2026-01-02', details: 'POS Transaction - SHOP ONE', ref: 'S1001', debit: 559900 },
    { date: '2026-01-03', details: 'CEFTS/6719/FT/NSB/SOME NAME/100175', ref: 'S1002', debit: 300000 },
    { date: '2026-01-06', details: 'Cash Deposit - BRANCH', ref: 'S1003', credit: 5000000 },
    { date: '2026-01-31', details: '200550088057:WTax.Pd:01-01-2026to 31-01-2026', ref: 'S1004', debit: 0 },
    { date: '2026-02-01', details: '200550088057:Int.Pd:01-01-2026 to 31-01-2026', ref: 'S1005', credit: 690 },
];
