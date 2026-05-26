/**
 * notarize-afterSign — electron-builder afterSign hook.
 *
 * Runs AFTER the .app is signed but BEFORE the DMG is created. Submits
 * the .app to Apple's notary service, waits for the Accepted verdict,
 * and staples the ticket to the .app. As a result, the .app that gets
 * packaged INSIDE the DMG already carries its notarization ticket — no
 * post-hoc hdiutil mount/staple/repack dance required, and no Gatekeeper
 * "developer cannot be verified" warning at first launch.
 *
 * This is the canonical Electron pattern. Without it, you have to do
 * the recursive notarize-mount-staple-repack-renotarize sequence that
 * we did manually for v1.4.2 (search this repo's git log for "ec06371d").
 *
 * Credential resolution order (matches scripts/notarize-mac.sh so the
 * dev only has to set things up once):
 *   1. APPLE_KEYCHAIN_PROFILE env var → keychain-stored profile (preferred)
 *   2. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID env vars
 *   3. Sensible defaults pointing at the `veronum-notary` keychain profile
 *
 * Skip conditions (returns early without error):
 *   • Not running on macOS — notarization is mac-only
 *   • SKIP_NOTARIZE=1 env var set — for fast local rebuilds where you
 *     don't want to spend 5–15 min on every package run
 *   • Non-darwin electron platform
 */

const { notarize } = require("@electron/notarize");
const path = require("path");

const DEFAULT_KEYCHAIN_PROFILE = "veronum-notary";
const DEFAULT_TEAM_ID = "YNZLTKWB83";

module.exports = async function afterSign(context) {
  // Skip on non-mac builds (Windows / Linux passes through unchanged).
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  // Escape hatch: dev iterating on local builds can `SKIP_NOTARIZE=1
  // npm run package:mac` to avoid the 5–15 min notarization round trip.
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize-afterSign] SKIP_NOTARIZE=1 set — skipping.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Credential resolution.
  const keychainProfile =
    process.env.APPLE_KEYCHAIN_PROFILE || DEFAULT_KEYCHAIN_PROFILE;
  const hasKeychain = Boolean(keychainProfile);
  const hasEnvCreds =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD;

  if (!hasKeychain && !hasEnvCreds) {
    console.warn(
      "[notarize-afterSign] No credentials available.\n" +
        "  Either set APPLE_KEYCHAIN_PROFILE (recommended) or all of\n" +
        "  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.\n" +
        "  Skipping notarization — DMG WILL trigger Gatekeeper warnings.",
    );
    return;
  }

  console.log(
    `[notarize-afterSign] Notarizing ${appName}.app (this takes 5–15 minutes for Apple's verdict)`,
  );

  // @electron/notarize accepts either keychain-profile OR appleId+
  // password+teamId. Pass whichever set is fully populated.
  const notarizeArgs = {
    appPath,
    tool: "notarytool",
  };
  if (hasKeychain) {
    notarizeArgs.keychainProfile = keychainProfile;
  } else {
    notarizeArgs.appleId = process.env.APPLE_ID;
    notarizeArgs.appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
    notarizeArgs.teamId = process.env.APPLE_TEAM_ID || DEFAULT_TEAM_ID;
  }

  try {
    await notarize(notarizeArgs);
    console.log(
      `[notarize-afterSign] ✓ ${appName}.app notarized + stapled. ` +
        "The DMG that electron-builder packages next will contain a " +
        "fully-vouched-for .app, so Gatekeeper accepts silently on first launch.",
    );
  } catch (err) {
    console.error("[notarize-afterSign] ✗ notarization failed:", err.message);
    // Throw so the build fails — shipping an un-notarized DMG would
    // regress the user-visible install experience and we'd rather
    // catch it loudly here than discover it via support tickets.
    throw err;
  }
};
