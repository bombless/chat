package com.example.chatapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.graphics.Color;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.journeyapps.barcodescanner.ScanOptions;
import com.journeyapps.barcodescanner.ScanIntentResult;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.MGF1ParameterSpec;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;

public class MainActivity extends Activity {
    private static final String TAG = "ConfigTransfer";
    private static final String PREFS = "chat_runtime";
    private static final String SECURE_VALUE = "config_secure_v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "chat_runtime_config_key";
    private static final int TIMEOUT_MS = 10000;

    private WebView web;
    private SharedPreferences prefs;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private PrivateKey transferPrivateKey;
    private String transferToken;
    private AlertDialog pairingDialog;
    private final ArrayDeque<String> transferDebugLog = new ArrayDeque<>();

    private void transferLog(String level, String message) {
        String line = android.text.format.DateFormat.format("HH:mm:ss", System.currentTimeMillis()) + " " + level + " " + message;
        synchronized (transferDebugLog) {
            while (transferDebugLog.size() >= 100) transferDebugLog.removeFirst();
            transferDebugLog.addLast(line);
        }
        if ("E".equals(level)) Log.e(TAG, message); else if ("W".equals(level)) Log.w(TAG, message); else Log.i(TAG, message);
    }

    private String getTransferDebugLog() {
        StringBuilder out = new StringBuilder();
        synchronized (transferDebugLog) { for (String line : transferDebugLog) out.append(line).append('\n'); }
        if (out.length() == 0) out.append("尚无诊断日志。请先执行一次操作。\n");
        JSONObject config = readSecureConfig();
        out.append("保存的配置：").append(config == null ? "无" : "已保存")
            .append("；URL=").append(config == null ? "" : config.optString("url", ""))
            .append("；Models URL=").append(config == null ? "" : config.optString("modelsUrl", ""))
            .append("；Model=").append(config == null ? "" : config.optString("model", ""))
            .append("；API Key=").append(config != null && !config.optString("apiKey").isEmpty()).append('\n');
        return out.toString();
    }

    private void clearTransferDebugLog() {
        synchronized (transferDebugLog) { transferDebugLog.clear(); }
        transferLog("I", "诊断日志已清空");
    }

