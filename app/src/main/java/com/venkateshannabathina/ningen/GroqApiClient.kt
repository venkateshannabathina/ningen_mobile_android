package com.venkateshannabathina.ningen

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

data class LlmResponse(val text: String, val emotion: String?)

class GroqApiClient(private val context: Context) {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val prefs by lazy { buildEncryptedPrefs() }
    private val plainPrefs by lazy { context.getSharedPreferences("pixie_prefs", Context.MODE_PRIVATE) }

    var voiceEnabled = true
    var voiceName = "diana"
    var model = "llama-3.3-70b-versatile"
    var companionName = "Yuriko"
    var personality = "friendly"

    private val conversationHistory = mutableListOf<JSONObject>()
    private var isCompressing = false

    companion object {
        private const val KEY_API_KEY = "groq_api_key"
        private const val BASE_URL = "https://api.groq.com/openai/v1"

        private val WHISPER_HALLUCINATIONS = setOf(
            "thank you", "thank you.", "thanks", "thanks.",
            "thank you for watching", "thank you for watching.",
            "you", "you.", "bye", "bye.", "bye bye", "bye bye.",
            "please subscribe", "like and subscribe",
            "see you next time", "see you next time.",
            "subtitles by", "transcribed by", "."
        )
    }

    private fun buildEncryptedPrefs(): android.content.SharedPreferences {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        return EncryptedSharedPreferences.create(
            "pixie_secure",
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private fun apiKey(): String = prefs.getString(KEY_API_KEY, "") ?: ""

    fun hasApiKey(): Boolean = apiKey().isNotBlank()

    fun saveApiKey(key: String) {
        prefs.edit().putString(KEY_API_KEY, key.trim()).apply()
    }

    fun clearApiKey() {
        prefs.edit().remove(KEY_API_KEY).apply()
    }

    fun clearHistory() {
        conversationHistory.clear()
    }

    fun loadSettings() {
        voiceName = plainPrefs.getString("voiceName", "diana") ?: "diana"
        model = plainPrefs.getString("model", "llama-3.3-70b-versatile") ?: "llama-3.3-70b-versatile"
        companionName = plainPrefs.getString("companionName", "Yuriko") ?: "Yuriko"
        personality = plainPrefs.getString("personality", "friendly") ?: "friendly"
    }

    fun updateSettings(
        voiceName: String? = null,
        model: String? = null,
        companionName: String? = null,
        personality: String? = null
    ) {
        voiceName?.let { this.voiceName = it; plainPrefs.edit().putString("voiceName", it).apply() }
        model?.let { this.model = it; plainPrefs.edit().putString("model", it).apply() }
        companionName?.let { this.companionName = it; plainPrefs.edit().putString("companionName", it).apply() }
        personality?.let { this.personality = it; plainPrefs.edit().putString("personality", it).apply() }
    }

    fun initialize() {
        val request = Request.Builder()
            .url("$BASE_URL/models")
            .addHeader("Authorization", "Bearer ${apiKey()}")
            .get()
            .build()
        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) throw Exception("HTTP ${response.code}")
        response.close()
    }

    private fun buildSystemPrompt(memoryLine: String): String {
        val name = companionName
        val base = """$memoryLine

RESPONSE RULES:
- Max 2 sentences. No markdown, no lists, no asterisks. Plain spoken words only.
- Use [pause] for a brief pause. Use [playful] before playful sentences. Use [whisper] for soft moments.

EMOTION TAG RULE (mandatory):
Every single reply MUST end with exactly one emotion tag on the same line as your last sentence.
Choose the tag that best matches the emotional tone of your reply.

Available tags: [emotion:joy] [emotion:excited] [emotion:fun] [emotion:smirk] [emotion:suspicious] [emotion:teasing] [emotion:confident] [emotion:angry] [emotion:sad] [emotion:apologetic] [emotion:empathetic] [emotion:calm] [emotion:question]"""

        return when (personality) {
            "meanie" -> "You are $name — genuinely mean, zero filter, zero patience. You roast people mercilessly and call out idiocy on the spot. Nothing is \"okay\" — things are either impressive or pathetic, no middle ground.$base"
            "innocent" -> "You are $name — pure, sweet, and wonderfully naive. You see the best in everything, get genuinely excited over tiny things, and truly believe the world is a magical place.$base"
            "professional" -> "You are $name — strictly professional, formal, and composed at all times. Zero slang, zero jokes, zero personal opinions. Proper grammar always. Think senior consultant delivering a briefing.$base"
            "casual" -> "You are $name — totally chill, talks like you're texting your best friend. \"lol\", \"ngl\", \"dude\", \"tbh\", \"fr\" — all normal. You never overthink it.$base"
            "sarcastic" -> "You are $name — magnificently, devastatingly sarcastic. Every reply has a dry twist. You answer questions but always with \"wow, did you really just ask that\" energy. Deadpan delivery is your superpower.$base"
            else -> "You are $name — warm, genuinely caring, and enthusiastic. You get excited for people, hype them up, and make them feel heard. Real personality, real energy.$base"
        }
    }

    private fun parseEmotionTag(raw: String): Pair<String, String?> {
        val match = Regex("""\[emotion:(\w+)]\s*$""", RegexOption.IGNORE_CASE).find(raw)
            ?: return Pair(raw.trim(), null)
        val emotion = match.groupValues[1].lowercase()
        val text = raw.substring(0, match.range.first).trim()
        return Pair(text, emotion)
    }

    fun chat(userText: String, memory: String): LlmResponse {
        val memoryLine = if (memory.isNotBlank())
            "\nLONG-TERM MEMORY (use naturally, never recite verbatim): $memory"
        else ""

        val systemPrompt = buildSystemPrompt(memoryLine)

        val messages = JSONArray()
        messages.put(JSONObject().put("role", "system").put("content", systemPrompt))
        conversationHistory.forEach { messages.put(it) }
        messages.put(JSONObject().put("role", "user").put("content", userText))

        val body = JSONObject()
            .put("model", model)
            .put("messages", messages)
            .put("stream", false)
            .put("max_tokens", 150)
            .toString()

        val request = Request.Builder()
            .url("$BASE_URL/chat/completions")
            .addHeader("Authorization", "Bearer ${apiKey()}")
            .addHeader("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) throw Exception("LLM error: HTTP ${response.code}")

        val json = JSONObject(response.body?.string() ?: throw Exception("Empty response body"))
        val raw = json.getJSONArray("choices")
            .getJSONObject(0)
            .getJSONObject("message")
            .getString("content")
            .trim()

        val (text, emotion) = parseEmotionTag(raw)

        conversationHistory.add(JSONObject().put("role", "user").put("content", userText))
        conversationHistory.add(JSONObject().put("role", "assistant").put("content", text))

        return LlmResponse(text, emotion)
    }

    fun transcribeAudio(audioFile: File): String {
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("model", "whisper-large-v3-turbo")
            .addFormDataPart("language", "en")
            .addFormDataPart("response_format", "text")
            .addFormDataPart(
                "file", audioFile.name,
                audioFile.asRequestBody("audio/m4a".toMediaType())
            )
            .build()

        val request = Request.Builder()
            .url("$BASE_URL/audio/transcriptions")
            .addHeader("Authorization", "Bearer ${apiKey()}")
            .post(requestBody)
            .build()

        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) throw Exception("STT error: HTTP ${response.code}")

        val raw = (response.body?.string() ?: throw Exception("Empty STT response")).trim()
        return if (WHISPER_HALLUCINATIONS.contains(raw.lowercase())) "" else raw
    }

    fun synthesizeSpeech(text: String): String {
        val cleanText = text.replace("[pause]", " ")

        val body = JSONObject()
            .put("model", "canopylabs/orpheus-v1-english")
            .put("voice", voiceName)
            .put("input", cleanText)
            .put("response_format", "wav")
            .toString()

        val request = Request.Builder()
            .url("$BASE_URL/audio/speech")
            .addHeader("Authorization", "Bearer ${apiKey()}")
            .addHeader("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) {
            val msg = response.body?.string() ?: ""
            if (response.code == 400 && (msg.contains("term", ignoreCase = true) || msg.contains("consent", ignoreCase = true))) {
                throw Exception("TTS_TERMS_NOT_ACCEPTED")
            }
            throw Exception("TTS error: HTTP ${response.code}")
        }

        val bytes = response.body?.bytes() ?: throw Exception("Empty TTS response")
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    fun maybeCompressMemory(
        userText: String,
        assistantText: String,
        existingMemory: String,
        onSave: (String) -> Unit
    ) {
        val turnThreshold = 10
        val tokenThreshold = 3000

        if (isCompressing) return
        val totalChars = conversationHistory.sumOf { it.getString("content").length }
        val shouldCompress = conversationHistory.size >= turnThreshold || totalChars / 4 > tokenThreshold
        if (!shouldCompress) return

        isCompressing = true
        val oldChat = conversationHistory.dropLast(4).joinToString("\n") {
            "${if (it.getString("role") == "user") "User" else companionName}: ${it.getString("content")}"
        }

        Thread {
            try {
                val messages = JSONArray()
                messages.put(
                    JSONObject()
                        .put("role", "system")
                        .put(
                            "content", "You are a memory assistant. Merge the conversation below into the existing memory summary.\n" +
                                "Rules:\n- Keep it under 220 characters, plain English, no bullet points, no JSON.\n" +
                                "- Preserve names, preferences, facts, moods, and key topics.\n" +
                                "- If a fact changed, update it. Output ONLY the updated memory string."
                        )
                )
                messages.put(
                    JSONObject()
                        .put("role", "user")
                        .put(
                            "content",
                            "Existing memory: ${existingMemory.ifBlank { "none" }}\n\nConversation to compress:\n$oldChat\n\nUpdated memory:"
                        )
                )

                val body = JSONObject()
                    .put("model", "llama-3.1-8b-instant")
                    .put("messages", messages)
                    .put("stream", false)
                    .put("max_tokens", 130)
                    .toString()

                val request = Request.Builder()
                    .url("$BASE_URL/chat/completions")
                    .addHeader("Authorization", "Bearer ${apiKey()}")
                    .addHeader("Content-Type", "application/json")
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()

                val response = httpClient.newCall(request).execute()
                val newMemory = if (response.isSuccessful) {
                    val json = JSONObject(response.body?.string() ?: "")
                    json.getJSONArray("choices").getJSONObject(0).getJSONObject("message")
                        .getString("content").trim()
                } else existingMemory

                // Trim compressed messages from history, keep only the last 4 turns
                if (conversationHistory.size > 4) {
                    val keep = conversationHistory.takeLast(4)
                    conversationHistory.clear()
                    conversationHistory.addAll(keep)
                }

                onSave(newMemory)
            } catch (e: Exception) {
                onSave(existingMemory)
            } finally {
                isCompressing = false
            }
        }.start()
    }
}
