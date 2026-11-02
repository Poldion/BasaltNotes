package com.basaltnotes.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.OutputStream;

/**
 * Als window.BasaltApp für die Oberfläche sichtbar (siehe web/src/lib/native.ts).
 * Die Seite kommt immer vom eingestellten Server; fremde Adressen öffnen sich im Browser.
 */
class NativeBridge {
    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String version() {
        return BuildConfigInfo.versionName(activity);
    }

    @JavascriptInterface
    public String server() {
        return activity.server();
    }

    @JavascriptInterface
    public void checkUpdates() {
        activity.runOnUiThread(activity::checkUpdates);
    }

    @JavascriptInterface
    public void changeServer() {
        activity.runOnUiThread(activity::openConnect);
    }

    /** Geteilte Inhalte als JSON: { title, text, files: [{ name, type, url }] } oder null */
    @JavascriptInterface
    public String getShare() {
        return activity.shareJson();
    }

    @JavascriptInterface
    public void clearShare() {
        activity.clearShare();
    }

    @JavascriptInterface
    public void copy(String text) {
        activity.runOnUiThread(() -> activity.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("BasaltNotes", text)));
    }

    @JavascriptInterface
    public void setBars(String color) {
        activity.runOnUiThread(() -> activity.setBarColor(color));
    }

    /** Download einer im Browser erzeugten Datei (blob:), landet unter „Downloads“ */
    @JavascriptInterface
    public void saveFile(String name, String mime, String base64) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("insert");
            try (OutputStream out = resolver.openOutputStream(uri)) {
                out.write(data);
            }
            toast(activity.getString(R.string.download_saved, name));
        } catch (Exception | OutOfMemoryError e) {
            toast(activity.getString(R.string.download_failed));
        }
    }

    private void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }
}
