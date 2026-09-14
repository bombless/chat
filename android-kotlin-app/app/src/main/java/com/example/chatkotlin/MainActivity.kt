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
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.google.zxing.integration.android.IntentIntegrator
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
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("url", url).put("modelsUrl", modelsUrl).put("apiKey", apiKey).put("model", model)
    companion object {
        fun fromJson(json: JSONObject): ChatConfig = ChatConfig(
            json.optString("id").ifBlank { UUID.randomUUID().toString() },
            json.optString("name").ifBlank { "配置" },
            json.optString("url", "http://10.0.2.2:3000/v1/chat/completions"),
            json.optString("modelsUrl", "http://10.0.2.2:3000/v1/models"),
            json.optString("apiKey", ""), json.optString("model", "gpt-4o-mini")
        )
    }
}

private const val DEFAULT_URL = "http://10.0.2.2:3000/v1/chat/completions"
private const val DEFAULT_MODELS_URL = "http://10.0.2.2:3000/v1/models"

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
        setContent { ChatApp(configs, activeId, { updated, selectedId -> saveConfigs(updated, selectedId) }, ::importConfig) }
    }

    private fun defaultConfig(name: String = "默认配置") = ChatConfig(UUID.randomUUID().toString(), name, DEFAULT_URL, DEFAULT_MODELS_URL, "", "gpt-4o-mini")
    private fun ensureConfigStorage() {
        if (prefs.getString("configs", null) != null) return
        val legacy = ChatConfig(UUID.randomUUID().toString(), "默认配置",
            prefs.getString("url", DEFAULT_URL) ?: DEFAULT_URL,
            prefs.getString("modelsUrl", DEFAULT_MODELS_URL) ?: DEFAULT_MODELS_URL,
            prefs.getString("apiKey", "") ?: "", prefs.getString("model", "gpt-4o-mini") ?: "gpt-4o-mini")
        saveConfigs(listOf(legacy), legacy.id)
    }
    private fun loadConfigs(): List<ChatConfig> = try {
        val array = JSONArray(prefs.getString("configs", "[]"))
        buildList { for (i in 0 until array.length()) add(ChatConfig.fromJson(array.getJSONObject(i))) }.ifEmpty { listOf(defaultConfig()) }
    } catch (_: Exception) { listOf(defaultConfig()) }
    private fun saveConfigs(configs: List<ChatConfig>, activeId: String) {
        val array = JSONArray(); configs.forEach { array.put(it.toJson()) }
        prefs.edit().putString("configs", array.toString()).putString("activeConfigId", activeId).apply()
    }
    private fun importConfig() { IntentIntegrator(this).setPrompt("扫描电脑端配置迁移二维码").setBeepEnabled(false).setOrientationLocked(false).initiateScan() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        IntentIntegrator.parseActivityResult(requestCode, resultCode, data)?.contents?.trim()?.let(::onScannedContents)
    }
    private fun onScannedContents(scanned: String) {
        val uri = Uri.parse(scanned); val scheme = uri.scheme; val host = uri.host; val port = uri.port; val token = uri.getQueryParameter("t")
        if ((scheme != "http" && scheme != "https") || host.isNullOrBlank() || (port != -1 && port !in 1..65535) || token.isNullOrBlank() || token.length < 32) {
            Toast.makeText(this, "二维码不是有效的配置迁移地址", Toast.LENGTH_SHORT).show(); return
        }
        transferToken = token
        try {
            val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
            transferPrivateKey = pair.private
            val publicKey = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
            val base = "$scheme://$host${if (port == -1) "" else ":$port"}"
            io.execute { joinTransfer(base, token, publicKey) }
        } catch (e: Exception) { showError("无法建立安全连接：${e.message}") }
    }
    private fun joinTransfer(base: String, token: String, publicKey: String) {
        try {
            val r = request("POST", "$base/api/config-transfer/join", JSONObject().put("token", token).put("publicKey", publicKey).toString())
            if (r.first !in 200..299) throw Exception(r.second.optString("error", "连接失败"))
            runOnUiThread { showPairingCode(r.second.optString("code")) }; pollForConfig(base, token)
        } catch (e: Exception) { showError("连接失败：${e.message}") }
    }
    private fun showPairingCode(code: String) {
        AlertDialog.Builder(this).setTitle("检测到电脑配置迁移").setMessage("连接验证码\n\n$code\n\n请在电脑端输入这个验证码。")
            .setNegativeButton("取消") { _, _ -> transferToken = null; transferPrivateKey = null }.show()
    }
    private fun pollForConfig(base: String, token: String) {
        repeat(300) {
            if (token != transferToken) return
            try {
                Thread.sleep(1000); val r = request("GET", "$base/api/config-transfer/config?t=${Uri.encode(token)}", null)
                when (r.first) {
                    200 -> { runOnUiThread { showImportChoice(decryptTransfer(r.second)) }; return }
                    404, 410 -> { showError("迁移会话已过期，请重新扫码"); transferToken = null; transferPrivateKey = null; return }
                }
            } catch (e: Exception) { showError("配置导入失败：${e.message}"); transferToken = null; transferPrivateKey = null; return }
        }
        showError("配置迁移超时，请重新扫码")
    }
    private fun showImportChoice(imported: JSONObject) {
        transferToken = null; transferPrivateKey = null
        val configs = loadConfigs(); val current = configs.firstOrNull { it.id == prefs.getString("activeConfigId", null) }
        val suggestedName = imported.optString("name").ifBlank { runCatching { Uri.parse(imported.optString("url")).host }.getOrNull()?.let { "$it 配置" } ?: "新配置" }
        val config = ChatConfig.fromJson(imported.put("name", suggestedName))
        AlertDialog.Builder(this).setTitle("配置导入成功").setMessage("请选择如何保存“${config.name}”").setNegativeButton("取消", null)
            .setNeutralButton("替换当前") { _, _ ->
                if (current == null) addImportedConfig(config) else { val replaced = config.copy(id = current.id, name = current.name); saveConfigs(configs.map { if (it.id == current.id) replaced else it }, replaced.id); recreate() }
            }.setPositiveButton("新增配置") { _, _ -> addImportedConfig(config) }.show()
    }
    private fun addImportedConfig(config: ChatConfig) { val configs = loadConfigs(); val added = config.copy(id = UUID.randomUUID().toString(), name = uniqueConfigName(config.name, configs)); saveConfigs(configs + added, added.id); recreate() }
    private fun uniqueConfigName(base: String, configs: List<ChatConfig>): String {
        val clean = base.trim().ifBlank { "新配置" }; if (configs.none { it.name == clean }) return clean
        var i = 2; while (configs.any { it.name == "$clean $i" }) i++; return "$clean $i"
    }
    private fun decryptTransfer(encrypted: JSONObject): JSONObject {
        val key = Base64.decode(encrypted.getString("encryptedKey"), Base64.DEFAULT)
        val oaep = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)
        val rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding"); rsa.init(Cipher.DECRYPT_MODE, transferPrivateKey, oaep)
        val aesKey = rsa.doFinal(key); val iv = Base64.decode(encrypted.getString("iv"), Base64.DEFAULT); val tag = Base64.decode(encrypted.getString("tag"), Base64.DEFAULT); val ciphertext = Base64.decode(encrypted.getString("ciphertext"), Base64.DEFAULT)
        val aes = Cipher.getInstance("AES/GCM/NoPadding"); aes.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, iv))
        return JSONObject(String(aes.doFinal(ciphertext + tag), StandardCharsets.UTF_8))
    }
    private fun request(method: String, urlText: String, body: String?): Pair<Int, JSONObject> {
        val c = URL(urlText).openConnection() as HttpURLConnection; c.requestMethod = method; c.connectTimeout = 10000; c.readTimeout = 10000; c.doInput = true
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) } }
        val code = c.responseCode; val stream = if (code >= 400) c.errorStream else c.inputStream; val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: "{}"; c.disconnect(); return code to JSONObject(text.ifBlank { "{}" })
    }
    private fun showError(message: String) { runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() } }
    override fun onDestroy() { io.shutdownNow(); transferPrivateKey = null; transferToken = null; super.onDestroy() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatApp(initialConfigs: List<ChatConfig>, initialActiveId: String, onConfigsChanged: (List<ChatConfig>, String) -> Unit, onImportConfig: () -> Unit = {}) {
    val scope = rememberCoroutineScope(); val list = rememberLazyListState()
    var configs by remember { mutableStateOf(initialConfigs) }; var activeId by remember { mutableStateOf(initialActiveId.ifBlank { initialConfigs.first().id }) }
    var messages by remember { mutableStateOf(listOf<Message>()) }; var input by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    var showKb by remember { mutableStateOf(false) }; var showConfigMenu by remember { mutableStateOf(false) }; var showConfigManager by remember { mutableStateOf(false) }
    var models by remember { mutableStateOf(emptyList<String>()) }; var modelsLoading by remember { mutableStateOf(false) }; var modelMenuExpanded by remember { mutableStateOf(false) }; var modelError by remember { mutableStateOf<String?>(null) }
    val active = configs.firstOrNull { it.id == activeId } ?: configs.first()
    var url by remember(active.id) { mutableStateOf(active.url) }; var modelsUrl by remember(active.id) { mutableStateOf(active.modelsUrl) }; var apiKey by remember(active.id) { mutableStateOf(active.apiKey) }; var model by remember(active.id) { mutableStateOf(active.model) }; var name by remember(active.id) { mutableStateOf(active.name) }
    fun persistCurrent() { val updated = active.copy(name = name.trim().ifBlank { active.name }, url = url, modelsUrl = modelsUrl, apiKey = apiKey, model = model); configs = configs.map { if (it.id == active.id) updated else it }; onConfigsChanged(configs, active.id) }
    fun switchConfig(config: ChatConfig) { persistCurrent(); activeId = config.id; onConfigsChanged(configs, config.id); messages = emptyList() }
    fun applyManager(updated: List<ChatConfig>, selectedId: String) {
        configs = updated
        activeId = selectedId

        val selected = updated.firstOrNull { it.id == selectedId }
        if (selected != null) {
            name = selected.name
            url = selected.url
            modelsUrl = selected.modelsUrl
            apiKey = selected.apiKey
            model = selected.model
        }

        onConfigsChanged(updated, selectedId)
        messages = emptyList()
    }

    LaunchedEffect(active.id, active.modelsUrl, active.apiKey) {
        models = emptyList(); modelError = null
        if (active.modelsUrl.isBlank()) return@LaunchedEffect
        modelsLoading = true
        val result = fetchModels(active.modelsUrl, active.apiKey)
        modelsLoading = false
        result.fold(
            onSuccess = { loaded ->
                models = loaded
                if (model.isBlank() && loaded.isNotEmpty()) model = loaded.first()
            },
            onFailure = { modelError = it.message ?: "加载模型列表失败" }
        )
    }

    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2563EB), background = Color(0xFFF8FAFC))) {
        Scaffold(topBar = { TopAppBar(title = { Box { TextButton(onClick = { showConfigMenu = true }, contentPadding = PaddingValues(0.dp)) { Text(active.name, style = MaterialTheme.typography.titleLarge); Text("  ▾") }; DropdownMenu(showConfigMenu, { showConfigMenu = false }) { configs.forEach { c -> DropdownMenuItem(text = { Text(if (c.id == active.id) "✓ ${c.name}" else c.name) }, onClick = { switchConfig(c); showConfigMenu = false }) }; HorizontalDivider(); DropdownMenuItem(text = { Text("⚙ 管理配置") }, onClick = { showConfigMenu = false; showConfigManager = true }) } } }, actions = { TextButton(onClick = { showConfigManager = true }) { Text("设置") } }) }) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("模型", style = MaterialTheme.typography.labelLarge); Spacer(Modifier.width(8.dp))
                    Box(Modifier.weight(1f)) {
                        OutlinedButton(onClick = { if (models.isNotEmpty()) modelMenuExpanded = true }, enabled = !modelsLoading && models.isNotEmpty(), modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp)) {
                            Text(if (modelsLoading) "加载模型列表…" else model.ifBlank { "请选择模型" }, modifier = Modifier.weight(1f), maxLines = 1)
                            Text("▾")
                        }
                        DropdownMenu(expanded = modelMenuExpanded, onDismissRequest = { modelMenuExpanded = false }, modifier = Modifier.fillMaxWidth(320.dp)) {
                            models.forEach { id -> DropdownMenuItem(text = { Text(id) }, onClick = { model = id; modelMenuExpanded = false }) }
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                    IconButton(onClick = {
                        scope.launch {
                            modelsLoading = true; modelError = null
                            fetchModels(active.modelsUrl, active.apiKey).fold({ models = it }, { modelError = it.message ?: "加载模型列表失败" })
                            modelsLoading = false
                        }
                    }, enabled = !modelsLoading && active.modelsUrl.isNotBlank()) { Text("↻") }
                    Spacer(Modifier.width(4.dp)); Button(onClick = { showKb = !showKb }) { Text("📚 知识库") }
                }
                modelError?.let { Text("模型列表加载失败：$it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (showKb) Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) { Column(Modifier.padding(12.dp)) { Text("知识库", style = MaterialTheme.typography.titleMedium); Text("输入网址抓取内容，辅助对话", color = Color.Gray) } }
                Box(Modifier.weight(1f).fillMaxWidth()) { if (messages.isEmpty()) Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) { Text("💬", style = MaterialTheme.typography.displayMedium); Text("开始对话吧", style = MaterialTheme.typography.titleLarge); Text("当前配置：${active.name}", color = Color.Gray) } else LazyColumn(state = list, modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 8.dp)) { items(messages) { MessageBubble(it) } } }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Bottom) { OutlinedTextField(input, { if (it.length <= 4000) input = it }, Modifier.weight(1f), placeholder = { Text("输入消息...") }, maxLines = 5); Spacer(Modifier.width(8.dp)); Button(enabled = input.isNotBlank() && !busy && model.isNotBlank(), onClick = { persistCurrent(); val text = input.trim(); input = ""; messages = messages + Message("user", text); busy = true; scope.launch { val reply = callChat(url, apiKey, model, messages); messages = messages + Message("assistant", reply); busy = false; list.animateScrollToItem(messages.lastIndex) } }) { Text(if (busy) "⏳" else "➤ 发送") } }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextButton(onClick = { messages = emptyList() }) { Text("🗑️ 清屏") }; TextButton(onClick = { messages = emptyList() }) { Text("🔄 重置") } }
            }
        }
        if (showConfigManager) ConfigManagerDialog(configs, activeId, { showConfigManager = false }, { showConfigManager = false; onImportConfig() }, { updated, selectedId -> applyManager(updated, selectedId); showConfigManager = false })
    }
}

