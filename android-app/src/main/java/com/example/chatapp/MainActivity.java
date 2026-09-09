package com.example.chatapp;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.content.SharedPreferences;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("chat_runtime", MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.WHITE);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new RuntimeBridge(), "ChatApp");
        web.loadUrl("file:///android_asset/index.html");
    }

    public class RuntimeBridge {
        @JavascriptInterface
        public String getConfig() {
            JSONObject out = new JSONObject();
            try {
                out.put("url", prefs.getString("url", ""));
                out.put("modelsUrl", prefs.getString("modelsUrl", ""));
                out.put("apiKey", prefs.getString("apiKey", ""));
                out.put("model", prefs.getString("model", ""));
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface
        public void setConfig(String json) {
            try {
                JSONObject in = new JSONObject(json == null ? "{}" : json);
                prefs.edit()
                    .putString("url", in.optString("url", ""))
                    .putString("modelsUrl", in.optString("modelsUrl", ""))
                    .putString("apiKey", in.optString("apiKey", ""))
                    .putString("model", in.optString("model", ""))
                    .apply();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void clearConfig() {
            prefs.edit().clear().apply();
        }
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
