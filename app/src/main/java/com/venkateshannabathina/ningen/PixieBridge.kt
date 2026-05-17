package com.venkateshannabathina.ningen

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import org.json.JSONObject

class PixieBridge(
    private val context: Context,
    private val webView: WebView
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val memoryManager = MemoryManager(context)
    private val groqClient = GroqApiClient(context)
    private val audioRecorder = AudioRecorder(context)
    private val vrmManager = VrmManager(context)

    @Volatile private var pipeline = "idle"

    companion object {
        const val AUDIO_PERMISSION_REQUEST = 1001
    }

    // ─── Emit to WebView ─────────────────────────────────────────────────────

    private fun emit(type: String, vararg pairs: Pair<String, Any?>) {
        val obj = JSONObject().put("type", type)
        pairs.forEach { (k, v) -> if (v != null) obj.put(k, v) }
        val escaped = obj.toString()
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        webView.post {
            webView.evaluateJavascript("window.receiveFromAndroid('$escaped')", null)
        }
    }

    private fun emitAnimations(animations: Map<String, String>): JSONObject {
        val obj = JSONObject()
        animations.forEach { (k, v) -> obj.put(k, v) }
        return obj
    }

    // ─── Main entry from WebView JS ──────────────────────────────────────────

    @JavascriptInterface
    fun sendToAndroid(json: String) {
        try {
            val msg = JSONObject(json)
            when (msg.getString("type")) {
                "WEBVIEW_READY"   -> onWebviewReady()
                "START_CLICKED"   -> onStartClicked()
                "SAVE_API_KEY"    -> onSaveApiKey(msg.getString("key"))
                "REQUEST_VRM"     -> onRequestVrm(msg.optString("companion", "pixie"))
                "UPLOAD_VRM"      -> onUploadVrm(msg.getString("data"))
                "SEND_TEXT"       -> onSendText(msg.getString("text"))
                "START_LISTENING" -> onStartListening()
                "STOP_LISTENING"  -> onStopListening()
                "TTS_DONE"        -> { /* handled by main.js state machine */ }
                "UPDATE_SETTINGS" -> onUpdateSettings(msg)
                "CLEAR_MEMORY"    -> memoryManager.clear()
                "CLEAR_API_KEY"   -> { groqClient.clearApiKey(); groqClient.clearHistory() }
                "RESET_ALL"       -> onResetAll()
            }
        } catch (e: Exception) {
            // Swallow parse errors from JS
        }
    }

    // ─── Handlers ────────────────────────────────────────────────────────────

    private fun onWebviewReady() {
        if (groqClient.hasApiKey()) {
            groqClient.loadSettings()
            emit("INIT_STATE", "voiceEnabled" to true)
            // JS will send REQUEST_VRM from initVRM() — don't load here or two VRMs appear in the scene
            emit("SHOW_SCREEN", "screen" to "LOADING")
        } else {
            emit("SHOW_SCREEN", "screen" to "API_KEY")
        }
    }

    private fun onStartClicked() {
        val companion = context.getSharedPreferences("pixie_prefs", Context.MODE_PRIVATE)
            .getString("companion", "pixie") ?: "pixie"
        onRequestVrm(companion)
    }

    private fun onSaveApiKey(key: String) {
        groqClient.saveApiKey(key)
        scope.launch {
            try {
                groqClient.initialize()
                emit("INIT_STATE", "voiceEnabled" to true)
                emit("SHOW_SCREEN", "screen" to "LOADING")
                onRequestVrm("pixie")
            } catch (e: Exception) {
                emit("SHOW_ERROR", "message" to "Invalid API key. Check it and try again.")
            }
        }
    }

    private fun onRequestVrm(companion: String) {
        context.getSharedPreferences("pixie_prefs", Context.MODE_PRIVATE)
            .edit().putString("companion", companion).apply()

        scope.launch {
            try {
                emit("SET_STATE", "state" to "processing")
                val assets = vrmManager.ensureVrm(companion)
                val animObj = emitAnimations(assets.animations)
                emit(
                    "LOAD_VRM",
                    "vrmUri" to assets.vrmUri,
                    "vrmaUri" to assets.animations["intro"],
                    "animations" to animObj
                )
                emit("SHOW_SCREEN", "screen" to "VOICE_UI")
                emit("SET_STATE", "state" to "idle")
            } catch (e: Exception) {
                emit("SHOW_ERROR", "message" to "Failed to load companion: ${e.message}")
                emit("SET_STATE", "state" to "error")
            }
        }
    }

    private fun onUploadVrm(base64Data: String) {
        scope.launch {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                vrmManager.saveCustomVrm(bytes)
                emit("UPLOAD_VRM_DONE", "success" to true)
            } catch (e: Exception) {
                emit("UPLOAD_VRM_DONE", "success" to false, "error" to e.message)
            }
        }
    }

    private fun onSendText(text: String) {
        if (pipeline != "idle") return
        pipeline = "chat"
        scope.launch {
            try {
                emit("SET_STATE", "state" to "processing")
                emit("USER_SAID", "text" to text)

                val mem = memoryManager.load()
                val response = groqClient.chat(text, mem.compressed)

                emit("PIXIE_SAID", "text" to response.text, "emotion" to response.emotion)

                if (groqClient.voiceEnabled) {
                    emit("SET_STATE", "state" to "speaking")
                    try {
                        val audioBase64 = groqClient.synthesizeSpeech(response.text)
                        emit("PLAY_AUDIO", "audioBase64" to audioBase64, "mimeType" to "audio/wav")
                        // State returns to idle when WebView sends TTS_DONE
                    } catch (e: Exception) {
                        emit("SET_STATE", "state" to "idle")
                    }
                } else {
                    emit("SET_STATE", "state" to "idle")
                }

                groqClient.maybeCompressMemory(text, response.text, mem.compressed) { newMem ->
                    memoryManager.save(newMem)
                    emit("MEMORY_UPDATED", "summary" to newMem)
                }

            } catch (e: Exception) {
                emit("ERROR", "message" to (e.message ?: "Something went wrong"))
                emit("SET_STATE", "state" to "error")
            } finally {
                pipeline = "idle"
            }
        }
    }

    private fun onStartListening() {
        val activity = context as? MainActivity ?: return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                AUDIO_PERMISSION_REQUEST
            )
            return
        }
        try {
            emit("SET_STATE", "state" to "listening")
            audioRecorder.startRecording()
        } catch (e: Exception) {
            emit("SHOW_ERROR", "message" to "Mic error: ${e.message}")
            emit("SET_STATE", "state" to "idle")
        }
    }

    private fun onStopListening() {
        if (pipeline != "idle") return
        pipeline = "chat"
        scope.launch {
            try {
                val audioFile = audioRecorder.stopRecording()
                if (audioFile == null) {
                    pipeline = "idle"
                    emit("SET_STATE", "state" to "idle")
                    return@launch
                }

                emit("SET_STATE", "state" to "processing")

                val transcript = try {
                    groqClient.transcribeAudio(audioFile)
                } finally {
                    audioFile.delete()
                }

                if (transcript.isBlank()) {
                    pipeline = "idle"
                    emit("SET_STATE", "state" to "idle")
                    return@launch
                }

                emit("USER_SAID", "text" to transcript)

                val mem = memoryManager.load()
                val response = groqClient.chat(transcript, mem.compressed)

                emit("PIXIE_SAID", "text" to response.text, "emotion" to response.emotion)

                if (groqClient.voiceEnabled) {
                    emit("SET_STATE", "state" to "speaking")
                    try {
                        val audioBase64 = groqClient.synthesizeSpeech(response.text)
                        emit("PLAY_AUDIO", "audioBase64" to audioBase64, "mimeType" to "audio/wav")
                    } catch (e: Exception) {
                        emit("SET_STATE", "state" to "idle")
                    }
                } else {
                    emit("SET_STATE", "state" to "idle")
                }

                groqClient.maybeCompressMemory(transcript, response.text, mem.compressed) { newMem ->
                    memoryManager.save(newMem)
                    emit("MEMORY_UPDATED", "summary" to newMem)
                }

            } catch (e: Exception) {
                audioRecorder.cancelRecording()
                emit("ERROR", "message" to (e.message ?: "Recording error"))
                emit("SET_STATE", "state" to "error")
            } finally {
                pipeline = "idle"
            }
        }
    }

    private fun onUpdateSettings(msg: JSONObject) {
        groqClient.updateSettings(
            voiceName = msg.optString("voiceName").takeIf { it.isNotEmpty() },
            model = msg.optString("model").takeIf { it.isNotEmpty() },
            companionName = msg.optString("companionName").takeIf { it.isNotEmpty() },
            personality = msg.optString("personality").takeIf { it.isNotEmpty() }
        )
    }

    private fun onResetAll() {
        groqClient.clearApiKey()
        groqClient.clearHistory()
        memoryManager.clear()
        context.getSharedPreferences("pixie_prefs", Context.MODE_PRIVATE).edit().clear().apply()
    }

    fun onPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode == AUDIO_PERMISSION_REQUEST &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        ) {
            onStartListening()
        } else if (requestCode == AUDIO_PERMISSION_REQUEST) {
            emit("SHOW_ERROR", "message" to "Microphone permission is required for voice.")
        }
    }

    fun destroy() {
        scope.cancel()
        audioRecorder.cancelRecording()
    }
}
