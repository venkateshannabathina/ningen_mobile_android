package com.venkateshannabathina.ningen

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class VrmManager(private val context: Context) {

    private val vrmDir = File(context.filesDir, "vrm")
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    companion object {
        private const val ASSETS_BASE = "https://github.com/venkateshannabathina/project-panda/releases/download/v0"
        private const val VRM_BASE_URL = "https://appassets.androidplatform.net/vrm"

        private val ANIM_NAMES = listOf(
            "showfullbody.vrma", "greeting.vrma", "spin.vrma",
            "peacesign.vrma", "shoot.vrma", "VRMA_06.vrma", "VRMA_07.vrma"
        )
    }

    init {
        vrmDir.mkdirs()
    }

    data class VrmAssets(val vrmUri: String, val animations: Map<String, String>)

    fun ensureVrm(companion: String): VrmAssets {
        val vrmName = when (companion) {
            "male" -> "male.vrm"
            "custom" -> {
                val customFile = File(vrmDir, "custom.vrm")
                if (customFile.exists()) "custom.vrm" else "female.vrm"
            }
            else -> "female.vrm"
        }

        val filesToEnsure = if (vrmName == "custom.vrm") ANIM_NAMES else listOf(vrmName) + ANIM_NAMES
        filesToEnsure.forEach { name ->
            val dest = File(vrmDir, name)
            if (!dest.exists() || dest.length() == 0L) {
                downloadFile("$ASSETS_BASE/$name", dest)
            }
        }

        fun toUri(name: String) = "$VRM_BASE_URL/$name"

        val animations = mapOf(
            "intro" to toUri("showfullbody.vrma"),
            "greeting" to toUri("greeting.vrma"),
            "spin" to toUri("spin.vrma"),
            "peacesign" to toUri("peacesign.vrma"),
            "shoot" to toUri("shoot.vrma"),
            "vrma06" to toUri("VRMA_06.vrma"),
            "vrma07" to toUri("VRMA_07.vrma")
        )

        return VrmAssets(toUri(vrmName), animations)
    }

    fun saveCustomVrm(data: ByteArray) {
        val dest = File(vrmDir, "custom.vrm")
        dest.writeBytes(data)
    }

    private fun downloadFile(url: String, dest: File) {
        val request = Request.Builder().url(url).build()
        val response = httpClient.newCall(request).execute()
        if (!response.isSuccessful) throw Exception("Download failed for $url: HTTP ${response.code}")
        response.body!!.byteStream().use { input ->
            dest.outputStream().use { output ->
                input.copyTo(output)
            }
        }
    }
}
