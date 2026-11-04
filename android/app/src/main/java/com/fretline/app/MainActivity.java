package com.fretline.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Back button: let the app go back one step (close a sheet, leave the
        // tuner editor…). At the home screen, minimize instead of closing.
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
}
