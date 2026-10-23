# The Contacts button: what a web page can and cannot reach

Owner ask 2026-10-23: the Contacts button beside **Mobile number** and **Second mobile number (optional)** must open the device's own contacts and put the chosen
number into its field, not ask for a file.

## What the code does (`wealthflow-people.js` `pickContactResult`, `wealthflow-people-ui.js`)

One service, `pickContactResult(win)`, chooses the picker the device really has and answers with an explicit outcome (`selected`, `cancelled`, `no-phone-number`,
`permission-denied`, `unsupported`, `error`, `busy`). It never opens a file dialog and never touches a form; the Contacts buttons decide what to do with the answer.

| Where WealthFlow runs | Picker | Result |
|---|---|---|
| **The WealthFlow app shell** (`native/`, Capacitor) on Android or iPhone/iPad | the app's own plugin `WealthFlowContactPicker.pick()`: the operating system's contact chooser, no contacts permission | one tap, straight to the chooser; the one number touched is imported. **Source only: not built, not on any device, not released** (see `native/README.md`, blockers) |
| Chrome (or an installed PWA) on Android | the Contact Picker API, `navigator.contacts.select(['name','tel'])` | same: opens at once from the tap. Several numbers: a chooser (only numbers the text service can reach are offered). Cancel: nothing changes |
| Safari and Chrome on iPhone and iPad (no app shell), every desktop browser (Mac, Windows, Linux) | **none exists** | the sheet says so, and leads with the two-step route: copy the contact (or just its number) in the Contacts app and press **Paste from clipboard**, or drag the contact onto the dotted box. A vCard/CSV file is behind **Have a contacts file instead?** and is never opened by itself |

The two buttons share one routine and each carries its own target (`phone` / `phone2`), so the second never overwrites the first. The picked number goes through the same
`applyNumber` path as typing (validation, the saved-person link, dirty state); saving stays with the form's own Save. A second tap while a chooser is open is ignored (the service
holds the lock, so the sheet and the Saved people import are covered too), and an answer that arrives after the form was closed is dropped.

## Why a browser cannot do more

The Contact Picker API is implemented only by Chrome on Android. Safari (iOS and macOS), Firefox and Chrome/Edge on desktop do not implement it, and Chrome on iOS is Safari's engine
underneath. There is no permission a web page can ask for that exposes the address book on those systems. What would reach them:

1. a native app shell distributed through the App Store / Play Store: `native/` holds one (Capacitor, with its own least-privilege plugin, see `native/README.md`), but it is **source
   only**, and sign-in inside it is an open blocker (Google refuses OAuth in an embedded WebView). A Mac or Windows app would be another project and is not attempted;
2. reading the person's Google Contacts through the Google People API after a Google sign-in: only the contacts that sync to that Google account, needs the sensitive
   `contacts.readonly` scope (Google verification, a warning screen until verified), and is an online service, not the device's contacts. **Not used.**

## Permissions and privacy

Nothing is requested at start-up. The picker is opened only from the tap; Chrome (or, in the app shell, the operating system) shows its own chooser and returns only the contacts the person selects, only the
name and number fields asked for. Nothing else is read, stored or uploaded; the clipboard is read only when **Paste from clipboard** is pressed.

## Tests

`test/contacts_service_test.js` (the service: both pickers, every outcome, malformed native answers, one at a time), `test/e2e/contacts-native.mjs` (real Chromium, a stand-in for the app\'s bridge), `test/native_shell_test.js` (the shell\'s promises as text: one plugin name, no contacts permission, cancel always settles), `test/e2e/contacts-device.mjs` (real Chromium, a stand-in picker: one number, several, cancel, no number, refusal, no picker, save, foreign number, double tap, and that no file dialog
ever opens), `test/e2e/people-book.mjs` (the sheet, paste, file, drop), `test/people_test.js`, `test/people_escape_test.js`.

Not run: the real picker on a real Android phone or iPhone (it cannot be driven from this sandbox), the `native/` shell in Gradle or Xcode (neither SDK is reachable here), and Safari/iOS/macOS browsers (nothing to drive there; the sheet is the only path). The `native/` plugin sources are unreleased and unverified on a device.
