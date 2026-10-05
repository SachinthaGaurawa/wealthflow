/* =============================================================================
 * wealthflow-phone.js — a phone number, the way a person types it, into E.164
 * -----------------------------------------------------------------------------
 * One rule for the page (which validates a number before it lets the owner switch
 * text messages on) and the server (which validates it again before sending): the
 * same function, so they can never disagree about what a number is. No imports, no
 * DOM, no clock. window.WFPhone.
 *
 * ANY COUNTRY. A number is E.164: "+", the country's calling code, the national number. The
 * table below knows every country's calling code, its trunk prefix (the 0 people write in front
 * of a national number and drop when dialling from abroad) and the lengths its MOBILE numbers
 * have, so a number typed for the wrong country, or with a digit missing, is refused on the
 * page, before it is saved, instead of failing at the gateway a day later. Sri Lanka and the
 * +1 plan keep their stricter rules.
 *
 * The table is data from Google's libphonenumber metadata (Apache-2.0) and the IANA time zone
 * database, produced by test/helpers/gen-countries.py. It decides "can this number exist", never
 * "is this number connected": only the gateway knows that.
 * ===========================================================================*/

const s = (v) => String(v == null ? '' : v);

/** Sri Lanka's calling code. A bare local number ("077 123 4567") is read as this country's unless the caller says otherwise. */
export const DEFAULT_COUNTRY = '94';
export const DEFAULT_REGION = 'LK';

