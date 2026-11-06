package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.sse.DeployStreamEvent
import com.kareemessam.openship.shared.util.SeqTracker
import io.ktor.client.HttpClient
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json

class DeployLogsRepository(
    private val httpClient: HttpClient,
    private val discoveryService: DiscoveryService,
    private val json: Json = HttpClientFactory.tolerantJson
) {

    fun streamDeployLogs(
        instance: InstanceConfig,
        deploymentId: String,
        seqTracker: SeqTracker
    ): Flow<DeployStreamEvent> = flow {
        var retryDelayMs = 1000L
        val maxRetryDelayMs = 15_000L
        var consecutiveErrors = 0
        val maxConsecutiveErrors = 5

        while (consecutiveErrors < maxConsecutiveErrors) {
            try {
                val baseUrl = discoveryService.normalizeUrl(instance.url)
                val resumeSeq = seqTracker.getResumeParam()
                val url = if (resumeSeq != "0") {
                    "$baseUrl/api/deployments/$deploymentId/stream?since=$resumeSeq"
                } else {
                    "$baseUrl/api/deployments/$deploymentId/stream"
                }

                httpClient.sse(
                    urlString = url,
                    request = {
                        timeout {
                            socketTimeoutMillis = Long.MAX_VALUE
                            requestTimeoutMillis = Long.MAX_VALUE
                        }
                        if (instance.pat.isNotBlank()) {
                            header(HttpHeaders.Authorization, "Bearer ${instance.pat}")
                        }
                        header(HttpHeaders.Accept, "text/event-stream")
                    }
                ) {
                    incoming.collect { serverSentEvent ->
                        val eventType = serverSentEvent.event
                        val data = serverSentEvent.data ?: ""

                        if (data.isBlank() && eventType == "ping") {
                            emit(DeployStreamEvent.Ping)
                            return@collect
                        }

                        val event = try {
                            when (eventType) {
                                "progress" -> json.decodeFromString<DeployStreamEvent.Progress>(data)
                                "service-status" -> json.decodeFromString<DeployStreamEvent.ServiceStatus>(data)
                                "complete" -> json.decodeFromString<DeployStreamEvent.Complete>(data)
                                "cancelled" -> json.decodeFromString<DeployStreamEvent.Cancelled>(data)
                                "end" -> json.decodeFromString<DeployStreamEvent.End>(data)
                                "error" -> json.decodeFromString<DeployStreamEvent.Error>(data)
                                "ping" -> DeployStreamEvent.Ping
                                else -> {
                                    if (data.contains("\"type\":\"log\"") || data.contains("\"data\":")) {
                                        json.decodeFromString<DeployStreamEvent.Log>(data)
                                    } else if (data.contains("\"type\":\"progress\"")) {
                                        json.decodeFromString<DeployStreamEvent.Progress>(data)
                                    } else if (data.contains("\"type\":\"service-status\"")) {
                                        json.decodeFromString<DeployStreamEvent.ServiceStatus>(data)
                                    } else {
                                        DeployStreamEvent.Log(data = data)
                                    }
                                }
                            }
                        } catch (_: Exception) {
                            DeployStreamEvent.Log(data = data)
                        }

                        if (event is DeployStreamEvent.Log && event.eventId > 0) {
                            seqTracker.update(event.eventId)
                        }

                        emit(event)
                        consecutiveErrors = 0
                        retryDelayMs = 1000L
                    }
                }
                consecutiveErrors++
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                consecutiveErrors++
            }

            if (consecutiveErrors < maxConsecutiveErrors) {
                delay(retryDelayMs)
                retryDelayMs = (retryDelayMs * 2).coerceAtMost(maxRetryDelayMs)
            }
        }

        emit(DeployStreamEvent.Error(
            error = "connection_lost",
            message = "Stream disconnected after multiple retries"
        ))
    }.flowOn(Dispatchers.IO)
}

