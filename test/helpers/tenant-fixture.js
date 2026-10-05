// Shared by the tenant-portal tests: an in-memory Firestore with SERIALISED transactions (which is what the real one guarantees
// and what every exactly-once argument rests on), a lender's document, a gateway stub and a way to read the code out of a text.
import { createFirestore } from './fake-firestore.js';
import { ensureTenantToken } from '../../tenant-links.mjs';
import { normalizeNic } from '../../wealthflow-nic.js';

export const SECRET = Buffer.alloc(32, 9);
export const UID = 'owner1';
export const NIC = '853400937V';
export const CANON = normalizeNic(NIC).canonical;
export const PHONE = '077 123 4567';                          // +94771234567
export const T0 = Date.parse('2026-10-05T05:00:00Z');

export function makeDb() {
    const fs = createFirestore();
    const db = fs.db;
    const orig = db.runTransaction.bind(db);
    let chain = Promise.resolve();
    db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; };
    return { fs, db };
}

export const lenderDoc = (over = {}) => ({
    settings: { currency: 'LKR' },
    income: [{
        id: 'inv1', name: 'Fixed deposit', company: 'PRIVATE COMPANY NAME', notes: 'PRIVATE NOTE', amount: 500000, rate: 24, freq: 'monthly', start: '2026-01-05',
        sms_notifications_enabled: true, sms_enabled_at: T0 - 86400e3 * 30, nic: NIC, phone: PHONE,
    }],
    incomeReceived: { 'inv1_2026-08': { amount: 10000, confirmedAt: T0 - 86400e3 * 40 } },
    debtors: [{
        id: 'deb1', name: 'PRIVATE DEBTOR NAME', notes: 'PRIVATE DEBTOR NOTE', phone: PHONE, nic: NIC,
        sms_notifications_enabled: true, sms_enabled_at: T0 - 86400e3 * 30,
        events: [
            { id: 'e1', kind: 'lent', amount: 50000, date: '2026-09-01', confirmed: true },
            { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-09-20', confirmed: true },
            { id: 'e3', kind: 'repayment', amount: 777, date: '2026-09-21', confirmed: false },
        ],
    }],
    ...over,
});

/** A lender with a document and a tenant token for the NIC. */
export async function seedTenant(fs, db, { uid = UID, user = lenderDoc(), nic = CANON, secret = SECRET } = {}) {
    fs.data.set(`users/${uid}`, structuredClone(user));
    const token = await ensureTenantToken({ db, uid, canonicalNic: nic, secret, now: T0 - 1000 });
    return token;
}

export function gateway(behaviour = () => ({ ok: true, gatewayId: 'g1', cost: 1, segments: 1 })) {
    const sent = []; let calls = 0;
    return {
        configured: true, senderId: 'WEALTHFLOW', sent,
        get calls() { return calls; },
        async send({ to, message }) {
            calls += 1;
            await new Promise((r) => setTimeout(r, 1));
            const res = behaviour({ to, message, call: calls });
            if (res.ok) sent.push({ to, message });
            return res;
        },
    };
}

export const codeIn = (message) => { const m = /^(\d{6}) is your WealthFlow/.exec(String(message || '')); return m ? m[1] : null; };

/** A random source that hands out these numbers in order, then keeps repeating the last. */
export const codes = (...list) => { let i = 0; return () => Number(list[Math.min(i++, list.length - 1)]); };

export const allText = (fs) => JSON.stringify([...fs.data.entries()]);
