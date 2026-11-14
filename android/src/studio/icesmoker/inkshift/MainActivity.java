package studio.icesmoker.inkshift;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.Locale;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ENTRY = "https://" + HOST + "/index.html";
    private static final String SERVER_SETTINGS = "https://" + HOST + "/__cloud_server";
    private static final String SERVER_PREFERENCE = "inkshift-cloud-origin";
    private static final Pattern ASSET_PATH = Pattern.compile("/[a-zA-Z0-9][a-zA-Z0-9._-]*");
    private WebView game;
    private volatile String cloudOrigin;
    private volatile boolean cloudActive;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cloudOrigin = httpsOrigin(getPreferences(MODE_PRIVATE).getString(SERVER_PREFERENCE, ""));
        game = new WebView(this);
        game.setBackgroundColor(0xff111c20);
        WebSettings settings = game.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setUserAgentString(settings.getUserAgentString() + " InkShiftAndroid/1.3");
        game.setOnLongClickListener(view -> true);
        game.setWebViewClient(new BundledGame());
        setContentView(game);
        enterFullscreen();
        loadGame(cloudOrigin != null);
    }

    private static String httpsOrigin(String submitted) {
        try {
            URI url = new URI(submitted.trim());
            String host = url.getHost();
            int port = url.getPort();
            if (!"https".equalsIgnoreCase(url.getScheme()) || host == null
                    || HOST.equalsIgnoreCase(host) || port == 0 || port > 65535
                    || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null
                    || !("".equals(url.getPath()) || "/".equals(url.getPath()))) return null;
            return "https://" + host.toLowerCase(Locale.ROOT) + (port < 0 || port == 443 ? "" : ":" + port);
        } catch (URISyntaxException error) {
            return null;
        }
    }

    private void loadGame(boolean cloud) {
        cloudActive = cloud && cloudOrigin != null;
        game.stopLoading();
        game.loadUrl(cloudActive ? cloudOrigin + "/" : ENTRY);
    }

    private boolean isCloudOrigin(Uri url) {
        String origin = cloudOrigin, host = url.getHost();
        int port = url.getPort();
        return origin != null && host != null && url.getUserInfo() == null && "https".equalsIgnoreCase(url.getScheme())
                && origin.equals("https://" + host.toLowerCase(Locale.ROOT) + (port < 0 || port == 443 ? "" : ":" + port));
    }

    private void chooseServer() {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("https://inkshift.example.workers.dev");
        if (cloudOrigin != null) field.setText(cloudOrigin);
        FrameLayout form = new FrameLayout(this);
        int inset = Math.round(24 * getResources().getDisplayMetrics().density);
        form.setPadding(inset, 0, inset, 0);
        form.addView(field);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Cloudflare接続先")
                .setMessage("デプロイしたゲームのHTTPS URLを入力してください。接続キーはゲーム開始時に入力します。")
                .setView(form)
                .setPositiveButton("接続", null)
                .setNeutralButton("端末内で遊ぶ", (box, button) -> {
                    cloudOrigin = null;
                    getPreferences(MODE_PRIVATE).edit().remove(SERVER_PREFERENCE).apply();
                    loadGame(false);
                })
                .setNegativeButton("閉じる", null)
                .create();
        dialog.setOnShowListener(event -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = httpsOrigin(field.getText().toString());
            if (value == null) {
                field.setError("HTTPSのゲームURLを入力してください");
                return;
            }
            cloudOrigin = value;
            getPreferences(MODE_PRIVATE).edit().putString(SERVER_PREFERENCE, value).apply();
            dialog.dismiss();
            loadGame(true);
        }));
        dialog.show();
    }

    private void enterFullscreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController bars = getWindow().getInsetsController();
            if (bars != null) {
                bars.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                bars.hide(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) enterFullscreen();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (game != null) game.onResume();
        enterFullscreen();
    }

    @Override
    protected void onPause() {
        if (game != null) game.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        game.evaluateJavascript(
                "(function(){if(!document.querySelector('#game.in-battle'))return false;"
                + "document.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape'}));return true;})()",
                handled -> {
                    if (!"true".equals(handled)) finish();
                });
    }

    @Override
    protected void onDestroy() {
        if (game != null) {
            setContentView(new View(this));
            game.destroy();
            game = null;
        }
        super.onDestroy();
    }

    private final class BundledGame extends WebViewClient {
        private boolean interceptNavigation(Uri url, boolean mainFrame) {
            if (mainFrame && SERVER_SETTINGS.equals(url.toString())) {
                chooseServer();
                return true;
            }
            return cloudActive ? !isCloudOrigin(url) : !isBundledOrigin(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return interceptNavigation(request.getUrl(), request.isForMainFrame());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return interceptNavigation(Uri.parse(url), true);
        }

        private void reportUnavailable(Uri url) {
            if (!cloudActive || !isCloudOrigin(url)) return;
            loadGame(false);
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Cloudflare接続エラー")
                    .setMessage("配信先に接続できませんでした。タイトルの「Cloudflare接続先」から設定を確認できます。")
                    .setPositiveButton("閉じる", null).show();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) reportUnavailable(request.getUrl());
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (failingUrl != null) reportUnavailable(Uri.parse(failingUrl));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) reportUnavailable(request.getUrl());
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (cloudActive && isCloudOrigin(url)) return null;
            String path = url.getPath();
            if (isBundledOrigin(url) && path != null && ASSET_PATH.matcher(path).matches()
                    && !path.contains("..") && "GET".equals(request.getMethod())) {
                try {
                    InputStream data = getAssets().open("web" + path);
                    String type = mimeType(path);
                    String charset = type.startsWith("text/") || type.startsWith("application/") ? "UTF-8" : null;
                    return new WebResourceResponse(type, charset, data);
                } catch (IOException missingAsset) {
                    // The bundled edition serves only packaged resources.
                }
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                    Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }

    private static boolean isBundledOrigin(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getHost()) && url.getPort() == -1;
    }

    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }
}
