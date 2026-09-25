package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.MonitorStatsDto
import com.kareemessam.openship.shared.model.ServerItemDto
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json

class MonitorRepository(
    private val httpClient: HttpClient,
    private val discoveryService: DiscoveryService,
    private val json: Json = HttpClientFactory.tolerantJson
) {

    suspend fun getServers(instance: InstanceConfig): Result<List<ServerItemDto>> = runCatching {
        val baseUrl = discoveryService.normalizeUrl(instance.url)
        val url = "$baseUrl/api/system/servers"

        val response: List<ServerItemDto> = httpClient.get(url) {
            if (instance.pat.isNotBlank()) {
                header(HttpHeaders.Authorization, "Bearer ${instance.pat}")
            }
        }.body()

        response
    }

    fun streamServerStats(instance: InstanceConfig, serverId: String): Flow<MonitorStatsDto> = flow {
        var retryDelayMs = 1000L
        val maxRetryDelayMs = 30_000L
        var consecutiveErrors = 0
        val maxConsecutiveErrors = 5

        while (consecutiveErrors < maxConsecutiveErrors) {
            try {
                val baseUrl = discoveryService.normalizeUrl(instance.url)
                val url = "$baseUrl/api/system/monitor/stream?serverId=$serverId"

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
                    incoming.collect { event ->
                        val data = event.data ?: ""
                        val eventType = event.event ?: ""

                        if (data.isNotBlank()) {
                            try {
                                if (eventType == "stats" || eventType.isBlank() || data.contains("\"cpu\"")) {
                                    val stats = json.decodeFromString<MonitorStatsDto>(data)
                                    emit(stats)
                                    consecutiveErrors = 0
                                    retryDelayMs = 1000L
                                }
                            } catch (_: Exception) {
                                // Non-fatal JSON decode error for single event
                            }
                        }
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
    }.flowOn(Dispatchers.IO)
}

