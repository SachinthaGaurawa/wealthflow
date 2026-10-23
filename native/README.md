# WealthFlow app shell (Capacitor): opens the phone's own contacts

**Status: source only. Nothing here has been built, signed, installed on a device or released.** The web side of this feature (`wealthflow-people.js`,
`pickContactResult`) is tested and live; this folder is the native half it talks to. Read "Blockers" before spending time on a build.

## Why this folder exists

A web page cannot read the address book on an iPhone, iPad, Mac or Windows PC: Safari and every browser on iOS have no Contact Picker, and desktop browsers have none either.
Chrome on Android has one, so Android users in Chrome (or the installed PWA) already get the system chooser without anything from this folder.

The only way to open the iPhone's contacts from WealthFlow is a native app that hosts the website and gives the page one small call. That is this shell.
There is no equivalent for Mac or Windows browsers; a desktop app would be a separate project and is not attempted.

## How it works

```
Contacts button -> wealthflow-people.js pickContactResult()
                     |- WealthFlowContactPicker.pick()      (this shell: Android and iPhone)   <- the app's own plugin
                     |- navigator.contacts.select()          (Chrome on Android, no shell)
                     '- otherwise: "unsupported" -> paste / drag / file sheet
```

`capacitor.config.json` loads the live website (`server.url` = `https://www.wealthflow.lk/app`) inside the app, so web releases reach the app without a store release.
`www/index.html` is only the "no connection" page. Only the plugin contract below is native.

### The plugin: `WealthFlowContactPicker.pick()`

| Answer | Meaning |
|---|---|
| `{ cancelled: true }` | the person backed out (always answered, so the page's one-at-a-time lock is released) |
| `{ cancelled: false, name, number }` | the ONE number the person touched in the system chooser |
| rejection, code `UNAVAILABLE` / `BUSY` / `FAILED` | no contacts app / a chooser is already open / the answer could not be read |

Sources: `android/app/src/main/java/lk/wealthflow/app/WealthFlowContactPickerPlugin.java` (registered in `MainActivity.java`) and
`ios/App/App/WealthFlowContactPickerPlugin.swift` (registered in `MainViewController.swift`, which `SceneDelegate.swift` and `Main.storyboard` now use).

### Permissions: none for contacts

| | What is used | Contacts permission |
|---|---|---|
| Android | `Intent.ACTION_PICK` on `CommonDataKinds.Phone.CONTENT_URI`: the Contacts app shows the chooser and the app gets read access to the one chosen row, for that result only | **None.** `READ_CONTACTS`, `WRITE_CONTACTS` and `GET_ACCOUNTS` are removed from the merged manifest (`tools:node="remove"`) so a library added later cannot bring them in |
| iPhone / iPad | `CNContactPickerViewController`, which runs out of process and hands the app only what was chosen; only phone numbers are shown and selectable | **None.** No `NSContactsUsageDescription`, no `CNContactStore` |

The address book is never listed, read in bulk, stored, written to or uploaded. `test/native_shell_test.js` fails if a contacts permission or usage string appears.

### Why not `@capacitor-community/contacts`

Its 8.0.0 source was read (not just its README) and rejected: its Android `pickContact` first requests `READ_CONTACTS` **and `WRITE_CONTACTS`** (the annotation lists both), its iOS
`pickContact` asks for full Contacts access before showing the picker that needs none, and neither platform settles the promise when the person cancels (Android only handles
`RESULT_OK`; iOS has no `contactPickerDidCancel`), so a page would wait forever. Google's People API was not considered for this: it is the person's cloud contacts, not the
device's, needs a sensitive OAuth scope with verification, and is an online service.

## Blockers (what has to happen before anyone can use this)

1. **Google sign-in does not work inside an embedded WebView.** WealthFlow signs in with Firebase `signInWithPopup` (`index.html`, with a redirect fallback). Google refuses OAuth
   in embedded WebViews (`disallowed_useragent`), so the app would open and then fail at sign-in. The fix is native sign-in in the shell (for example a maintained Capacitor
   Google sign-in plugin that returns an ID token, then `signInWithCredential`) plus a web branch in `index.html`. That needs OAuth clients created in the owner's Google Cloud
   project (an Android client with the app's SHA-1, an iOS client) and is **not done**. Until it is, the shell cannot be used to sign in.
2. **Accounts and signing the owner must create:** Apple Developer Program (iOS), Google Play Console (Android), an Android upload keystore and Apple signing certificates and profiles.
   Keystores, `.p12`, `.mobileprovision` and `google-services.json` are in `native/.gitignore`; they must never be committed.
3. **App Store review:** Apple can reject an app that only wraps a website (guideline 4.2, minimum functionality). The app's value beyond the site is what this feature adds; that is
   a review risk the owner should weigh, not something code can remove.
4. **Not built or run by anyone yet.** See the table below.

## Build (once the blockers are resolved)

```bash
cd native
npm ci                      # Capacitor 8.5.3, pinned by package-lock.json; needs Node 22+
npx cap sync                # writes android/app/src/main/assets/* and ios/App/App/public (both git-ignored)
# Android: needs JDK 21 and the Android SDK (API 36)
npx cap open android        # Android Studio: Build > Generate Signed Bundle / APK
# iOS: needs macOS and Xcode
npx cap open ios            # Xcode: select the App target, set the Team, Product > Archive
```

Bundle / application id: `lk.wealthflow.app` (change it in `capacitor.config.json`, `android/app/build.gradle` and the Xcode project together if the owner wants another).
`assetlinks.json` in the repository root still holds a placeholder for an Android Trusted Web Activity that was never completed; this shell does not use it.

A web deploy updates what the installed app shows (it loads the site). A change in this folder (the plugin, permissions, Capacitor version) only reaches people through a new
store release.

## What was and was not verified

| Part | Verified | How |
|---|---|---|
| The page's use of the plugin (selected, several numbers, cancel, no number, refusal, failure, malformed answer, one chooser at a time, form closed mid-pick) | yes | `test/contacts_service_test.js` (unit), `test/e2e/contacts-native.mjs` (real Chromium with a stand-in bridge) |
| Android plugin Java | syntax and Android API use only | compiled with `javac` against the real Android 16 framework (`org.robolectric:android-all`) and **stubs** of the Capacitor classes copied from the Capacitor 8.5.3 sources. Not built by Gradle (no Android SDK reachable here), not run |
| iOS plugin Swift, storyboard, project file | no | no Swift compiler or Xcode here; the project file entries were added by script and are unchecked |
| The system chooser opening and returning a number on a real phone | **no** | no device |
| That Android grants the one-row read without `READ_CONTACTS` for this intent | **not tested** | follows Android's documented picker behaviour; confirm on a device first |
| Sign-in, release, store review | **no** | blocked, see above |