@Composable
private fun ConfigManagerDialog(configs: List<ChatConfig>, activeId: String, onDismiss: () -> Unit, onImport: () -> Unit, onApply: (List<ChatConfig>, String) -> Unit) {
    var working by remember(configs) { mutableStateOf(configs) }; var selectedId by remember(activeId) { mutableStateOf(activeId) }; var editorId by remember { mutableStateOf<String?>(null) }; var pendingDelete by remember { mutableStateOf<ChatConfig?>(null) }
    fun uniqueName(base: String): String { val clean = base.trim().ifBlank { "新配置" }; if (working.none { it.name == clean }) return clean; var i = 2; while (working.any { it.name == "$clean $i" }) i++; return "$clean $i" }
    fun create() { val c = ChatConfig(UUID.randomUUID().toString(), uniqueName("新配置"), DEFAULT_URL, DEFAULT_MODELS_URL, "", "gpt-4o-mini"); working = working + c; selectedId = c.id; editorId = c.id }
    fun duplicate(c: ChatConfig) { val copy = c.copy(id = UUID.randomUUID().toString(), name = uniqueName("${c.name} 副本")); working = working + copy; selectedId = copy.id; editorId = copy.id }
    fun delete(c: ChatConfig) { if (working.size <= 1) return; working = working.filterNot { it.id == c.id }; if (selectedId == c.id) selectedId = working.first().id }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("配置管理") }, text = { Column(Modifier.fillMaxWidth()) {
        Text("共 ${working.size} 个配置", color = Color.Gray, style = MaterialTheme.typography.bodySmall); Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.heightIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { items(working, key = { it.id }) { c ->
            Card(onClick = { selectedId = c.id }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) { Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Row(verticalAlignment = Alignment.CenterVertically) { Text(c.name, style = MaterialTheme.typography.titleMedium); if (c.id == selectedId) { Spacer(Modifier.width(8.dp)); AssistChip(onClick = {}, label = { Text("当前") }) } }; Text(c.model, color = Color.Gray, style = MaterialTheme.typography.bodySmall); Text(c.url, color = Color.Gray, style = MaterialTheme.typography.bodySmall, maxLines = 1) }
                TextButton(onClick = { selectedId = c.id; editorId = c.id }) { Text("编辑") }; TextButton(onClick = { duplicate(c) }) { Text("复制") }; if (working.size > 1) TextButton(onClick = { pendingDelete = c }) { Text("删除") }
            } }
        } }
        Spacer(Modifier.height(12.dp)); Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton(onClick = ::create, Modifier.weight(1f)) { Text("＋ 新增") }; OutlinedButton(onClick = onImport, Modifier.weight(1f)) { Text("扫码导入") } }
    } }, confirmButton = { Button(onClick = { onApply(working, selectedId) }) { Text("完成") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
    editorId?.let { id -> working.firstOrNull { it.id == id }?.let { ConfigEditorDialog(it, { editorId = null }, { edited -> working = working.map { c -> if (c.id == edited.id) edited else c }; editorId = null }) } }
    pendingDelete?.let { c -> AlertDialog(onDismissRequest = { pendingDelete = null }, title = { Text("删除配置？") }, text = { Text("将删除“${c.name}”，此操作无法撤销。") }, confirmButton = { TextButton(onClick = { delete(c); pendingDelete = null }) { Text("删除") } }, dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("取消") } }) }
}

