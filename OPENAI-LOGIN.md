# ChatGPT subscription login smoke test

This pass uses OpenAI's [public ChatGPT plan OAuth flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and the public Responses API through Pi. It needs no native helper or proxy. One ChatGPT account/workspace is supported per Firefox profile.

## Run

1. Run `corepack pnpm build`. In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `.output/firefox-mv2/manifest.json`. Reload an already loaded build after rebuilding.
2. Open bside's settings. Enter a PIN of 8–64 digits and choose **Continue with ChatGPT**. Complete OpenAI's sign-in and consent, including permission to use your ChatGPT plan.
3. Expect **Connected**, an account model picker, and **Test connection**. Select a model and click **Test connection**. This makes one small streamed inference request and consumes subscription usage. Success appears only after the stream completes; the conversation is untouched.
4. Open the sidebar and send a short prompt. To exercise tool calls and replay, open `tests/fixtures/agent-page.html` through a local HTTP server and ask bside to read its page text.
5. Choose **Lock**. The sidebar must stop accepting new runs, even with an API key saved. Entering a wrong PIN must leave the saved connection intact; the correct PIN unlocks it. Restarting Firefox also locks the connection.
6. Choose **Disconnect**. An unlocked session attempts remote token revocation and always deletes its local encrypted credentials. If revocation was not confirmed (including disconnecting while locked), revoke bside's access in ChatGPT settings. A separately saved API key becomes usable again.

Forgotten PIN: enter a new PIN and choose **Sign in again** to replace the saved connection after account validation. This registration stays tied to the original account/workspace; switching accounts is outside this pass.

## Callback and storage

Firefox's [`identity.launchWebAuthFlow`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow) captures `http://127.0.0.1/mozoauth2/<extension-identity>` before loading it. The fixed add-on ID keeps that path stable. OpenAI requires a `127.0.0.1` callback with the original scheme, host, and path on subsequent sign-ins. Live testing must confirm that OpenAI accepts this Firefox callback; a rejected callback is an integration failure, not a reason to copy tokens from a website or install a native listener.

All OAuth tokens, expiry, granted scopes, and account email are AES-GCM encrypted in extension `storage.local`, using a nonextractable key derived from the PIN with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt). Every write gets a fresh 12-byte IV. The PIN and encryption key are never persisted; unlocked tokens and the key live in background memory only. Registration IDs and model labels are nonsecret metadata. Website storage is unused, and content scripts/sidebar messages never receive tokens or the PIN. The existing API-key storage path is unchanged and remains unencrypted.

## Automated checks

`corepack pnpm test tests/chatgpt-auth.test.ts tests/chatgpt-provider.test.ts tests/options-ui.test.ts tests/runtime.test.ts tests/protocol.test.ts`

These use synthetic tokens and signed test identities. They cover PKCE/callback/ID-token validation, PIN encryption and restart unlock, serialized refresh rotation, local disconnect, credential isolation, subscription priority, account model validation, connection testing, and actual Pi SSE tool-call replay. They do not prove a real account can authorize this callback or infer successfully.