/** [ISO 3166 region, name, calling code, standard UTC offset in minutes, trunk prefix, possible mobile national-number lengths] */
const ROWS = [
    ['AF','Afghanistan','93',270,'0','9'],
    ['AX','Aland Islands','358',120,'0','6,7,8,9,10'],
    ['AL','Albania','355',60,'0','9'],
    ['DZ','Algeria','213',60,'0','9'],
    ['AS','American Samoa','1',-600,'1','10'],
    ['AD','Andorra','376',60,'','6,9'],
    ['AO','Angola','244',60,'','9'],
    ['AI','Anguilla','1',-600,'1','10'],
    ['AG','Antigua & Barbuda','1',-600,'1','10'],
    ['AR','Argentina','54',-180,'0','10,11'],
    ['AM','Armenia','374',240,'0','8'],
    ['AW','Aruba','297',-240,'','7'],
    ['AC','Ascension Island','247',0,'','5'],
    ['AU','Australia','61',600,'0','9'],
    ['AT','Austria','43',60,'0','7,8,9,10,11,12,13'],
    ['AZ','Azerbaijan','994',240,'0','9'],
    ['BS','Bahamas','1',-600,'1','10'],
    ['BH','Bahrain','973',180,'','8'],
    ['BD','Bangladesh','880',360,'0','10'],
    ['BB','Barbados','1',-600,'1','10'],
    ['BY','Belarus','375',180,'8','9'],
    ['BE','Belgium','32',60,'0','9'],
    ['BZ','Belize','501',-360,'','7'],
    ['BJ','Benin','229',60,'','10'],
    ['BM','Bermuda','1',-600,'1','10'],
    ['BT','Bhutan','975',360,'','8'],
    ['BO','Bolivia','591',-240,'0','8'],
    ['BA','Bosnia & Herzegovina','387',60,'0','8,9'],
    ['BW','Botswana','267',120,'','8'],
    ['BR','Brazil','55',-180,'0','10,11'],
    ['IO','British Indian Ocean Territory','246',360,'','7'],
    ['VG','British Virgin Islands','1',-600,'1','10'],
    ['BN','Brunei','673',480,'','7'],
    ['BG','Bulgaria','359',120,'0','8,9'],
    ['BF','Burkina Faso','226',0,'','8'],
    ['BI','Burundi','257',120,'','8'],
    ['KH','Cambodia','855',420,'0','8,9'],
    ['CM','Cameroon','237',60,'','9'],
    ['CA','Canada','1',-300,'1','10'],
    ['CV','Cape Verde','238',-60,'','7'],
    ['BQ','Caribbean Netherlands','599',-240,'','7'],
    ['KY','Cayman Islands','1',-600,'1','10'],
    ['CF','Central African Republic','236',60,'','8'],
    ['TD','Chad','235',60,'','8'],
    ['CL','Chile','56',-240,'','9'],
    ['CN','China','86',480,'0','11'],
    ['CX','Christmas Island','61',570,'0','9'],
    ['CC','Cocos (Keeling) Islands','61',570,'0','9'],
    ['CO','Colombia','57',-300,'0','10'],
    ['KM','Comoros','269',180,'','7'],
    ['CD','Congo (DRC)','243',60,'0','7,9'],
    ['CG','Congo (Republic)','242',60,'','9'],
    ['CK','Cook Islands','682',-600,'','5'],
    ['CR','Costa Rica','506',-360,'','8'],
    ['HR','Croatia','385',60,'0','8,9'],
    ['CU','Cuba','53',-300,'0','8'],
    ['CW','Curacao','599',-240,'','7,8'],
    ['CY','Cyprus','357',120,'','8'],
    ['CZ','Czechia','420',60,'','9'],
    ['DK','Denmark','45',60,'','8'],
    ['DJ','Djibouti','253',180,'','8'],
    ['DM','Dominica','1',-600,'1','10'],
    ['DO','Dominican Republic','1',-240,'1','10'],
    ['EC','Ecuador','593',-300,'0','9'],
    ['EG','Egypt','20',120,'0','10'],
    ['SV','El Salvador','503',-360,'','8'],
    ['GQ','Equatorial Guinea','240',60,'','9'],
    ['ER','Eritrea','291',180,'0','7'],
    ['EE','Estonia','372',120,'','7,8'],
    ['SZ','Eswatini','268',120,'','8'],
    ['ET','Ethiopia','251',180,'0','9'],
    ['FK','Falkland Islands','500',-180,'','5'],
    ['FO','Faroe Islands','298',0,'','6'],
    ['FJ','Fiji','679',720,'','7'],
    ['FI','Finland','358',120,'0','6,7,8,9,10'],
    ['FR','France','33',60,'0','9'],
    ['GF','French Guiana','594',-180,'0','9'],
    ['PF','French Polynesia','689',-600,'','8'],
    ['GA','Gabon','241',60,'','7,8'],
    ['GM','Gambia','220',0,'','7,9'],
    ['GE','Georgia','995',240,'0','9'],
    ['DE','Germany','49',60,'0','10,11'],
    ['GH','Ghana','233',0,'0','9'],
    ['GI','Gibraltar','350',60,'','8'],
    ['GR','Greece','30',120,'','10'],
    ['GL','Greenland','299',-180,'','6'],
    ['GD','Grenada','1',-600,'1','10'],
    ['GP','Guadeloupe','590',-240,'0','9'],
    ['GU','Guam','1',600,'1','10'],
    ['GT','Guatemala','502',-360,'','8'],
    ['GG','Guernsey','44',0,'0','10'],
    ['GN','Guinea','224',0,'','9'],
    ['GW','Guinea-Bissau','245',0,'','9'],
    ['GY','Guyana','592',-240,'','7'],
    ['HT','Haiti','509',-300,'','8'],
    ['HN','Honduras','504',-360,'','8'],
    ['HK','Hong Kong','852',480,'','8'],
    ['HU','Hungary','36',60,'06','9'],
    ['IS','Iceland','354',0,'','7,9'],
    ['IN','India','91',330,'0','10'],
    ['ID','Indonesia','62',420,'0','9,10,11,12'],
    ['IR','Iran','98',210,'0','10'],
    ['IQ','Iraq','964',180,'0','10'],
    ['IE','Ireland','353',0,'0','9'],
    ['IM','Isle of Man','44',0,'0','10'],
    ['IL','Israel','972',120,'0','9'],
    ['IT','Italy','39',60,'','9,10'],
    ['CI','Ivory Coast','225',0,'','10'],
    ['JM','Jamaica','1',-600,'1','10'],
    ['JP','Japan','81',540,'0','10'],
    ['JE','Jersey','44',0,'0','10'],
    ['JO','Jordan','962',180,'0','9'],
    ['KZ','Kazakhstan','7',300,'8','10'],
    ['KE','Kenya','254',180,'0','9'],
    ['KI','Kiribati','686',720,'0','8'],
    ['XK','Kosovo','383',60,'0','8'],
    ['KW','Kuwait','965',180,'','8'],
    ['KG','Kyrgyzstan','996',360,'0','9'],
    ['LA','Laos','856',420,'0','9,10'],
    ['LV','Latvia','371',120,'','8'],
    ['LB','Lebanon','961',120,'0','7,8'],
    ['LS','Lesotho','266',120,'','8'],
    ['LR','Liberia','231',0,'0','7,9'],
    ['LY','Libya','218',120,'0','9'],
    ['LI','Liechtenstein','423',60,'0','7,9'],
    ['LT','Lithuania','370',120,'0','8'],
    ['LU','Luxembourg','352',60,'','9'],
    ['MO','Macao','853',480,'','8'],
    ['MG','Madagascar','261',180,'0','9'],
    ['MW','Malawi','265',120,'0','9'],
    ['MY','Malaysia','60',480,'0','9,10'],
    ['MV','Maldives','960',300,'','7'],
    ['ML','Mali','223',0,'','8'],
    ['MT','Malta','356',60,'','8'],
    ['MH','Marshall Islands','692',720,'1','7'],
    ['MQ','Martinique','596',-240,'0','9'],
    ['MR','Mauritania','222',0,'','8'],
    ['MU','Mauritius','230',240,'','8'],
    ['YT','Mayotte','262',180,'0','9'],
    ['MX','Mexico','52',-360,'','10'],
    ['FM','Micronesia','691',600,'','7'],
    ['MD','Moldova','373',120,'0','8'],
    ['MC','Monaco','377',60,'0','8,9'],
    ['MN','Mongolia','976',480,'0','8'],
    ['ME','Montenegro','382',60,'0','8'],
    ['MS','Montserrat','1',-600,'1','10'],
    ['MA','Morocco','212',0,'0','9'],
    ['MZ','Mozambique','258',120,'','9'],
    ['MM','Myanmar','95',390,'0','7,8,9,10'],
    ['NA','Namibia','264',120,'0','9'],
    ['NR','Nauru','674',720,'','7'],
    ['NP','Nepal','977',345,'0','10'],
    ['NL','Netherlands','31',60,'0','9,11'],
    ['NC','New Caledonia','687',660,'','6'],
    ['NZ','New Zealand','64',720,'0','8,9,10'],
    ['NI','Nicaragua','505',-360,'','8'],
    ['NE','Niger','227',60,'','8'],
    ['NG','Nigeria','234',60,'0','10'],
    ['NU','Niue','683',-660,'','4,7'],
    ['NF','Norfolk Island','672',660,'','6'],
    ['KP','North Korea','850',540,'0','10'],
    ['MK','North Macedonia','389',60,'0','8'],
    ['MP','Northern Mariana Islands','1',600,'1','10'],
    ['NO','Norway','47',60,'','8'],
    ['OM','Oman','968',240,'','8'],
    ['PK','Pakistan','92',300,'0','10'],
    ['PW','Palau','680',540,'','7'],
    ['PS','Palestine','970',120,'0','9'],
    ['PA','Panama','507',-300,'','7,8'],
    ['PG','Papua New Guinea','675',600,'','8'],
    ['PY','Paraguay','595',-180,'0','9'],
    ['PE','Peru','51',-300,'0','9'],
    ['PH','Philippines','63',480,'0','10'],
    ['PL','Poland','48',60,'','9'],
    ['PT','Portugal','351',0,'','9'],
    ['PR','Puerto Rico','1',-240,'1','10'],
    ['QA','Qatar','974',180,'','8'],
    ['RE','Reunion','262',180,'0','9'],
    ['RO','Romania','40',120,'0','9'],
    ['RU','Russia','7',180,'8','10'],
    ['RW','Rwanda','250',120,'0','9'],
    ['BL','Saint Barthelemy','590',-240,'0','9'],
    ['SH','Saint Helena','290',0,'','5'],
    ['WS','Samoa','685',780,'','7,10'],
    ['SM','San Marino','378',60,'','8'],
    ['ST','Sao Tome & Principe','239',0,'','7'],
    ['SA','Saudi Arabia','966',180,'0','9'],
    ['SN','Senegal','221',0,'','9'],
    ['RS','Serbia','381',60,'0','8,9,10'],
    ['SC','Seychelles','248',240,'','7'],
    ['SL','Sierra Leone','232',0,'0','8'],
    ['SG','Singapore','65',480,'','8'],
    ['SX','Sint Maarten','1',-600,'1','10'],
    ['SK','Slovakia','421',60,'0','9'],
    ['SI','Slovenia','386',60,'0','8'],
    ['SB','Solomon Islands','677',660,'','5,7'],
    ['SO','Somalia','252',180,'0','7,8,9'],
    ['ZA','South Africa','27',120,'0','5,6,7,8,9'],
    ['KR','South Korea','82',540,'0','9,10'],
    ['SS','South Sudan','211',180,'0','9'],
    ['ES','Spain','34',60,'','9'],
    ['LK','Sri Lanka','94',330,'0','9'],
    ['KN','St. Kitts & Nevis','1',-600,'1','10'],
    ['LC','St. Lucia','1',-600,'1','10'],
    ['MF','St. Martin','590',-240,'0','9'],
    ['PM','St. Pierre & Miquelon','508',-180,'0','6,9'],
    ['VC','St. Vincent & Grenadines','1',-600,'1','10'],
    ['SD','Sudan','249',120,'0','9'],
    ['SR','Suriname','597',-180,'','7'],
    ['SJ','Svalbard & Jan Mayen','47',60,'','8'],
    ['SE','Sweden','46',60,'0','9'],
    ['CH','Switzerland','41',60,'0','9'],
    ['SY','Syria','963',180,'0','9'],
    ['TW','Taiwan','886',480,'0','9'],
    ['TJ','Tajikistan','992',300,'','9'],
    ['TZ','Tanzania','255',180,'0','9'],
    ['TH','Thailand','66',420,'0','9'],
    ['TL','Timor-Leste','670',540,'','8'],
    ['TG','Togo','228',0,'','8'],
    ['TK','Tokelau','690',780,'','4,5,6,7'],
    ['TO','Tonga','676',780,'','7'],
    ['TT','Trinidad & Tobago','1',-600,'1','10'],
    ['TA','Tristan da Cunha','290',0,'','4'],
    ['TN','Tunisia','216',60,'','8'],
    ['TR','Turkiye','90',180,'0','10'],
    ['TM','Turkmenistan','993',300,'8','8'],
    ['TC','Turks & Caicos Islands','1',-600,'1','10'],
    ['TV','Tuvalu','688',720,'','6,7'],
    ['VI','U.S. Virgin Islands','1',-240,'1','10'],
    ['UG','Uganda','256',180,'0','9'],
    ['UA','Ukraine','380',120,'0','9'],
    ['AE','United Arab Emirates','971',240,'0','9'],
    ['GB','United Kingdom','44',0,'0','10'],
    ['US','United States','1',-360,'1','10'],
    ['UY','Uruguay','598',-180,'0','8'],
    ['UZ','Uzbekistan','998',300,'','9'],
    ['VU','Vanuatu','678',660,'','7'],
    ['VA','Vatican City','39',60,'','9,10'],
    ['VE','Venezuela','58',-240,'0','10'],
    ['VN','Vietnam','84',420,'0','9'],
    ['WF','Wallis & Futuna','681',720,'','6'],
    ['EH','Western Sahara','212',0,'0','9'],
    ['YE','Yemen','967',180,'0','9'],
    ['ZM','Zambia','260',120,'0','9'],
    ['ZW','Zimbabwe','263',120,'0','9'],
];

