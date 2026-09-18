package com.kareemessam.openship.shared.storage

import com.kareemessam.openship.shared.model.InstanceConfig

interface TokenStorage {
    suspend fun saveInstance(config: InstanceConfig)
    suspend fun loadInstances(): List<InstanceConfig>
    suspend fun getActiveInstance(): InstanceConfig?
    suspend fun setActiveInstance(id: String)
    suspend fun deleteInstance(id: String)
    suspend fun clearAll()
}
