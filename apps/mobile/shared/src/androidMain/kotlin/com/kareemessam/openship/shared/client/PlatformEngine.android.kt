package com.kareemessam.openship.shared.client

import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.okhttp.OkHttp

actual fun getPlatformEngine(): HttpClientEngineFactory<*> = OkHttp
