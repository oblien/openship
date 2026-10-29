package com.kareemessam.openship.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class ServerItemDto(
    val id: String,
    val name: String? = "This Server",
    val isLocal: Boolean? = true,
    val sshHost: String? = null,
    val country: String? = null,
    val projectCount: Int? = 0
)

@Serializable
data class MonitorStatsDto(
    val cpu: Double? = 0.0,
    val memTotal: Long? = 0L,
    val memUsed: Long? = 0L,
    val memAvail: Long? = 0L,
    val diskTotal: Long? = 0L,
    val diskUsed: Long? = 0L,
    val diskAvail: Long? = 0L,
    val uptime: JsonElement? = null,
    val load1: JsonElement? = null,
    val load5: JsonElement? = null,
    val load15: JsonElement? = null
) {
    val uptimeSeconds: Long
        get() = try {
            uptime?.jsonPrimitive?.content?.toDoubleOrNull()?.toLong() ?: 0L
        } catch (e: Exception) {
            0L
        }

    val load1Val: Double
        get() = try {
            load1?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0
        } catch (e: Exception) {
            0.0
        }

    val load5Val: Double
        get() = try {
            load5?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0
        } catch (e: Exception) {
            0.0
        }

    val load15Val: Double
        get() = try {
            load15?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0
        } catch (e: Exception) {
            0.0
        }

    val memPercentage: Float
        get() = if (memTotal != null && memTotal > 0 && memUsed != null) {
            ((memUsed.toDouble() / memTotal.toDouble()) * 100).coerceIn(0.0, 100.0).toFloat()
        } else 0f

    val diskPercentage: Float
        get() = if (diskTotal != null && diskTotal > 0 && diskUsed != null) {
            ((diskUsed.toDouble() / diskTotal.toDouble()) * 100).coerceIn(0.0, 100.0).toFloat()
        } else 0f
}
