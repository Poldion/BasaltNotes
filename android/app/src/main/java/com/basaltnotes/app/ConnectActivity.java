package com.basaltnotes.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Erster Start und „Server wechseln“: Adresse eingeben und prüfen, ob dort ein BasaltNotes-Server antwortet. */
public class ConnectActivity extends Activity {
    private EditText address;
    private Button connect;
    private TextView status;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_connect);
        address = findViewById(R.id.address);
        connect = findViewById(R.id.connect);
        status = findViewById(R.id.status);
        applyInsets(findViewById(R.id.root));

        String current = MainActivity.prefs(this).getString(MainActivity.PREF_SERVER, null);
        if (current != null) address.setText(current);
        connect.setOnClickListener(v -> check());
        address.setOnEditorActionListener((v, action, e) -> {
            if (action != EditorInfo.IME_ACTION_GO) return false;
            check();
            return true;
        });
    }

    private void applyInsets(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    @Override
    public void onBackPressed() {
        // Beim Wechseln zurück zum bisherigen Server, beim ersten Start die App verlassen
        if (MainActivity.prefs(this).getString(MainActivity.PREF_SERVER, null) != null) startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private void check() {
        String input = address.getText().toString().trim().replaceAll("/+$", "");
        if (input.isEmpty()) {
            status.setText(R.string.connect_invalid);
            return;
        }
        connect.setEnabled(false);
        status.setText(R.string.connect_checking);
        new Thread(() -> {
            try {
                String origin = findServer(input);
                runOnUiThread(() -> done(origin));
            } catch (Exception e) {
                String message = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                runOnUiThread(() -> {
                    connect.setEnabled(true);
                    status.setText(getString(R.string.connect_failed, message));
                });
            }
        }).start();
    }

    /** Ohne Angabe des Protokolls zuerst https, dann http */
    private String findServer(String input) throws Exception {
        if (input.matches("(?i)^https?://.*")) return probe(input, 0);
        try {
            return probe("https://" + input, 0);
        } catch (IOException e) {
            return probe("http://" + input, 0);
        }
    }

    /** Gibt den Ursprung (Protokoll, Host, Port) zurück, unter dem der Server tatsächlich antwortet */
    private String probe(String url, int redirects) throws Exception {
        Uri uri = Uri.parse(url);
        if (uri.getHost() == null || uri.getHost().isEmpty()) throw new IOException(getString(R.string.connect_invalid));
        String origin = uri.getScheme().toLowerCase() + "://" + uri.getEncodedAuthority();
        HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/v1/health").openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setInstanceFollowRedirects(false);
        try {
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && redirects < 5 && c.getHeaderField("Location") != null) {
                return probe(new URL(new URL(origin), c.getHeaderField("Location")).toString(), redirects + 1);
            }
            if (code != 200) throw new IOException("HTTP " + code);
            StringBuilder body = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) body.append(line);
            }
            if (!new JSONObject(body.toString()).has("version")) throw new IOException("/api/v1/health");
            return origin;
        } finally {
            c.disconnect();
        }
    }

    private void done(String origin) {
        MainActivity.prefs(this).edit().putString(MainActivity.PREF_SERVER, origin).remove(MainActivity.PREF_LAST_URL).apply();
        // Eine geteilte Eingabe vom ersten Start bleibt erhalten
        Intent next = new Intent(getIntent()).setClass(this, MainActivity.class);
        startActivity(next);
        finish();
    }
}
