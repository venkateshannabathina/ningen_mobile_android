package com.venkateshannabathina.ningen

import android.content.Context

data class MemoryState(val compressed: String)

class MemoryManager(context: Context) {

    private val prefs = context.getSharedPreferences("pixie_memory", Context.MODE_PRIVATE)

    fun load(): MemoryState {
        val compressed = prefs.getString("compressed", "") ?: ""
        return MemoryState(compressed)
    }

    fun save(compressed: String) {
        prefs.edit()
            .putString("compressed", compressed)
            .putLong("updatedAt", System.currentTimeMillis())
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    fun getSummary(): String = prefs.getString("compressed", "") ?: ""
}