    private void appendTransferDebugLog(String message) { transferLog("I", message); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.WHITE);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                String line = "WebView " + message.messageLevel() + " " + message.sourceId() + ":" + message.lineNumber() + " " + message.message();
                transferLog(message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? "E" : "I", line);
                return true;
            }
        });
        web.addJavascriptInterface(new RuntimeBridge(), "ChatApp");
        web.loadUrl("file:///android_asset/index.html");
    }

    public class RuntimeBridge {
        @JavascriptInterface public String getConfig() {
            JSONObject out = new JSONObject();
            try {
                JSONObject saved = readSecureConfig();
                if (saved == null) {
                    saved = new JSONObject();
                    saved.put("url", prefs.getString("url", ""));
                    saved.put("modelsUrl", prefs.getString("modelsUrl", ""));
                    saved.put("apiKey", prefs.getString("apiKey", ""));
                    saved.put("model", prefs.getString("model", ""));
                    if (saved.optString("apiKey", "").length() > 0) writeSecureConfig(saved);
                }
                out = saved;
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface public void setConfig(String json) {
            try {
                JSONObject in = new JSONObject(json == null ? "{}" : json);
                writeSecureConfig(normalizeConfig(in));
                prefs.edit().remove("url").remove("modelsUrl").remove("apiKey").remove("model").apply();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface public void importConfig() {
            runOnUiThread(() -> {
                new com.google.zxing.integration.android.IntentIntegrator(MainActivity.this)
                    .setPrompt("扫描电脑端配置迁移二维码")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
                    .initiateScan();
            });
        }

        @JavascriptInterface public String getTransferDebugLog() { return MainActivity.this.getTransferDebugLog(); }
        @JavascriptInterface public void clearTransferDebugLog() { MainActivity.this.clearTransferDebugLog(); }
        @JavascriptInterface public void appendTransferDebugLog(String message) { MainActivity.this.appendTransferDebugLog(message); }

        @JavascriptInterface public void clearConfig() {
            prefs.edit().clear().apply();
            try {
                KeyStore ks = KeyStore.getInstance(KEYSTORE);
                ks.load(null);
                if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
            } catch (Exception ignored) {}
        }
    }

    private JSONObject normalizeConfig(JSONObject in) throws Exception {
        JSONObject out = new JSONObject();
        out.put("url", in.optString("url", ""));
        out.put("modelsUrl", in.optString("modelsUrl", ""));
        out.put("apiKey", in.optString("apiKey", ""));
        out.put("model", in.optString("model", ""));
        return out;
    }

    private SecretKey getLocalKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance("AES", KEYSTORE);
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    private void writeSecureConfig(JSONObject config) throws Exception {
        SecretKey key = getLocalKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // Android Keystore requires the provider to generate a fresh IV for
        // randomized AES-GCM encryption. Persist that IV with the ciphertext.
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString(SECURE_VALUE, Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP)).apply();
    }

    private JSONObject readSecureConfig() {
        try {
            String value = prefs.getString(SECURE_VALUE, "");
            if (value.isEmpty()) return null;
            String[] parts = value.split(":", 2);
            SecretKey key = getLocalKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        com.google.zxing.integration.android.IntentResult result = com.google.zxing.integration.android.IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            String contents = result.getContents();
            if (contents == null) return;
            onScannedContents(contents);
        }
    }

    private void onScannedContents(String contents) {
        String scanned = contents == null ? "" : contents.trim();
        transferLog("I", "QR scanned");
        Uri uri = Uri.parse(scanned);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        int port = uri.getPort();
        String token = uri.getQueryParameter("t");
        if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                || host == null || host.isEmpty() || (port != -1 && (port < 1 || port > 65535))
                || token == null || token.length() < 32) {
            Toast.makeText(this, "二维码不是有效的配置迁移地址", Toast.LENGTH_SHORT).show();
            return;
        }
        transferToken = token;
        transferLog("I", "Starting transfer host=" + host + ", port=" + port + ", tokenLength=" + token.length());
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
            gen.initialize(2048);
            KeyPair pair = gen.generateKeyPair();
            transferPrivateKey = pair.getPrivate();
            String publicKey = Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP);
            String base = scheme + "://" + host + (port == -1 ? "" : ":" + port);
            joinTransfer(base, token, publicKey);
        } catch (Exception e) {
            showError("无法建立安全连接：" + e.getMessage());
        }
    }

    private void joinTransfer(String base, String token, String publicKey) {
        io.execute(() -> {
            try {
                transferLog("I", "Joining transfer: " + base + ", tokenLength=" + token.length());
                JSONObject body = new JSONObject(); body.put("token", token); body.put("publicKey", publicKey);
                HttpResult r = request("POST", base + "/api/config-transfer/join", body.toString());
                transferLog("I", "Join response: HTTP " + r.code + ", hasCode=" + r.json.has("code"));
                if (r.code / 100 != 2) throw new Exception(r.json.optString("error", "连接失败"));
                String code = r.json.optString("code", "");
                runOnUiThread(() -> showPairingCode(base, token, code));
                pollForConfig(base, token);
            } catch (Exception e) { transferLog("E", "Join failed: " + e); Log.e(TAG, "Join failed", e); showError("连接失败：" + e.getMessage()); }
        });
    }

    private void showPairingCode(String base, String token, String code) {
        transferLog("I", "Showing pairing dialog, codeLength=" + code.length());
        if (pairingDialog != null) pairingDialog.dismiss();
        pairingDialog = new AlertDialog.Builder(this)
            .setTitle("检测到电脑配置迁移")
            .setMessage("连接验证码\n\n" + code + "\n\n请在电脑端输入这个验证码。")
            .setNegativeButton("取消", (d, w) -> { transferToken = null; transferPrivateKey = null; })
            .create();
        pairingDialog.setOnDismissListener(d -> {
            transferLog("I", "Pairing dialog dismissed by user/system");
            if (pairingDialog != null && !pairingDialog.isShowing()) pairingDialog = null;
        });
        pairingDialog.show();
        transferLog("I", "Pairing dialog shown=" + pairingDialog.isShowing());
    }

    private void pollForConfig(String base, String token) {
        for (int i = 0; i < 300 && token.equals(transferToken); i++) {
            try {
                Thread.sleep(1000);
                HttpResult r = request("GET", base + "/api/config-transfer/config?t=" + Uri.encode(token), null);
                if (r.code != 403) transferLog("I", "Config poll response: HTTP " + r.code);
                if (r.code == 200) {
                    transferLog("I", "Config payload received; decrypting");
                    JSONObject config = decryptTransfer(r.json);
                    transferLog("I", "Config decrypted; writing secure config");
                    writeSecureConfig(normalizeConfig(config));
                    prefs.edit().remove("url").remove("modelsUrl").remove("apiKey").remove("model").apply();
                    runOnUiThread(() -> {
                        transferLog("I", "Import success UI; dialog=" + (pairingDialog == null ? "null" : ("showing=" + pairingDialog.isShowing())));
                        if (pairingDialog != null) {
                            pairingDialog.dismiss();
                            pairingDialog = null;
                            transferLog("I", "Pairing dialog dismissed");
                        }
                        transferToken = null; transferPrivateKey = null;
                        new AlertDialog.Builder(this).setTitle("配置导入成功").setMessage("Provider 配置已经安全保存。")
                            .setPositiveButton("完成", (d,w) -> web.reload()).show();
                    });
                    return;
                }
                if (r.code == 410 || r.code == 404) { showError("迁移会话已过期，请重新扫码"); return; }
            } catch (Exception e) {
                transferLog("E", "Config import failed: " + e);
                Log.e(TAG, "Config import failed", e);
                if (token.equals(transferToken)) {
                    transferToken = null;
                    transferPrivateKey = null;
                    runOnUiThread(() -> {
                        if (pairingDialog != null) { pairingDialog.dismiss(); pairingDialog = null; }
                        new AlertDialog.Builder(this).setTitle("配置导入失败")
                            .setMessage("配置已经从电脑收到，但无法安全保存：" + e.getMessage())
                            .setPositiveButton("关闭", null).show();
                    });
                }
                return;
            }
        }
        if (token.equals(transferToken)) {
            transferLog("W", "Config transfer timed out");
            runOnUiThread(() -> {
                if (pairingDialog != null) { pairingDialog.dismiss(); pairingDialog = null; }
            });
            showError("配置迁移超时，请重新扫码");
        }
    }

    private JSONObject decryptTransfer(JSONObject encrypted) throws Exception {
        byte[] encryptedKey = Base64.decode(encrypted.getString("encryptedKey"), Base64.DEFAULT);
        OAEPParameterSpec oaep = new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);
        Cipher rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        rsa.init(Cipher.DECRYPT_MODE, transferPrivateKey, oaep);
        byte[] aesKey = rsa.doFinal(encryptedKey);
        Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = Base64.decode(encrypted.getString("iv"), Base64.DEFAULT);
        byte[] tag = Base64.decode(encrypted.getString("tag"), Base64.DEFAULT);
        byte[] ciphertext = Base64.decode(encrypted.getString("ciphertext"), Base64.DEFAULT);
        byte[] combined = new byte[ciphertext.length + tag.length];
        System.arraycopy(ciphertext, 0, combined, 0, ciphertext.length); System.arraycopy(tag, 0, combined, ciphertext.length, tag.length);
        aes.init(Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(aesKey, "AES"), new GCMParameterSpec(128, iv));
        return new JSONObject(new String(aes.doFinal(combined), StandardCharsets.UTF_8));
    }

    private static class HttpResult { int code; JSONObject json; HttpResult(int c, JSONObject j){code=c;json=j;} }
    private HttpResult request(String method, String urlText, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlText).openConnection();
        c.setRequestMethod(method); c.setConnectTimeout(TIMEOUT_MS); c.setReadTimeout(TIMEOUT_MS); c.setDoInput(true);
        if (body != null) { c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); try(OutputStream out=c.getOutputStream()){out.write(body.getBytes(StandardCharsets.UTF_8));} }
        int code=c.getResponseCode(); InputStream in=code>=400?c.getErrorStream():c.getInputStream(); StringBuilder sb=new StringBuilder();
        if(in!=null){try(BufferedReader br=new BufferedReader(new InputStreamReader(in,StandardCharsets.UTF_8))){String line;while((line=br.readLine())!=null)sb.append(line);}}
        c.disconnect(); return new HttpResult(code,new JSONObject(sb.length()==0?"{}":sb.toString()));
    }

    private void showError(String message) { runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show()); }

    @Override protected void onDestroy() { io.shutdownNow(); transferPrivateKey = null; transferToken = null; if (pairingDialog != null) pairingDialog.dismiss(); if (web != null) web.destroy(); super.onDestroy(); }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
