package com.fretline.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge is created.
        registerPlugin(LessonInfoPlugin.class);
        registerPlugin(TabScanPlugin.class);
        super.onCreate(savedInstanceState);
        handleShare(getIntent());

        // Back button: let the app go back one step (close a sheet, leave a
        // lesson…). At the home screen, minimize instead of closing.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "(window.fretlineBack && window.fretlineBack()) ? 'handled' : 'root'",
                    result -> {
                        if (!"\"handled\"".equals(result)) moveTaskToBack(true);
                    }
                );
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    /**
     * A link shared to Fretline: hand it to the app (window.fretlineShare),
     * waiting for the page to be ready when Fretline was just opened by it.
     */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return;
        intent.setAction(Intent.ACTION_MAIN); // don't handle it again on rotate
        deliverShare(org.json.JSONObject.quote(text), 0);
    }

    private void deliverShare(String quoted, int attempt) {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null || attempt > 40) {
            if (attempt <= 40) new Handler(Looper.getMainLooper()).postDelayed(() -> deliverShare(quoted, attempt + 1), 500);
            return;
        }
        webView.evaluateJavascript(
            "(window.fretlineShare ? (window.fretlineShare(" + quoted + "), 'ok') : 'wait')",
            result -> {
                if (!"\"ok\"".equals(result)) {
                    new Handler(Looper.getMainLooper()).postDelayed(() -> deliverShare(quoted, attempt + 1), 500);
                }
            }
        );
    }
}
