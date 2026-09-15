package com.kareemessam.openship.shared.model.sse

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
sealed class DeployStreamEvent {

    @Serializable
    @SerialName("log")
    data class Log(
        val data: String = "",
        val eventId: Long = 0L,
        val step: String? = null,
        val stepStatus: String? = null,
        val level: String? = null,
        val serviceName: String? = null,
        val serviceId: String? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("progress")
    data class Progress(
        val step: String? = null,
        val stepStatus: String? = null,
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("service-status")
    data class ServiceStatus(
        val serviceName: String? = null,
        val serviceId: String? = null,
        val status: String? = null, // pending|building|built|deploying|running|failed
        val error: String? = null,
        val containerId: String? = null,
        val hostPort: Int? = null,
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("complete")
    data class Complete(
        val status: String? = "ready",
        val portCheck: JsonElement? = null,
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("cancelled")
    data class Cancelled(
        val message: String? = "Build cancelled",
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("end")
    data class End(
        val status: String? = null,
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("error")
    data class Error(
        val error: String? = null,
        val message: String? = null,
        val eventId: Long? = null
    ) : DeployStreamEvent()

    @Serializable
    @SerialName("ping")
    object Ping : DeployStreamEvent()

    @Serializable
    @SerialName("unknown")
    data class Unknown(
        val raw: String? = null
    ) : DeployStreamEvent()
}
