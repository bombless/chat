call .\gradle-9.1.0\bin\gradle.bat -p android-app assembleDebug
adb uninstall  com.example.chatapp
adb.exe install .\android-app\build\outputs\apk\debug\ChatApp-debug.apk
node server.js
