'use strict';
/* =============================================================================
 * autonomy/manifest-notes.cjs — keep the announced notes readable.
 * -----------------------------------------------------------------------------
 * The app shows the notes of the installed version from `version.json` (the code that is
 * actually deployed) and `system/manifest` in Firestore (the announcement), and the
 * manifest wins per version. v7.69.36 was announced with its notes as a raw JSON string
 * (`{"date":...,"headline":"Urgent security update",...}`), so a device would have shown
 * that text as it stands. release.cjs writes both places from one source from now on, and
 * this pure helper repairs an entry that is already wrong: a manifest note that is
 * serialised JSON is replaced by what version.json says for the same version. Nothing else
 * is touched — a human-written note is never overwritten.
 * ===========================================================================*/

const looksSerialised = (v) => typeof v === 'string' && /^\s*[{[]/.test(v);
const usable = (v) => (typeof v === 'string' && v.trim() && !looksSerialised(v))
    || (v && typeof v === 'object' && Array.isArray(v.sections) && v.sections.length > 0);

function cmp(a, b) {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
    return 0;
}

/**
 * @param {Record<string, any>} manifestNotes  system/manifest.notes
 * @param {Record<string, any>} versionNotes   version.json notes
 * @param {{keep?: number}} [o]                only the newest `keep` versions are looked at
 * @returns {{notes: Record<string, any>, repaired: string[]}}
 */
function repairManifestNotes(manifestNotes, versionNotes, { keep = 6 } = {}) {
    const notes = Object.assign({}, manifestNotes || {});
    const repaired = [];
    const recent = Object.keys(notes).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp).slice(-keep);
    for (const v of recent) {
        if (looksSerialised(notes[v]) && usable((versionNotes || {})[v])) {
            notes[v] = versionNotes[v];
            repaired.push(v);
        }
    }
    return { notes, repaired };
}

module.exports = { repairManifestNotes, looksSerialised };
