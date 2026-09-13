package com.example.chatkotlin

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.google.zxing.integration.android.IntentIntegrator
import com.google.zxing.integration.android.IntentResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.spec.MGF1ParameterSpec
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

data class Message(val role: String, val content: String)

class MainActivity : ComponentActivity() {
    private var transferPrivateKey: PrivateKey? = null
    private var transferToken: String? = null
    private var onConfigImported: ((JSONObject) -> Unit)? = null
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = getSharedPreferences("chat_runtime", MODE_PRIVATE)
        setContent {
            ChatApp(
                initialUrl = saved.getString("url", "http://10.0.2.2:3000/v1/chat/completions") ?: "http://10.0.2.2:3000/v1/chat/completions",
                initialModelsUrl = saved.getString("modelsUrl", "http://10.0.2.2:3000/v1/models") ?: "http://10.0.2.2:3000/v1/models",
                initialApiKey = saved.getString("apiKey", "") ?: "",
                initialModel = saved.getString("model", "gpt-4o-mini") ?: "gpt-4o-mini",
                onImportConfig = ::importConfig
            )
        }
    }

    private fun importConfig() {
        IntentIntegrator(this).setPrompt("扫描电脑端配置迁移二维码").setBeepEnabled(false).setOrientationLocked(false).initiateScan()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val result: IntentResult? = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        result?.contents?.trim()?.let(::onScannedContents)
    }

    private fun onScannedContents(scanned: String) {
        val uri = Uri.parse(scanned)
        val scheme = uri.scheme
        val host = uri.host
        val port = uri.port
        val token = uri.getQueryParameter("t")
        if ((scheme != "http" && scheme != "https") || host.isNullOrBlank() || (port != -1 && port !in 1..65535) || token.isNullOrBlank() || token.length < 32) {
            Toast.makeText(this, "二维码不是有效的配置迁移地址", Toast.LENGTH_SHORT).show()
            return
        }
        transferToken = token
        try {
            val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
            transferPrivateKey = pair.private
            val publicKey = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
            val base = "$scheme://$host${if (port == -1) "" else ":$port"}"
            io.execute { joinTransfer(base, token, publicKey) }
        } catch (e: Exception) {
            showError("无法建立安全连接：${e.message}")
        }
    }

    private fun joinTransfer(base: String, token: String, publicKey: String) {
        try {
            val body = JSONObject().put("token", token).put("publicKey", publicKey).toString()
            val r = request("POST", "$base/api/config-transfer/join", body)
            if (r.first !in 200..299) throw Exception(r.second.optString("error", "连接失败"))
            val code = r.second.optString("code")
            runOnUiThread { showPairingCode(code) }
            pollForConfig(base, token)
        } catch (e: Exception) {
            showError("连接失败：${e.message}")
        }
    }

    private fun showPairingCode(code: String) {
        AlertDialog.Builder(this)
            .setTitle("检测到电脑配置迁移")
            .setMessage("连接验证码\n\n$code\n\n请在电脑端输入这个验证码。")
            .setNegativeButton("取消") { _, _ -> transferToken = null; transferPrivateKey = null }
            .show()
    }

    private fun pollForConfig(base: String, token: String) {
        repeat(300) {
            if (token != transferToken) return
            try {
                Thread.sleep(1000)
                val r = request("GET", "$base/api/config-transfer/config?t=${Uri.encode(token)}", null)
                when (r.first) {
                    200 -> {
                        val importedConfig = decryptTransfer(r.second)
                        saveConfig(importedConfig)
                        runOnUiThread {
                            transferToken = null
                            transferPrivateKey = null
                            Toast.makeText(this, "配置导入成功，正在刷新配置", Toast.LENGTH_SHORT).show()
                            recreate()
                        }
                        return
                    }
                    404, 410 -> {
                        showError("迁移会话已过期，请重新扫码")
                        transferToken = null; transferPrivateKey = null
                        return
                    }
                }
            } catch (e: Exception) {
                showError("配置导入失败：${e.message}")
                transferToken = null; transferPrivateKey = null
                return
            }
        }
        showError("配置迁移超时，请重新扫码")
    }

    private fun decryptTransfer(encrypted: JSONObject): JSONObject {
        val encryptedKey = Base64.decode(encrypted.getString("encryptedKey"), Base64.DEFAULT)
        val oaep = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)
        val rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")
        rsa.init(Cipher.DECRYPT_MODE, transferPrivateKey, oaep)
        val aesKey = rsa.doFinal(encryptedKey)
        val iv = Base64.decode(encrypted.getString("iv"), Base64.DEFAULT)
        val tag = Base64.decode(encrypted.getString("tag"), Base64.DEFAULT)
        val ciphertext = Base64.decode(encrypted.getString("ciphertext"), Base64.DEFAULT)
        val aes = Cipher.getInstance("AES/GCM/NoPadding")
        aes.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, iv))
        return JSONObject(String(aes.doFinal(ciphertext + tag), StandardCharsets.UTF_8))
    }

    private fun saveConfig(config: JSONObject) {
        getSharedPreferences("chat_runtime", MODE_PRIVATE).edit()
            .putString("url", config.optString("url", ""))
            .putString("modelsUrl", config.optString("modelsUrl", ""))
            .putString("apiKey", config.optString("apiKey", ""))
            .putString("model", config.optString("model", ""))
            .apply()
    }

    private fun request(method: String, urlText: String, body: String?): Pair<Int, JSONObject> {
        val c = URL(urlText).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10000
        c.readTimeout = 10000
        c.doInput = true
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
        }
        val code = c.responseCode
        val stream = if (code >= 400) c.errorStream else c.inputStream
        val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: "{}"
        c.disconnect()
        return code to JSONObject(text.ifBlank { "{}" })
    }

    private fun showError(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    }

    override fun onDestroy() {
        io.shutdownNow()
        transferPrivateKey = null
        transferToken = null
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatApp(
    initialUrl: String = "http://10.0.2.2:3000/v1/chat/completions",
    initialModelsUrl: String = "http://10.0.2.2:3000/v1/models",
    initialApiKey: String = "",
    initialModel: String = "gpt-4o-mini",
    onImportConfig: () -> Unit = {}
) {
    val scope = rememberCoroutineScope(); val list = rememberLazyListState()
    var messages by remember { mutableStateOf(listOf<Message>()) }; var input by remember { mutableStateOf("") }
    var url by remember { mutableStateOf(initialUrl) }; var modelsUrl by remember { mutableStateOf(initialModelsUrl) }
    var apiKey by remember { mutableStateOf(initialApiKey) }; var model by remember { mutableStateOf(initialModel) }; var busy by remember { mutableStateOf(false) }; var showSettings by remember { mutableStateOf(false) }; var showKb by remember { mutableStateOf(false) }
    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2563EB), background = Color(0xFFF8FAFC))) {
        Scaffold(topBar = { TopAppBar(title = { Text("AI 聊天助手") }, actions = { TextButton(onClick={showSettings=true}) { Text("设置") } }) }) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).padding(horizontal=16.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically, modifier=Modifier.fillMaxWidth().padding(vertical=8.dp)) {
                    Text("模型", style=MaterialTheme.typography.labelLarge); Spacer(Modifier.width(8.dp)); OutlinedTextField(model,{model=it},Modifier.weight(1f),singleLine=true)
                    Spacer(Modifier.width(8.dp)); Button(onClick={showKb=!showKb}) { Text("📚 知识库") }
                }
                if (showKb) Card(Modifier.fillMaxWidth().padding(bottom=8.dp)) { Column(Modifier.padding(12.dp)) { Text("知识库", style=MaterialTheme.typography.titleMedium); Text("输入网址抓取内容，辅助对话", color=Color.Gray); var kb by remember { mutableStateOf("") }; OutlinedTextField(kb,{kb=it},Modifier.fillMaxWidth(),placeholder={Text("https://example.com")},singleLine=true); Button(onClick={},Modifier.padding(top=6.dp)) { Text("抓取") } } }
                Box(Modifier.weight(1f).fillMaxWidth()) { if (messages.isEmpty()) Column(Modifier.align(Alignment.Center),horizontalAlignment=Alignment.CenterHorizontally) { Text("💬", style=MaterialTheme.typography.displayMedium); Text("开始对话吧", style=MaterialTheme.typography.titleLarge); Text("支持多轮对话，自动记忆上下文", color=Color.Gray) } else LazyColumn(state=list,modifier=Modifier.fillMaxSize(),verticalArrangement=Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(vertical=8.dp)) { items(messages) { m -> MessageBubble(m) } } }
                Row(Modifier.fillMaxWidth().padding(vertical=8.dp),verticalAlignment=Alignment.Bottom) { OutlinedTextField(input,{ if(it.length<=4000) input=it },Modifier.weight(1f),placeholder={Text("输入消息... (Enter 发送, Shift+Enter 换行)")},maxLines=5); Spacer(Modifier.width(8.dp)); Button(enabled=input.isNotBlank()&&!busy,onClick={ val text=input.trim(); input=""; messages=messages+Message("user",text); busy=true; scope.launch { val reply=callChat(url,apiKey,model,messages); messages=messages+Message("assistant",reply); busy=false; list.animateScrollToItem(messages.lastIndex) } }) { Text(if(busy) "⏳" else "➤ 发送") } }
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End) { TextButton(onClick={messages=emptyList()}) { Text("🗑️ 清屏") }; TextButton(onClick={messages=emptyList()}) { Text("🔄 重置") } }
            }
        }
        if(showSettings) AlertDialog(onDismissRequest={showSettings=false},title={Text("连接设置")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){ OutlinedTextField(url,{url=it},label={Text("聊天接口 URL")},singleLine=true); OutlinedTextField(modelsUrl,{modelsUrl=it},label={Text("模型列表 URL")},singleLine=true); OutlinedTextField(apiKey,{apiKey=it},label={Text("API Key")},visualTransformation=PasswordVisualTransformation(),singleLine=true); OutlinedTextField(model,{model=it},label={Text("模型")},singleLine=true); OutlinedButton(onClick=onImportConfig,modifier=Modifier.fillMaxWidth()){Text("📷 扫描二维码导入配置")} }},confirmButton={Button(onClick={showSettings=false}){Text("保存")}},dismissButton={TextButton(onClick={showSettings=false}){Text("取消")}})
    }
}

@Composable fun MessageBubble(m: Message) { Row(Modifier.fillMaxWidth(),horizontalArrangement=if(m.role=="user") Arrangement.End else Arrangement.Start){ Surface(color=if(m.role=="user") Color(0xFFDCEBFF) else Color.White,shape=RoundedCornerShape(14.dp),tonalElevation=1.dp){ Text(m.content,Modifier.padding(12.dp)) } } }

suspend fun callChat(endpoint:String,key:String,model:String,history:List<Message>):String = withContext(Dispatchers.IO) { try { val c=URL(endpoint).openConnection() as HttpURLConnection; c.requestMethod="POST"; c.doOutput=true; c.setRequestProperty("Content-Type","application/json"); if(key.isNotBlank()) c.setRequestProperty("Authorization","Bearer $key"); val arr=JSONArray(); history.forEach { arr.put(JSONObject().put("role",it.role).put("content",it.content)) }; c.outputStream.use{it.write(JSONObject().put("model",model).put("messages",arr).put("stream",false).toString().toByteArray())}; val body=c.inputStream.bufferedReader().readText(); JSONObject(body).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: body } catch(e:Exception){ "请求失败：${e.message}" } }
