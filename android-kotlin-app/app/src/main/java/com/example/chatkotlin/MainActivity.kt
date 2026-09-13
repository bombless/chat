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
import java.util.UUID
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

data class Message(val role: String, val content: String)

data class ChatConfig(
    val id: String,
    val name: String,
    val url: String,
    val modelsUrl: String,
    val apiKey: String,
    val model: String
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("url", url)
        .put("modelsUrl", modelsUrl)
        .put("apiKey", apiKey)
        .put("model", model)

    companion object {
        fun fromJson(json: JSONObject): ChatConfig = ChatConfig(
            id = json.optString("id").ifBlank { UUID.randomUUID().toString() },
            name = json.optString("name").ifBlank { "配置" },
            url = json.optString("url", "http://10.0.2.2:3000/v1/chat/completions"),
            modelsUrl = json.optString("modelsUrl", "http://10.0.2.2:3000/v1/models"),
            apiKey = json.optString("apiKey", ""),
            model = json.optString("model", "gpt-4o-mini")
        )
    }
}

class MainActivity : ComponentActivity() {
    private var transferPrivateKey: PrivateKey? = null
    private var transferToken: String? = null
    private val io = Executors.newSingleThreadExecutor()

    private val prefs by lazy { getSharedPreferences("chat_runtime", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureConfigStorage()
        val configs = loadConfigs()
        val activeId = prefs.getString("activeConfigId", configs.first().id) ?: configs.first().id
        setContent {
            ChatApp(
                initialConfigs = configs,
                initialActiveId = activeId,
                onConfigsChanged = { updated, selectedId -> saveConfigs(updated, selectedId) },
                onImportConfig = ::importConfig
            )
        }
    }

    private fun ensureConfigStorage() {
        if (prefs.getString("configs", null) != null) return
        val legacy = ChatConfig(
            id = UUID.randomUUID().toString(),
            name = "默认配置",
            url = prefs.getString("url", "http://10.0.2.2:3000/v1/chat/completions") ?: "http://10.0.2.2:3000/v1/chat/completions",
            modelsUrl = prefs.getString("modelsUrl", "http://10.0.2.2:3000/v1/models") ?: "http://10.0.2.2:3000/v1/models",
            apiKey = prefs.getString("apiKey", "") ?: "",
            model = prefs.getString("model", "gpt-4o-mini") ?: "gpt-4o-mini"
        )
        saveConfigs(listOf(legacy), legacy.id)
    }

    private fun loadConfigs(): List<ChatConfig> = try {
        val array = JSONArray(prefs.getString("configs", "[]"))
        buildList {
            for (i in 0 until array.length()) add(ChatConfig.fromJson(array.getJSONObject(i)))
        }.ifEmpty { listOf(ChatConfig(UUID.randomUUID().toString(), "默认配置", "http://10.0.2.2:3000/v1/chat/completions", "http://10.0.2.2:3000/v1/models", "", "gpt-4o-mini")) }
    } catch (_: Exception) {
        emptyList()
    }.ifEmpty {
        listOf(ChatConfig(UUID.randomUUID().toString(), "默认配置", "http://10.0.2.2:3000/v1/chat/completions", "http://10.0.2.2:3000/v1/models", "", "gpt-4o-mini"))
    }

    private fun saveConfigs(configs: List<ChatConfig>, activeId: String) {
        val array = JSONArray()
        configs.forEach { array.put(it.toJson()) }
        prefs.edit()
            .putString("configs", array.toString())
            .putString("activeConfigId", activeId)
            .apply()
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
                        runOnUiThread { showImportChoice(importedConfig) }
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

    private fun showImportChoice(imported: JSONObject) {
        transferToken = null
        transferPrivateKey = null
        val current = loadConfigs().firstOrNull { it.id == prefs.getString("activeConfigId", null) }
        val suggestedName = imported.optString("name").ifBlank {
            runCatching { Uri.parse(imported.optString("url")).host }.getOrNull()?.let { "$it 配置" } ?: "新配置"
        }
        val config = ChatConfig.fromJson(imported.put("name", suggestedName))
        val builder = AlertDialog.Builder(this)
            .setTitle("配置导入成功")
            .setMessage("请选择如何保存“${config.name}”")
            .setNegativeButton("取消", null)
            .setNeutralButton("替换当前") { _, _ ->
                if (current == null) addImportedConfig(config) else {
                    val replaced = config.copy(id = current.id, name = current.name)
                    saveConfigs(loadConfigs().map { if (it.id == current.id) replaced else it }, replaced.id)
                    recreate()
                }
            }
            .setPositiveButton("新增配置") { _, _ -> addImportedConfig(config) }
        builder.show()
    }

    private fun addImportedConfig(config: ChatConfig) {
        val configs = loadConfigs()
        val uniqueName = uniqueConfigName(config.name, configs)
        val added = config.copy(id = UUID.randomUUID().toString(), name = uniqueName)
        saveConfigs(configs + added, added.id)
        recreate()
    }

    private fun uniqueConfigName(base: String, configs: List<ChatConfig>): String {
        if (configs.none { it.name == base }) return base
        var index = 2
        while (configs.any { it.name == "$base $index" }) index++
        return "$base $index"
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
    initialConfigs: List<ChatConfig>,
    initialActiveId: String,
    onConfigsChanged: (List<ChatConfig>, String) -> Unit,
    onImportConfig: () -> Unit = {}
) {
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    var configs by remember { mutableStateOf(initialConfigs) }
    var activeId by remember { mutableStateOf(initialActiveId.ifBlank { initialConfigs.first().id }) }
    var messages by remember { mutableStateOf(listOf<Message>()) }
    var input by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showKb by remember { mutableStateOf(false) }
    var showConfigMenu by remember { mutableStateOf(false) }

    val active = configs.firstOrNull { it.id == activeId } ?: configs.first()
    var url by remember(active.id) { mutableStateOf(active.url) }
    var modelsUrl by remember(active.id) { mutableStateOf(active.modelsUrl) }
    var apiKey by remember(active.id) { mutableStateOf(active.apiKey) }
    var model by remember(active.id) { mutableStateOf(active.model) }
    var name by remember(active.id) { mutableStateOf(active.name) }

    fun persistCurrent() {
        val updated = active.copy(name = name.trim().ifBlank { active.name }, url = url, modelsUrl = modelsUrl, apiKey = apiKey, model = model)
        configs = configs.map { if (it.id == active.id) updated else it }
        onConfigsChanged(configs, active.id)
    }

    fun switchConfig(config: ChatConfig) {
        persistCurrent()
        activeId = config.id
        onConfigsChanged(configs, config.id)
        messages = emptyList()
        showConfigMenu = false
    }

    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2563EB), background = Color(0xFFF8FAFC))) {
        Scaffold(topBar = {
            TopAppBar(
                title = {
                    Box {
                        TextButton(onClick = { showConfigMenu = true }, contentPadding = PaddingValues(0.dp)) {
                            Text(active.name, style = MaterialTheme.typography.titleLarge)
                            Text("  ▾", style = MaterialTheme.typography.titleMedium)
                        }
                        DropdownMenu(expanded = showConfigMenu, onDismissRequest = { showConfigMenu = false }) {
                            configs.forEach { config ->
                                DropdownMenuItem(
                                    text = { Text(if (config.id == active.id) "✓ ${config.name}" else config.name) },
                                    onClick = { switchConfig(config) }
                                )
                            }
                        }
                    }
                },
                actions = { TextButton(onClick = { showSettings = true }) { Text("设置") } }
            )
        }) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("模型", style = MaterialTheme.typography.labelLarge)
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(model, { model = it }, Modifier.weight(1f), singleLine = true)
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = { showKb = !showKb }) { Text("📚 知识库") }
                }
                if (showKb) Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text("知识库", style = MaterialTheme.typography.titleMedium)
                        Text("输入网址抓取内容，辅助对话", color = Color.Gray)
                        var kb by remember { mutableStateOf("") }
                        OutlinedTextField(kb, { kb = it }, Modifier.fillMaxWidth(), placeholder = { Text("https://example.com") }, singleLine = true)
                        Button(onClick = {}, Modifier.padding(top = 6.dp)) { Text("抓取") }
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (messages.isEmpty()) Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("💬", style = MaterialTheme.typography.displayMedium)
                        Text("开始对话吧", style = MaterialTheme.typography.titleLarge)
                        Text("当前配置：${active.name}", color = Color.Gray)
                    } else LazyColumn(state = list, modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
                        items(messages) { m -> MessageBubble(m) }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                    OutlinedTextField(input, { if (it.length <= 4000) input = it }, Modifier.weight(1f), placeholder = { Text("输入消息... (Enter 发送, Shift+Enter 换行)") }, maxLines = 5)
                    Spacer(Modifier.width(8.dp))
                    Button(enabled = input.isNotBlank() && !busy, onClick = {
                        persistCurrent()
                        val text = input.trim()
                        input = ""
                        messages = messages + Message("user", text)
                        busy = true
                        scope.launch {
                            val reply = callChat(url, apiKey, model, messages)
                            messages = messages + Message("assistant", reply)
                            busy = false
                            list.animateScrollToItem(messages.lastIndex)
                        }
                    }) { Text(if (busy) "⏳" else "➤ 发送") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { messages = emptyList() }) { Text("🗑️ 清屏") }
                    TextButton(onClick = { messages = emptyList() }) { Text("🔄 重置") }
                }
            }
        }
        if (showSettings) AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("连接设置 · ${active.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(name, { name = it }, label = { Text("配置名称") }, singleLine = true)
                    OutlinedTextField(url, { url = it }, label = { Text("聊天接口 URL") }, singleLine = true)
                    OutlinedTextField(modelsUrl, { modelsUrl = it }, label = { Text("模型列表 URL") }, singleLine = true)
                    OutlinedTextField(apiKey, { apiKey = it }, label = { Text("API Key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
                    OutlinedTextField(model, { model = it }, label = { Text("模型") }, singleLine = true)
                    OutlinedButton(onClick = onImportConfig, modifier = Modifier.fillMaxWidth()) { Text("📷 扫描二维码导入配置") }
                }
            },
            confirmButton = { Button(onClick = { persistCurrent(); showSettings = false }) { Text("保存") } },
            dismissButton = { TextButton(onClick = { showSettings = false }) { Text("取消") } }
        )
    }
}

@Composable
fun MessageBubble(m: Message) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.role == "user") Arrangement.End else Arrangement.Start) {
        Surface(color = if (m.role == "user") Color(0xFFDCEBFF) else Color.White, shape = RoundedCornerShape(14.dp), tonalElevation = 1.dp) {
            Text(m.content, Modifier.padding(12.dp))
        }
    }
}

suspend fun callChat(endpoint: String, key: String, model: String, history: List<Message>): String = withContext(Dispatchers.IO) {
    try {
        val c = URL(endpoint).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        if (key.isNotBlank()) c.setRequestProperty("Authorization", "Bearer $key")
        val arr = JSONArray()
        history.forEach { arr.put(JSONObject().put("role", it.role).put("content", it.content)) }
        c.outputStream.use { it.write(JSONObject().put("model", model).put("messages", arr).put("stream", false).toString().toByteArray()) }
        val body = c.inputStream.bufferedReader().readText()
        JSONObject(body).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: body
    } catch (e: Exception) { "请求失败：${e.message}" }
}
