# BasaltNotes for Android

A thin native app around the web interface of your own BasaltNotes server. The interface is loaded from the server, so
it always matches the server's version and contains every enabled plugin, without plugin authors doing anything.

Native parts: choosing the server, sharing from other apps, file picker, downloads, clipboard over http, back button,
system bars, error screen.

## Build

Needs JDK 17 or newer and the Android SDK (platform 36).

```bash
./gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

For a signed release, set `BASALT_KEYSTORE`, `BASALT_KEYSTORE_PASSWORD`, `BASALT_KEY_ALIAS` and `BASALT_KEY_PASSWORD`,
then run `./gradlew assembleRelease`. The version comes from the `package.json` in the main folder.

## Updates

Once a day the app asks the latest GitHub release of `Poldion/BasaltNotes` for a newer APK and offers to install it
(also: Settings → Android app → Check for updates). This is the only connection besides your server. Android installs
an update only if it carries the same signature, so builds from `assembleDebug` cannot be updated to releases.

Publishing a GitHub release makes the workflow `android-release.yml` build the signed APK and attach it. It needs these
repository secrets: `BASALT_KEYSTORE_BASE64`, `BASALT_KEYSTORE_PASSWORD`, `BASALT_KEY_ALIAS`, `BASALT_KEY_PASSWORD`.

## Offline

Offline reading uses the service worker of the web interface. Android's WebView allows it only over https, so a server
reached over plain http needs a connection.

## Plugins

Plugins run unchanged. `<a download>` with a `blob:` address, `<input type="file">` and `navigator.clipboard` work in
the app; `platform` from `@basaltnotes/plugin-sdk/web` tells a plugin whether it runs in the app.
