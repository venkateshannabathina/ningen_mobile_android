package com.venkateshannabathina.ningen

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

class AudioRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    fun startRecording() {
        if (recorder != null) cancelRecording()
        val file = File(context.cacheDir, "pixie_recording_${System.currentTimeMillis()}.m4a")
        outputFile = file

        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        rec.apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(16000)
            setAudioChannels(1)
            setAudioEncodingBitRate(128000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }

        recorder = rec
    }

    fun stopRecording(): File? {
        val rec = recorder ?: return null
        val file = outputFile
        return try {
            rec.stop()
            rec.release()
            recorder = null
            outputFile = null
            if (file != null && file.exists() && file.length() > 0) file else null
        } catch (e: Exception) {
            rec.release()
            recorder = null
            outputFile = null
            file?.delete()
            null
        }
    }

    fun cancelRecording() {
        try {
            recorder?.stop()
        } catch (_: Exception) {}
        recorder?.release()
        recorder = null
        outputFile?.delete()
        outputFile = null
    }
}
