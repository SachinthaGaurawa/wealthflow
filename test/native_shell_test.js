/* =============================================================================
 * test/native_shell_test.js — native/ (the Capacitor app shell) keeps its promises
 * -----------------------------------------------------------------------------
 * The shell cannot be built in CI (no Android SDK, no Xcode), so what can go wrong silently is pinned as text:
 *   - the plugin name the page asks for is the name both native plugins register;
 *   - neither platform asks for contacts access (Android manifest, iOS Info.plist, iOS sources), and the Android manifest removes any a library would add;
 *   - both native sources always settle the promise on a cancel;
 *   - the shell loads the live site over https only, and is kept out of the published website;
 *   - signing material is git-ignored.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const NAME = 'WealthFlowContactPicker';

describe('native/ app shell', () => {
    const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/\/?.*$/gm, '').replace(/\/\/ .*$/gm, '');   // the comments explain the rules in the very words the rules ban
    const java = code(read('native/android/app/src/main/java/lk/wealthflow/app/WealthFlowContactPickerPlugin.java'));
    const swift = code(read('native/ios/App/App/WealthFlowContactPickerPlugin.swift'));
    const manifest = read('native/android/app/src/main/AndroidManifest.xml');
    const plist = read('native/ios/App/App/Info.plist');
    const web = read('wealthflow-people.js');

    it('the page, Android and iOS use one plugin name and one method', () => {
        expect(web).toContain(`'${NAME}'`);
        expect(java).toContain(`@CapacitorPlugin(name = "${NAME}")`);
        expect(swift).toContain(`jsName = "${NAME}"`);
        expect(java).toMatch(/@PluginMethod\s+public void pick\(PluginCall call\)/);
        expect(swift).toContain('CAPPluginMethod(name: "pick"');
        expect(web).toContain('native.pick()');
    });

    it('is registered where the platform needs it', () => {
        expect(read('native/android/app/src/main/java/lk/wealthflow/app/MainActivity.java')).toContain('registerPlugin(WealthFlowContactPickerPlugin.class)');
        expect(read('native/ios/App/App/MainViewController.swift')).toContain('registerPluginInstance(WealthFlowContactPickerPlugin())');
        expect(read('native/ios/App/App/SceneDelegate.swift')).toContain('MainViewController()');
        expect(read('native/ios/App/App/Base.lproj/Main.storyboard')).toContain('customClass="MainViewController"');
        const pbx = read('native/ios/App/App.xcodeproj/project.pbxproj');
        for (const f of ['WealthFlowContactPickerPlugin.swift', 'MainViewController.swift']) expect(pbx.split(f).length - 1, f).toBeGreaterThanOrEqual(4);
    });

    it('asks for no contacts access on either platform', () => {
        // Android: no uses-permission for contacts except the removals
        const perms = [...manifest.matchAll(/<uses-permission[^>]*>/g)].map((m) => m[0]);
        for (const p of perms) {
            if (/CONTACTS|GET_ACCOUNTS/.test(p)) expect(p, p).toContain('tools:node="remove"');
        }
        for (const p of ['READ_CONTACTS', 'WRITE_CONTACTS', 'GET_ACCOUNTS']) expect(manifest).toContain(`android.permission.${p}" tools:node="remove"`);
        expect(java).not.toMatch(/requestPermission|checkSelfPermission|READ_CONTACTS|WRITE_CONTACTS/);
        expect(java).toContain('ContactsContract.CommonDataKinds.Phone.CONTENT_URI');
        // iOS: no usage string, no store, no authorisation request
        expect(plist).not.toMatch(/NSContactsUsageDescription/);
        expect(swift).not.toMatch(/CNContactStore|requestAccess|authorizationStatus/);
        expect(swift).toContain('CNContactPickerViewController');
    });

    it('settles the promise when the person cancels, on both platforms', () => {
        expect(java).toContain('Activity.RESULT_OK');
        expect(java).toMatch(/out\.put\("cancelled", true\);\s*call\.resolve\(out\);/);
        expect(swift).toContain('contactPickerDidCancel');
        expect(swift).toContain('finish(["cancelled": true])');
        // and the result carries nothing but a name and a number
        expect(java).not.toMatch(/EMAIL|PHOTO|ADDRESS/i);
        expect(swift).not.toMatch(/emailAddresses|imageData|postalAddresses/);
    });

    it('loads the live site over https only, and the web build never publishes the shell', () => {
        const cfg = JSON.parse(read('native/capacitor.config.json'));
        expect(cfg.server.url).toMatch(/^https:\/\/www\.wealthflow\.lk\//);
        expect(cfg.server.cleartext).toBe(false);
        expect(cfg.android.allowMixedContent).toBe(false);
        expect(read('.vercelignore').split('\n')).toContain('/native/');
    });

    it('keeps signing material out of git', () => {
        const ig = read('native/.gitignore').split('\n');
        for (const p of ['*.jks', '*.keystore', 'keystore.properties', '*.p12', '*.mobileprovision', 'google-services.json', 'GoogleService-Info.plist']) expect(ig, p).toContain(p);
        const tracked = [];
        (function walk(d) {
            for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
                if (e.name === 'node_modules') continue;
                const rel = path.join(d, e.name);
                if (e.isDirectory()) walk(rel); else tracked.push(rel);
            }
        }('native'));
        expect(tracked.filter((f) => /\.(jks|keystore|p12|mobileprovision|p8)$|keystore\.properties$|google-services\.json$|GoogleService-Info\.plist$/.test(f))).toEqual([]);
    });
});
