#!/usr/bin/env python3
"""
Regenerates the COUNTRIES table inside wealthflow-phone.js.

Not part of the test run (CI has no Python libraries): this is how the table was produced, kept so the next person can refresh
it when numbering plans change.

    python3 -m pip install phonenumbers babel
    python3 test/helpers/gen-countries.py > /tmp/countries.txt     # then paste between the markers in wealthflow-phone.js

Sources: Google's libphonenumber metadata (Apache-2.0) through the `phonenumbers` package for the calling code, the national
(trunk) prefix and the possible national-number lengths; CLDR through `babel` for the English country name; the IANA time zone
database (zoneinfo) for the standard-time UTC offset of the zone the region's example number belongs to.

Each row:  [ISO 3166 region, name, calling code, standard UTC offset in minutes, trunk prefix, possible national lengths]
"""
import datetime
import json
import sys
import zoneinfo

import phonenumbers
from phonenumbers import PhoneMetadata, PhoneNumberType
from phonenumbers import timezone as pntz
from babel import Locale

NAMES = Locale('en').territories

# Where "the zone of the example number" is a poor stand-in for the country: one standard offset (minutes) chosen so that a
# daytime window lands in daytime across most of the country's population.
OVERRIDE = {
    'US': -360, 'CA': -300, 'MX': -360, 'BR': -180, 'RU': 180, 'AU': 600, 'ID': 420, 'KZ': 300, 'CN': 480, 'AR': -180,
    'CL': -240, 'CD': 60, 'GL': -180, 'MN': 480, 'EC': -300, 'PF': -600, 'KI': 720, 'FM': 600, 'UM': -600, 'PT': 0, 'ES': 60,
    'NZ': 720, 'SJ': 60, 'AQ': 0,
}

# Only a handful of names read badly straight from CLDR in a drop-down.
RENAME = {
    'HK': 'Hong Kong', 'MO': 'Macao', 'MM': 'Myanmar', 'PS': 'Palestine', 'FK': 'Falkland Islands', 'CD': 'Congo (DRC)',
    'CG': 'Congo (Republic)', 'CI': 'Ivory Coast', 'VA': 'Vatican City', 'TL': 'Timor-Leste', 'SZ': 'Eswatini', 'CZ': 'Czechia',
    'AC': 'Ascension Island', 'XK': 'Kosovo', 'MK': 'North Macedonia', 'CV': 'Cape Verde', 'BQ': 'Caribbean Netherlands',
    'SH': 'Saint Helena', 'TA': 'Tristan da Cunha', 'KP': 'North Korea', 'KR': 'South Korea', 'LA': 'Laos', 'BN': 'Brunei',
    'RE': 'Reunion', 'CW': 'Curacao', 'AX': 'Aland Islands', 'BL': 'Saint Barthelemy',
}
ASCII = {'ç': 'c', 'é': 'e', 'í': 'i', 'ó': 'o', 'å': 'a', 'ô': 'o', 'ã': 'a', 'ü': 'u', 'ö': 'o', 'ä': 'a', 'ñ': 'n', 'è': 'e'}

def ascii_name(text):
    return ''.join(ASCII.get(ch, ch) for ch in text)

# libphonenumber still names a few zones by their old spelling, which a minimal tz database may not carry
ZONE_ALIAS = {
    'Asia/Calcutta': 'Asia/Kolkata', 'Africa/Asmera': 'Africa/Asmara', 'Atlantic/Faeroe': 'Atlantic/Faroe',
    'Asia/Rangoon': 'Asia/Yangon', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh',
}

def standard_offset_minutes(tz_name):
    tz = zoneinfo.ZoneInfo(ZONE_ALIAS.get(tz_name, tz_name))
    offs = []
    for month in (1, 7):
        d = datetime.datetime(2026, month, 15, 12, 0, tzinfo=tz)
        offs.append(int(d.utcoffset().total_seconds() // 60))
    return min(offs)

rows = []
for region in sorted(phonenumbers.SUPPORTED_REGIONS):
    meta = PhoneMetadata.metadata_for_region(region)
    dial = meta.country_code
    trunk = meta.national_prefix or ''
    # An SMS goes to a mobile: its lengths, not every kind of number the country has (premium, toll-free, pagers ...).
    mobile = meta.mobile.possible_length if meta.mobile is not None else ()
    lens = sorted({n for n in mobile if n > 0}) or sorted({n for n in meta.general_desc.possible_length if n > 0})
    if not lens:
        sys.stderr.write(f'no lengths for {region}\n')
        continue
    name = RENAME.get(region) or NAMES.get(region) or region
    name = ascii_name(name)
    if region in OVERRIDE:
        off = OVERRIDE[region]
    else:
        off = None
        try:
            ex = phonenumbers.example_number_for_type(region, PhoneNumberType.MOBILE) or phonenumbers.example_number(region)
            zones = [z for z in pntz.time_zones_for_number(ex) if z and not z.startswith('Etc/Unknown')]
            if zones:
                off = standard_offset_minutes(zones[0])
        except Exception as e:  # a region with no example number or no zone data falls through to the dial-code default below
            sys.stderr.write(f'tz for {region}: {e}\n')
    rows.append([region, name, str(dial), off, trunk, ','.join(str(n) for n in lens)])

# a region with no usable zone takes the offset of its calling code's main region
by_dial = {}
for r in rows:
    by_dial.setdefault(r[2], []).append(r)
for r in rows:
    if r[3] is None:
        known = [x[3] for x in by_dial[r[2]] if x[3] is not None]
        r[3] = known[0] if known else 330
        sys.stderr.write(f'{r[0]}: offset defaulted to {r[3]}\n')

rows.sort(key=lambda r: r[1])
out = []
for r in rows:
    out.append('    ' + json.dumps(r, ensure_ascii=True, separators=(',', ':')).replace('"', "'") + ',')
print('\n'.join(out))

# several regions share a calling code (+1, +7, +44 ...): the first one libphonenumber lists is the "main" region
shared = {}
for dial, regions in phonenumbers.COUNTRY_CODE_TO_REGION_CODE.items():
    if len(regions) > 1:
        shared[str(dial)] = regions[0]
print('// MAIN: ' + json.dumps(shared, separators=(',', ':'), sort_keys=True).replace('"', "'"))
sys.stderr.write(f'{len(rows)} regions\n')
