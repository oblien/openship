package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.model.HealthEnv
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.isSuccess

class DiscoveryService(private val httpClient: HttpClient) {

    fun normalizeUrl(rawUrl: String): String {
        var url = rawUrl.trim()
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
            url = "http://$url"
        }
        return url.removeSuffix("/")
    }

    suspend fun discoverInstance(rawUrl: String): Result<HealthEnv> {
        return try {
            val baseUrl = normalizeUrl(rawUrl)
            val response = httpClient.get("$baseUrl/api/health/env")
            if (response.status.isSuccess()) {
                val healthEnv = response.body<HealthEnv>()
                Result.success(healthEnv)
            } else {
                Result.failure(Exception("Discovery returned status code: ${response.status.value}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
