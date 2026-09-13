package com.example.chatkotlin

import android.os.Bundle
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class Message(val role: String, val content: String)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setContent { ChatApp() } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ChatApp() {
    val scope = rememberCoroutineScope(); val list = rememberLazyListState()
    var messages by remember { mutableStateOf(listOf<Message>()) }; var input by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("http://10.0.2.2:3000/v1/chat/completions") }; var modelsUrl by remember { mutableStateOf("http://10.0.2.2:3000/v1/models") }
    var apiKey by remember { mutableStateOf("") }; var model by remember { mutableStateOf("gpt-4o-mini") }; var busy by remember { mutableStateOf(false) }; var showSettings by remember { mutableStateOf(false) }; var showKb by remember { mutableStateOf(false) }
    MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2563EB), background = Color(0xFFF8FAFC))) {
        Scaffold(topBar = { TopAppBar(title = { Text("AI 聊天助手") }, actions = { TextButton(onClick={showSettings=true}) { Text("设置") } }) }) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).padding(horizontal=16.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically, modifier=Modifier.fillMaxWidth().padding(vertical=8.dp)) {
                    Text("模型", style=MaterialTheme.typography.labelLarge); Spacer(Modifier.width(8.dp)); OutlinedTextField(model,{model=it},Modifier.weight(1f),singleLine=true);
                    Spacer(Modifier.width(8.dp)); Button(onClick={showKb=!showKb}) { Text("📚 知识库") }
                }
                if (showKb) Card(Modifier.fillMaxWidth().padding(bottom=8.dp)) { Column(Modifier.padding(12.dp)) { Text("知识库", style=MaterialTheme.typography.titleMedium); Text("输入网址抓取内容，辅助对话", color=Color.Gray); var kb by remember { mutableStateOf("") }; OutlinedTextField(kb,{kb=it},Modifier.fillMaxWidth(),placeholder={Text("https://example.com")},singleLine=true); Button(onClick={},Modifier.padding(top=6.dp)) { Text("抓取") } } }
                Box(Modifier.weight(1f).fillMaxWidth()) { if (messages.isEmpty()) Column(Modifier.align(Alignment.Center),horizontalAlignment=Alignment.CenterHorizontally) { Text("💬", style=MaterialTheme.typography.displayMedium); Text("开始对话吧", style=MaterialTheme.typography.titleLarge); Text("支持多轮对话，自动记忆上下文", color=Color.Gray) } else LazyColumn(state=list,modifier=Modifier.fillMaxSize(),verticalArrangement=Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(vertical=8.dp)) { items(messages) { m -> MessageBubble(m) } } }
                Row(Modifier.fillMaxWidth().padding(vertical=8.dp),verticalAlignment=Alignment.Bottom) { OutlinedTextField(input,{ if(it.length<=4000) input=it },Modifier.weight(1f),placeholder={Text("输入消息... (Enter 发送, Shift+Enter 换行)")},maxLines=5); Spacer(Modifier.width(8.dp)); Button(enabled=input.isNotBlank()&&!busy,onClick={ val text=input.trim(); input=""; messages=messages+Message("user",text); busy=true; scope.launch { val reply=callChat(url,apiKey,model,messages); messages=messages+Message("assistant",reply); busy=false; list.animateScrollToItem(messages.lastIndex) } }) { Text(if(busy) "⏳" else "➤ 发送") } }
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End) { TextButton(onClick={messages=emptyList()}) { Text("🗑️ 清屏") }; TextButton(onClick={messages=emptyList()}) { Text("🔄 重置") } }
            }
        }
        if(showSettings) AlertDialog(onDismissRequest={showSettings=false},title={Text("连接设置")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){ OutlinedTextField(url,{url=it},label={Text("聊天接口 URL")},singleLine=true); OutlinedTextField(modelsUrl,{modelsUrl=it},label={Text("模型列表 URL")},singleLine=true); OutlinedTextField(apiKey,{apiKey=it},label={Text("API Key")},visualTransformation=PasswordVisualTransformation(),singleLine=true); OutlinedTextField(model,{model=it},label={Text("模型")},singleLine=true) }},confirmButton={Button(onClick={showSettings=false}){Text("保存")}},dismissButton={TextButton(onClick={showSettings=false}){Text("取消")}})
    }
}

@Composable fun MessageBubble(m: Message) { Row(Modifier.fillMaxWidth(),horizontalArrangement=if(m.role=="user") Arrangement.End else Arrangement.Start){ Surface(color=if(m.role=="user") Color(0xFFDCEBFF) else Color.White,shape=RoundedCornerShape(14.dp),tonalElevation=1.dp){ Text(m.content,Modifier.padding(12.dp)) } } }

suspend fun callChat(endpoint:String,key:String,model:String,history:List<Message>):String = withContext(Dispatchers.IO) { try { val c=URL(endpoint).openConnection() as HttpURLConnection; c.requestMethod="POST"; c.doOutput=true; c.setRequestProperty("Content-Type","application/json"); if(key.isNotBlank()) c.setRequestProperty("Authorization","Bearer $key"); val arr=JSONArray(); history.forEach { arr.put(JSONObject().put("role",it.role).put("content",it.content)) }; c.outputStream.use{it.write(JSONObject().put("model",model).put("messages",arr).put("stream",false).toString().toByteArray())}; val body=c.inputStream.bufferedReader().readText(); JSONObject(body).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: body } catch(e:Exception){ "请求失败：${e.message}" } }