@Composable
private fun ConfigEditorDialog(config: ChatConfig, onDismiss: () -> Unit, onSave: (ChatConfig) -> Unit) {
    var name by remember(config.id) { mutableStateOf(config.name) }; var url by remember(config.id) { mutableStateOf(config.url) }; var modelsUrl by remember(config.id) { mutableStateOf(config.modelsUrl) }; var apiKey by remember(config.id) { mutableStateOf(config.apiKey) }; var model by remember(config.id) { mutableStateOf(config.model) }; var showKey by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("编辑配置") }, text = { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("配置名称") }, singleLine = true)
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("聊天接口 URL") }, singleLine = true)
        OutlinedTextField(modelsUrl, { modelsUrl = it }, Modifier.fillMaxWidth(), label = { Text("模型列表 URL") }, singleLine = true)
        OutlinedTextField(apiKey, { apiKey = it }, Modifier.fillMaxWidth(), label = { Text("API Key") }, singleLine = true, visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(), trailingIcon = { TextButton(onClick = { showKey = !showKey }) { Text(if (showKey) "隐藏" else "显示") } })
        OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), label = { Text("模型") }, singleLine = true)
    } }, confirmButton = { Button(enabled = name.isNotBlank() && url.isNotBlank(), onClick = { onSave(config.copy(name = name.trim(), url = url, modelsUrl = modelsUrl, apiKey = apiKey, model = model)) }) { Text("保存") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable
private fun MessageBubble(m: Message) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.role == "user") Arrangement.End else Arrangement.Start) { Surface(color = if (m.role == "user") Color(0xFFDCEBFF) else Color.White, shape = RoundedCornerShape(14.dp), tonalElevation = 1.dp) { Text(m.content, Modifier.padding(12.dp)) } }
}

