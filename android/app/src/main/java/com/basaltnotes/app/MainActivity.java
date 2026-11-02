package com.basaltnotes.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.List;

/**
 * Die Oberfläche kommt vom eigenen Server – damit ist sie immer die passende Version und enthält alle
 * eingeschalteten Plugins. Nativ sind nur die Stellen, an denen ein WebView das Gerät nicht von selbst erreicht.
 */
public class MainActivity extends Activity {
    static final String PREF_SERVER = "server";
    static final String PREF_LAST_URL = "last_url";
    /** Unter diesem Pfad liest die Oberfläche geteilte Dateien (fängt die App ab, geht nie an den Server) */
    private static final String SHARE_PATH = "/__native/share/";
    private static final int REQUEST_FILES = 1;
    private static final long LOAD_TIMEOUT_MS = 15000;

    private WebView web;
    private View errorView;
    private TextView errorDetail;
    private View root;
    private String server;
    private ValueCallback<Uri[]> fileCallback;
    private View loading;
    private Updater updater;
    private boolean failed;
    /** Ein nicht erreichbarer Host kann minutenlang ohne Fehler hängen */
    private final Runnable loadTimeout = () -> showError(server);

    private volatile String shareTitle;
    private volatile String shareText;
    private volatile List<Uri> shareFiles = new ArrayList<>();

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("basalt", MODE_PRIVATE);
    }

    String server() {
        return server;
    }

    void checkUpdates() {
        updater.check(true);
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        server = prefs(this).getString(PREF_SERVER, null);
        if (server == null) {
            startActivity(new Intent(getIntent()).setClass(this, ConnectActivity.class));
            finish();
            return;
        }
        setContentView(R.layout.activity_main);
        root = findViewById(R.id.root);
        web = findViewById(R.id.web);
        errorView = findViewById(R.id.error);
        errorDetail = findViewById(R.id.error_detail);
        loading = findViewById(R.id.loading);
        findViewById(R.id.error_retry).setOnClickListener(v -> {
            String url = web.getUrl();
            load(url != null && url.startsWith("http") ? url : server + "/");
        });
        findViewById(R.id.error_change).setOnClickListener(v -> openConnect());
        applyInsets();
        // Bis die Oberfläche geladen ist und ihre Farben meldet
        int window = getColor(R.color.window);
        web.setBackgroundColor(window);
        setBarColor(String.format("#%06x", window & 0xffffff));
        setupWeb();
        registerBack();
        updater = new Updater(this);
        if (!BuildConfig.DEBUG) updater.checkDaily();

        if (!readShare(getIntent())) {
            String last = prefs(this).getString(PREF_LAST_URL, null);
            load(last != null && isInternal(Uri.parse(last)) ? last : server + "/");
        } else {
            load(server + "/p/share");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web != null && readShare(intent)) load(server + "/p/share");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updater != null) updater.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web == null) return;
        CookieManager.getInstance().flush();
        if (!failed && web.getUrl() != null) prefs(this).edit().putString(PREF_LAST_URL, web.getUrl()).apply();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeCallbacks(loadTimeout);
            updater.onDestroy();
            web.destroy();
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ Fenster

    private void applyInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    /** Farbe der Systemleisten passend zum Farbschema der Oberfläche */
    void setBarColor(String color) {
        int c;
        try {
            c = Color.parseColor(color);
        } catch (IllegalArgumentException e) {
            return;
        }
        root.setBackgroundColor(c);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller == null) return;
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        controller.setSystemBarsAppearance(Color.luminance(c) > 0.5f ? light : 0, light);
    }

    private void registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    /** Zuerst schließt die Oberfläche Dialoge und Seitenleiste, dann geht es im Verlauf zurück */
    private void handleBack() {
        web.evaluateJavascript("window.basaltBack ? window.basaltBack() : false", result -> {
            if ("true".equals(result)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    void openConnect() {
        prefs(this).edit().remove(PREF_LAST_URL).apply();
        startActivity(new Intent(this, ConnectActivity.class));
        finish();
    }

    // ------------------------------------------------------------ WebView

    private void setupWeb() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " BasaltNotesApp/" + BuildConfigInfo.versionName(this));
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new NativeBridge(this), "BasaltApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(this::download);
        // Anfragen, die durch den Service Worker laufen, müssen die geteilten Dateien ebenfalls finden
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return shareResponse(request.getUrl());
            }
        });
    }

    /** Fremde Adressen öffnet der Browser. Gleicher Host mit anderem Protokoll zählt mit (Umleitung auf https). */
    private boolean isInternal(Uri uri) {
        Uri base = Uri.parse(server);
        if (base.getHost() == null || !base.getHost().equalsIgnoreCase(uri.getHost())) return false;
        return base.getPort() == uri.getPort() || !String.valueOf(base.getScheme()).equalsIgnoreCase(uri.getScheme());
    }

    private void load(String url) {
        failed = false;
        errorView.setVisibility(View.GONE);
        loading.setVisibility(View.VISIBLE);
        root.removeCallbacks(loadTimeout);
        root.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        web.loadUrl(url);
    }

    private void showError(String detail) {
        failed = true;
        root.removeCallbacks(loadTimeout);
        loading.setVisibility(View.GONE);
        errorDetail.setText(detail);
        errorView.setVisibility(View.VISIBLE);
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isInternal(uri)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, R.string.no_app, Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return shareResponse(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            failed = false;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            // Kommt nur bei einer tatsächlich geladenen Seite, nicht bei der eingebauten Fehlerseite
            if (failed) return;
            root.removeCallbacks(loadTimeout);
            loading.setVisibility(View.GONE);
            errorView.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(server + "\n" + error.getDescription());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showError(server + "\nHTTP " + response.getStatusCode());
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (error.getUrl() != null && error.getUrl().equals(view.getUrl()) || view.getProgress() < 100) showError(getString(R.string.error_ssl));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            recreate();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQUEST_FILES);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_app, Toast.LENGTH_SHORT).show();
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != REQUEST_FILES || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        fileCallback = null;
    }

    /** Dateien vom Server laden (Anhänge, Exporte) – die Anmeldung geht als Cookie mit */
    private void download(String url, String userAgent, String contentDisposition, String mime, long length) {
        // Im Browser erzeugte Dateien fängt die Oberfläche selbst ab (NativeBridge.saveFile)
        if (!url.startsWith("http")) return;
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setMimeType(mime);
            r.setTitle(name);
            r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            r.addRequestHeader("User-Agent", userAgent);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            getSystemService(DownloadManager.class).enqueue(r);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // ------------------------------------------------------------ Teilen aus anderen Apps

    private boolean readShare(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        List<Uri> files = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) files.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) files.add(one);
        }
        shareTitle = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        shareText = text != null ? text.toString() : null;
        shareFiles = files;
        // Nicht erneut auswerten, wenn das Fenster neu aufgebaut wird
        intent.setAction(Intent.ACTION_MAIN);
        return shareText != null || !files.isEmpty();
    }

    String shareJson() {
        List<Uri> files = shareFiles;
        if (shareText == null && files.isEmpty()) return null;
        try {
            JSONArray list = new JSONArray();
            for (int i = 0; i < files.size(); i++) {
                Uri uri = files.get(i);
                String type = getContentResolver().getType(uri);
                list.put(new JSONObject().put("name", displayName(uri)).put("type", type != null ? type : "application/octet-stream").put("url", SHARE_PATH + i));
            }
            return new JSONObject().put("title", shareTitle != null ? shareTitle : JSONObject.NULL).put("text", shareText != null ? shareText : JSONObject.NULL).put("files", list).toString();
        } catch (JSONException e) {
            return null;
        }
    }

    void clearShare() {
        shareTitle = null;
        shareText = null;
        shareFiles = new ArrayList<>();
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (RuntimeException e) {
            // Name bleibt unbekannt
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "file";
    }

    private WebResourceResponse shareResponse(Uri url) {
        String path = url.getPath();
        if (path == null || !path.startsWith(SHARE_PATH) || !isInternal(url)) return null;
        try {
            Uri file = shareFiles.get(Integer.parseInt(path.substring(SHARE_PATH.length())));
            String type = getContentResolver().getType(file);
            return new WebResourceResponse(type != null ? type : "application/octet-stream", null, getContentResolver().openInputStream(file));
        } catch (FileNotFoundException | RuntimeException e) {
            return new WebResourceResponse("text/plain", null, 404, "Not Found", null, null);
        }
    }
}