/** Calling codes shared by several regions: the one a bare "+1" or "+44" is shown as. */
const MAIN = {'1':'US','212':'MA','262':'RE','290':'SH','358':'FI','39':'IT','44':'GB','47':'NO','590':'GP','599':'CW','61':'AU','7':'RU'};

export const COUNTRIES = Object.freeze(ROWS.map(([iso, name, dial, utc, trunk, lens]) => Object.freeze({
    iso, name, dial, utcOffsetMin: utc, trunk, lengths: Object.freeze(lens.split(',').map(Number)),
})));
const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));

/** Per calling code: every region that uses it, the lengths any of them allows, and the trunk prefixes in use. */
const DIALS = new Map();
for (const c of COUNTRIES) {
    if (!DIALS.has(c.dial)) DIALS.set(c.dial, { dial: c.dial, regions: [], lengths: new Set(), trunks: new Set() });
    const d = DIALS.get(c.dial);
    d.regions.push(c);
    for (const n of c.lengths) d.lengths.add(n);
    if (c.trunk) d.trunks.add(c.trunk);
}
for (const d of DIALS.values()) {
    d.lengths = [...d.lengths].sort((a, b) => a - b);
    // the longest trunk first, so "06" is tried before "0" where a country has both
    d.trunks = [...d.trunks].sort((a, b) => b.length - a.length);
    d.main = BY_ISO.get(MAIN[d.dial]) || d.regions[0];
}

