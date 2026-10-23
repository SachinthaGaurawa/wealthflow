# The Contacts button: what a web page can and cannot reach

Owner ask 2026-10-23: the Contacts button beside **Mobile number** and **Second mobile number (optional)** must open the device's own contacts and put the chosen
number into its field, not ask for a file.

## What the code does (`wealthflow-people.js`, `wealthflow-people-ui.js`)

| Browser | Path |
|---|---|
| Chrome (or an installed PWA) on Android: the Contact Picker API, `navigator.contacts.select(['name','tel'])` | Opens the system picker at once, from the tap. One number: imported. Several: a chooser (only numbers the text service can reach are offered). Cancel: nothing changes. A refusal or error: a short sentence and the paste sheet. |
| Safari and Chrome on iPhone and iPad, every desktop browser (Mac, Windows, Linux) | **No contact picker exists.** The sheet says so, and leads with the two-step route: copy the contact (or just its number) in the Contacts app and press **Paste from clipboard**, or drag the contact onto the dotted box. A vCard/CSV file is behind **Have a contacts file instead?** and is never opened by itself. |

The two buttons share one routine and each carries its own target (`phone` / `phone2`), so the second never overwrites the first. The picked number goes through the same
`applyNumber` path as typing (validation, the saved-person link, dirty state); saving stays with the form's own Save. A second tap while the picker is open is ignored.

## Why a browser cannot do more

The Contact Picker API is implemented only by Chrome on Android. Safari (iOS and macOS), Firefox and Chrome/Edge on desktop do not implement it, and Chrome on iOS is Safari's engine
underneath. There is no permission a web page can ask for that exposes the address book on those systems. What would reach them:

1. a native app shell (for example a Capacitor build with a contacts plugin) distributed through the App Store / Play Store / a desktop installer: a separate project with its own
   accounts, review and releases;
2. reading the person's Google Contacts through the Google People API after a Google sign-in: only the contacts that sync to that Google account, needs the sensitive
   `contacts.readonly` scope (Google verification, a warning screen until verified), and is an online service, not the device's contacts.

Neither is part of this change.

## Permissions and privacy

Nothing is requested at start-up. The picker is opened only from the tap; Chrome shows its own system chooser and returns only the contacts the person selects, only the
name and number fields asked for. Nothing else is read, stored or uploaded; the clipboard is read only when **Paste from clipboard** is pressed.

## Tests

`test/e2e/contacts-device.mjs` (real Chromium, a stand-in picker: one number, several, cancel, no number, refusal, no picker, save, foreign number, double tap, and that no file dialog
ever opens), `test/e2e/people-book.mjs` (the sheet, paste, file, drop), `test/people_test.js`, `test/people_escape_test.js`.

Not run: the real picker on a real Android phone (it cannot be driven from this sandbox), and Safari/iOS/macOS (nothing to drive there; the sheet is the only path).
