// =============================================================================
// WealthFlow iOS Shortcut Provisioning v1.0
//
// Returns:
//   - A pre-built iOS Shortcut payload (JSON) that the user can build by
//     following 3 simple in-app steps (we show them visual instructions).
//   - A `shortcuts://import-shortcut/?url=...` deep link the user can tap
//     to open the Shortcuts app with the import dialog (requires the
//     shortcut to be hosted at a URL Apple's CDN can fetch — iCloud share
//     links work; arbitrary web URLs do NOT in iOS 15+).
//
// In practice, the most reliable iOS path is:
//   1. We give the user a one-screen visual recipe (3 steps in Shortcuts app)
//   2. The Shortcut's "Get Contents of URL" action POSTs to our webhook
//   3. The user binds the Shortcut to a Personal Automation: "When I get a
//      message from <bank sender>" → run shortcut → text auto-sent to us
//
// This endpoint just returns the recipe + an open-Shortcuts-app deep link.
// =============================================================================

export const config = { runtime: 'edge' };

export default async function handler(req) {
    const u = new URL(req.url);
    const token = u.searchParams.get('token') || '';
    const origin = u.origin;
    const webhook = `${origin}/api/sms-ingest`;

    // The Shortcut JSON template — a user-friendly visual description
    const recipe = {
        title: 'WealthFlow SMS Auto-Capture',
        icon: '💸',
        webhook_url: webhook,
        device_token: token,
        steps: [
            {
                step: 1,
                title: 'Open the Shortcuts app',
                detail: 'Pre-installed on every iPhone. Look for the colourful icon shaped like overlapping circles.',
                action_emoji: '📱'
            },
            {
                step: 2,
                title: 'Tap "Automation" tab → "+" → "Personal Automation"',
                detail: 'Choose "Message" as the trigger. Set "Sender" to your bank\'s sender ID (e.g. "ComBank") or leave it set to "Any" to catch every bank SMS.',
                action_emoji: '⚡'
            },
            {
                step: 3,
                title: 'Add the "Get Contents of URL" action',
                detail: 'Tap "Add Action" → search "URL" → choose "Get Contents of URL". Configure exactly like this:',
                config: {
                    URL: webhook,
                    Method: 'POST',
                    Headers: {
                        'x-wf-device-token': token,
                        'Content-Type': 'application/json'
                    },
                    Body: 'JSON',
                    JSON_fields: {
                        sms: '[Shortcut Input]',
                        sender: '[Sender variable from Message trigger]',
                        received_at_ms: '[Current Date → unix epoch × 1000]',
                        device_id: 'iphone'
                    }
                },
                action_emoji: '🔗'
            },
            {
                step: 4,
                title: 'Toggle off "Ask Before Running" → Done',
                detail: 'This makes the shortcut fully silent. Every bank SMS now triggers an automatic POST to WealthFlow — works even when WealthFlow is closed.',
                action_emoji: '✅'
            }
        ],
        deep_links: {
            // Opens Shortcuts app on iOS. Apple does not support remote
            // import of arbitrary Shortcuts since iOS 15 (only iCloud links),
            // so we open the app and ask the user to build it from the recipe.
            open_shortcuts_app: 'shortcuts://',
            // Pre-populated "Get Contents of URL" action via iOS x-callback-url
            // (works in Shortcuts app 4+)
            prefill_action: `shortcuts://run-shortcut?name=Open%20URL&input=${encodeURIComponent(webhook)}`
        },
        notes: [
            'Apple does not allow apps (including web apps) to read SMS directly. This Shortcut uses Apple\'s own Personal Automation system to forward bank SMS — it\'s the official, supported way.',
            'Setup takes 3 minutes one time. After that, every bank SMS auto-logs into WealthFlow.',
            'No additional apps to install — Shortcuts is built into iOS.'
        ]
    };

    return new Response(JSON.stringify({ ok: true, recipe }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