export const regionByIso = (iso) => BY_ISO.get(s(iso).trim().toUpperCase()) || null;
/** The region a calling code is shown as ("1" is the United States, "44" the United Kingdom), or null. */
export const regionOfDial = (dial) => { const d = DIALS.get(s(dial).replace(/\D/g, '')); return d ? d.main : null; };
export const isDialCode = (dial) => DIALS.has(s(dial).replace(/\D/g, ''));

/** "94", "+94" or "LK" -> "94"; '' when it names nothing known. */
export function dialOf(country) {
    const t = s(country).trim();
    if (!t) return '';
    if (/^[A-Za-z]{2}$/.test(t)) { const r = BY_ISO.get(t.toUpperCase()); return r ? r.dial : ''; }
    const d = t.replace(/\D/g, '');
    return DIALS.has(d) ? d : '';
}

/** The calling code at the start of a string of digits (calling codes are prefix-free, so there is at most one). */
function dialPrefixOf(digits) {
    for (let n = 1; n <= 3; n += 1) { const p = digits.slice(0, n); if (DIALS.has(p)) return p; }
    return '';
}

/**
 * Any phone number a person might type, into E.164.
 *
 *   "077 123 4567"        -> +94771234567     (local, trunk 0)
 *   "771234567"           -> +94771234567     (local, no trunk 0)
 *   "94771234567"         -> +94771234567
 *   "0094 77 123 4567"    -> +94771234567     (00 international prefix)
 *   "+1 (415) 555-2671"   -> +14155552671
 *   "07911 123456", {defaultCountry:'GB'} -> +447911123456
 *   "+44 (0) 7911 123456" -> +447911123456    (the bracketed trunk 0 is dropped)
 *
 * `defaultCountry` is the country a number WITHOUT a country code belongs to: a calling code ("94", "+94") or a region ("LK").
 *
 * Returns `{ ok, e164, gateway, country, iso, reason }`. `country` is the calling code, `iso` the region it is shown as, `gateway`
 * the number without the plus, which is how Text.lk wants it. A number that is not unambiguously a number is REFUSED rather than
 * guessed at: an SMS to the wrong person is worse than an SMS not sent, and the refusal is shown to the owner.
 */
