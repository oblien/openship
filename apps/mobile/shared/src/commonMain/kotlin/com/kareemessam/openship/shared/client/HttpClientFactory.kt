package com.kareemessam.openship.shared.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.plugins.sse.SSE
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

object HttpClientFactory {
    val tolerantJson = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        coerceInputValues = true
    }

    fun create(engineFactory: HttpClientEngineFactory<*> = getPlatformEngine()): HttpClient {
        return HttpClient(engineFactory) {
            install(SSE) {
                showCommentEvents()
                showRetryEvents()
            }
            install(ContentNegotiation) {
                json(tolerantJson)
            }
            install(HttpTimeout) {
                requestTimeoutMillis = 30_000
                connectTimeoutMillis = 15_000
                socketTimeoutMillis = 60_000
            }
            install(Logging) {
                level = LogLevel.HEADERS
                logger = object : Logger {
                    override fun log(message: String) {
                        // Avoid logging sensitive Authorization headers in production
                        val sanitized = if (message.contains("Authorization", ignoreCase = true)) {
                            message.replace(Regex("Bearer\\s+[A-Za-z0-9_.-]+"), "Bearer [REDACTED]")
                        } else {
                            message
                        }
                        println("[Ktor] $sanitized")
                    }
                }
            }
        }
    }
}
