/* Two or more "devices" (browser contexts with their own localStorage) sharing
 * ONE stateful cloud document. See firebase-cloud.mjs. */
import { launchChromium, serveRepo, completeOnboarding } from './harness.mjs';
import { createCloud } from './firebase-cloud.mjs';

export async function bootDevices(names, { repoDir = process.cwd(), pin = '123456', headless = true, cloud = createCloud() } = {}) {
    const server = await serveRepo(repoDir);
    const browser = await launchChromium({ headless });
    const devices = {};
    const open = async (name, context) => {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String((e && e.message) || e).slice(0, 300)));
        await cloud.attach(page);
        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await completeOnboarding(page, { pin });
        return { name, context, page, errors };
    };
    for (const name of names) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        devices[name] = await open(name, context);
    }
    /** Reload a device the way a deploy-triggered refresh does: same storage, new page load. */
    const reload = async (name) => {
        const d = devices[name];
        const fresh = await d.context.newPage();
        const errors = [];
        fresh.on('pageerror', (e) => errors.push(String((e && e.message) || e).slice(0, 300)));
        await cloud.attach(fresh);
        await d.page.close();
        await fresh.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await completeOnboarding(fresh, { pin });
        d.page = fresh; d.errors = errors;
        return d;
    };
    return {
        cloud, devices, reload, server, browser,
        close: async () => { await browser.close(); await server.close(); },
    };
}

/** Read the settings object a device currently holds. */
export const settingsOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify(DB.getObj('settings', {}))));
