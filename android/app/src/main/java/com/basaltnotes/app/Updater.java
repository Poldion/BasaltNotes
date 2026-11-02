package com.basaltnotes.app;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Sucht unter den GitHub-Releases nach einer neueren APK und installiert sie. Android prüft bei der Installation,
 * dass sie mit demselben Schlüssel signiert ist wie die installierte App.
 */
class Updater {
    private static final String PREF_LAST_CHECK = "update_last_check";
    private static final long CHECK_INTERVAL_MS = 24 * 3600_000L;
    private static final String APK_NAME = "update.apk";

    private final MainActivity activity;
    private long downloadId = -1;
    private Uri readyToInstall;
    private BroadcastReceiver receiver;

    Updater(MainActivity activity) {
        this.activity = activity;
    }

    /** Beim Start, höchstens einmal am Tag und still, wenn es nichts Neues gibt */
    void checkDaily() {
        long now = System.currentTimeMillis();
        if (now - MainActivity.prefs(activity).getLong(PREF_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return;
        MainActivity.prefs(activity).edit().putLong(PREF_LAST_CHECK, now).apply();
        check(false);
    }

    void check(boolean manual) {
        new Thread(() -> {
            try {
                JSONObject release = fetchLatest();
                String version = release.getString("tag_name").replaceFirst("^v", "");
                String url = apkUrl(release);
                activity.runOnUiThread(() -> {
                    if (url != null && isNewer(version, BuildConfigInfo.versionName(activity))) offer(version, url);
                    else if (manual) toast(activity.getString(R.string.update_none));
                });
            } catch (Exception e) {
                if (manual) activity.runOnUiThread(() -> toast(activity.getString(R.string.update_failed)));
            }
        }).start();
    }

    private JSONObject fetchLatest() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BuildConfig.UPDATE_API).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "BasaltNotesApp");
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            StringBuilder body = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) body.append(line);
            }
            return new JSONObject(body.toString());
        } finally {
            c.disconnect();
        }
    }

    /** Nur Dateien aus dem eigenen Release-Bereich */
    private static String apkUrl(JSONObject release) throws Exception {
        JSONArray assets = release.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            String url = asset.getString("browser_download_url");
            if (asset.getString("name").endsWith(".apk") && url.startsWith(BuildConfig.UPDATE_DOWNLOAD_PREFIX)) return url;
        }
        return null;
    }

    static boolean isNewer(String candidate, String current) {
        String[] a = candidate.split("\\.");
        String[] b = current.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? number(a[i]) : 0;
            int y = i < b.length ? number(b[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int number(String part) {
        try {
            return Integer.parseInt(part);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void offer(String version, String url) {
        if (activity.isFinishing()) return;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title, version))
                .setMessage(R.string.update_message)
                .setPositiveButton(R.string.update_install, (d, w) -> download(url))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private void download(String url) {
        File old = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);
        if (old.exists()) old.delete();
        DownloadManager dm = activity.getSystemService(DownloadManager.class);
        if (receiver == null) {
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) == downloadId) downloaded();
                }
            };
            IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            else activity.registerReceiver(receiver, filter);
        }
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        r.setTitle(activity.getString(R.string.app_name));
        r.setMimeType("application/vnd.android.package-archive");
        r.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, APK_NAME);
        downloadId = dm.enqueue(r);
        toast(activity.getString(R.string.update_downloading));
    }

    private void downloaded() {
        DownloadManager dm = activity.getSystemService(DownloadManager.class);
        boolean ok = false;
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (c != null && c.moveToFirst()) ok = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL;
        }
        if (!ok) {
            toast(activity.getString(R.string.update_failed));
            return;
        }
        readyToInstall = dm.getUriForDownloadedFile(downloadId);
        installIfAllowed();
    }

    /** Erstes Update: Android fragt einmalig, ob die App installieren darf; danach geht es in onResume weiter */
    private void installIfAllowed() {
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(readyToInstall, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        readyToInstall = null;
        activity.startActivity(install);
    }

    void onResume() {
        if (readyToInstall != null && activity.getPackageManager().canRequestPackageInstalls()) installIfAllowed();
    }

    void onDestroy() {
        if (receiver != null) activity.unregisterReceiver(receiver);
        receiver = null;
    }

    private void toast(String text) {
        Toast.makeText(activity, text, Toast.LENGTH_LONG).show();
    }
}
