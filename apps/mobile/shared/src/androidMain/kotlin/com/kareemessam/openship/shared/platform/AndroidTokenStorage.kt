package com.kareemessam.openship.shared.platform

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class AndroidTokenStorage(context: Context) : TokenStorage {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "openship_secure_instances",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val activeInstanceKey = "__active_instance_id__"

    override suspend fun saveInstance(config: InstanceConfig): Unit = withContext(Dispatchers.IO) {
        val jsonStr = json.encodeToString(config)
        prefs.edit().putString(config.id, jsonStr).apply()

        if (config.isDefault || getActiveInstance() == null) {
            setActiveInstance(config.id)
        }
    }

    override suspend fun loadInstances(): List<InstanceConfig> = withContext(Dispatchers.IO) {
        val instances = mutableListOf<InstanceConfig>()
        val allEntries = prefs.all
        for ((key, value) in allEntries) {
            if (key == activeInstanceKey) continue
            if (value is String) {
                try {
                    val config = json.decodeFromString<InstanceConfig>(value)
                    instances.add(config)
                } catch (_: Exception) {
                    // Ignore corrupted or legacy entries
                }
            }
        }
        instances.sortedByDescending { it.createdAt }
    }

    override suspend fun getActiveInstance(): InstanceConfig? = withContext(Dispatchers.IO) {
        val activeId = prefs.getString(activeInstanceKey, null)
        if (activeId != null) {
            val jsonStr = prefs.getString(activeId, null)
            if (jsonStr != null) {
                try {
                    return@withContext json.decodeFromString<InstanceConfig>(jsonStr)
                } catch (_: Exception) {}
            }
        }
        loadInstances().firstOrNull()
    }

    override suspend fun setActiveInstance(id: String): Unit = withContext(Dispatchers.IO) {
        prefs.edit().putString(activeInstanceKey, id).apply()
    }

    override suspend fun deleteInstance(id: String): Unit = withContext(Dispatchers.IO) {
        prefs.edit().remove(id).apply()
        if (prefs.getString(activeInstanceKey, null) == id) {
            val remaining = loadInstances().firstOrNull { it.id != id }
            if (remaining != null) {
                setActiveInstance(remaining.id)
            } else {
                prefs.edit().remove(activeInstanceKey).apply()
            }
        }
    }

    override suspend fun clearAll(): Unit = withContext(Dispatchers.IO) {
        prefs.edit().clear().apply()
    }
}