private suspend fun fetchModels(endpoint: String, key: String): Result<List<String>> = withContext(Dispatchers.IO) {
    try {
        val c = URL(endpoint).openConnection() as HttpURLConnection
        c.requestMethod = "GET"; c.connectTimeout = 10000; c.readTimeout = 10000
        if (key.isNotBlank()) c.setRequestProperty("Authorization", "Bearer $key")
        val code = c.responseCode
        val stream = if (code >= 400) c.errorStream else c.inputStream
        val body = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: "{}"
        c.disconnect()
        if (code !in 200..299) return@withContext Result.failure(Exception("HTTP $code"))
        val data = JSONObject(body).optJSONArray("data") ?: JSONArray()
        val ids = buildList { for (i in 0 until data.length()) data.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }?.let(::add) }.distinct()
        Result.success(ids)
    } catch (e: Exception) { Result.failure(e) }
}

private suspend fun callChat(endpoint: String, key: String, model: String, history: List<Message>): String = withContext(Dispatchers.IO) {
    try {
        val c = URL(endpoint).openConnection() as HttpURLConnection; c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); if (key.isNotBlank()) c.setRequestProperty("Authorization", "Bearer $key")
        val arr = JSONArray(); history.forEach { arr.put(JSONObject().put("role", it.role).put("content", it.content)) }
        c.outputStream.use { it.write(JSONObject().put("model", model).put("messages", arr).put("stream", false).toString().toByteArray(StandardCharsets.UTF_8)) }
        val body = c.inputStream.bufferedReader().use { it.readText() }; JSONObject(body).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: body
    } catch (e: Exception) { "请求失败：${e.message}" }
}