export function normalizePhone(input, { defaultCountry = DEFAULT_COUNTRY } = {}) {
    const raw = s(input).trim();
    if (!raw) return { ok: false, reason: 'empty' };
    if (/[^\d+\s().-]/.test(raw)) return { ok: false, reason: 'not-a-number' };
    if (raw.indexOf('+') > 0 || (raw.match(/\+/g) || []).length > 1) return { ok: false, reason: 'misplaced-plus' };
    let digits = raw.replace(/\D/g, '');
    if (!digits) return { ok: false, reason: 'empty' };

    let dial = '';
    let national = '';
    const international = raw.startsWith('+') || digits.startsWith('00');
    if (international) {
        if (!raw.startsWith('+')) digits = digits.slice(2);
        if (!digits || digits.startsWith('0')) return { ok: false, reason: 'bad-length' };
        dial = dialPrefixOf(digits);
        if (!dial) return { ok: false, reason: 'unknown-country-code' };
        national = digits.slice(dial.length);
    } else {
        dial = dialOf(defaultCountry);
        if (!dial) return { ok: false, reason: 'needs-country-code' };
        const info = DIALS.get(dial);
        const fits = (n) => info.lengths.includes(n);
        const trunk = info.trunks.find((t) => digits.startsWith(t) && digits.length > t.length) || '';
        if (trunk && fits(digits.length - trunk.length)) national = digits.slice(trunk.length);
        else if (fits(digits.length)) national = digits;
        else if (digits.startsWith(dial) && (fits(digits.length - dial.length) || info.trunks.some((t) => digits.startsWith(dial + t) && fits(digits.length - dial.length - t.length)))) {
            national = digits.slice(dial.length);                   // "94771234567": the country code was typed without a plus
        } else {
            // fewer digits than any number here can have is a number with digits missing; otherwise it is most likely another country's
            const tooShort = digits.length < Math.min(...info.lengths);
            return { ok: false, reason: trunk || tooShort ? 'bad-length' : 'needs-country-code', country: dial };
        }
    }

    const info = DIALS.get(dial);
    if (!info.lengths.includes(national.length)) {
        // "+44 (0) 7911 123456": the trunk digit the person wrote after the country code is not part of the number
        const trunk = info.trunks.find((t) => national.startsWith(t) && info.lengths.includes(national.length - t.length));
        if (!trunk) return { ok: false, reason: 'bad-length', country: dial };
        national = national.slice(trunk.length);
    }
    // a Sri Lankan SMS goes to a mobile: 9 digits after the code, the first being 7
    if (dial === '94' && !/^7\d{8}$/.test(national)) return { ok: false, reason: 'not-a-mobile-number', country: '94' };
    // NANP: +1, then exactly ten digits, area code and exchange never start with 0 or 1
    if (dial === '1' && !/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return { ok: false, reason: 'bad-length', country: '1' };
    return { ok: true, e164: '+' + dial + national, gateway: dial + national, country: dial, iso: info.main.iso };
}

/** "+94771234567" -> "+94 77 123 4567", "+447911123456" -> "+44 791 112 3456": for people to read, never for the wire. */
export function formatPhone(e164) {
    const d = s(e164).replace(/\D/g, '');
    const dial = dialPrefixOf(d);
    if (!dial) return s(e164);
    const n = d.slice(dial.length);
    const groups = { 7: [3, 4], 8: [4, 4], 9: [3, 3, 3], 10: [3, 3, 4], 11: [3, 4, 4] }[n.length];
    if (dial === '94' && n.length === 9) return `+94 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
    if (!groups) return `+${dial} ${n}`;
    const parts = []; let at = 0;
    for (const g of groups) { parts.push(n.slice(at, at + g)); at += g; }
    return `+${dial} ${parts.join(' ')}`;
}

/** The country a number belongs to, for display: "Sri Lanka", or "" when it is not a number. */
export function countryNameOf(e164) {
    const dial = dialPrefixOf(s(e164).replace(/\D/g, ''));
    const info = dial ? DIALS.get(dial) : null;
    return info ? (info.regions.length > 1 && dial === '1' ? 'United States / Canada / Caribbean' : info.main.name) : '';
}

/** Minutes east of UTC (standard time) where the number's country is: when a scheduled text should arrive. Sri Lanka's when unknown. */
export function utcOffsetOf(e164) {
    const dial = dialPrefixOf(s(e164).replace(/\D/g, ''));
    const info = dial ? DIALS.get(dial) : null;
    return info ? info.main.utcOffsetMin : 330;
}

/** "+94771234567" -> "+94 77 ••• 4567"-style mask for logs and dashboards: enough to recognise, not enough to use. */
export function maskPhone(e164) {
    const d = s(e164).replace(/\D/g, '');
    if (d.length < 7) return '***';
    return '+' + d.slice(0, Math.min(2, d.length - 4)) + '*'.repeat(Math.max(3, d.length - 6)) + d.slice(-4);
}

export default { DEFAULT_COUNTRY, DEFAULT_REGION, COUNTRIES, normalizePhone, maskPhone, formatPhone, countryNameOf, utcOffsetOf, dialOf, regionByIso, regionOfDial, isDialCode };
