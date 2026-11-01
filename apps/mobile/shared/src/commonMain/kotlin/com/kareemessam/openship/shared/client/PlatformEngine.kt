package com.kareemessam.openship.shared.client

import io.ktor.client.engine.HttpClientEngineFactory

expect fun getPlatformEngine(): HttpClientEngineFactory<*>
