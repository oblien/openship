package com.kareemessam.openship.shared.client

import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface McpState {
    data object Disconnected : McpState
    data object Connecting : McpState
    data object Connected : McpState
    data class Failed(val error: Throwable) : McpState
}

class McpConnectionManager(
    private val mcpClient: McpClient,
    private val tokenStorage: TokenStorage
) {
    private val _connectionState = MutableStateFlow<McpState>(McpState.Disconnected)
    val connectionState: StateFlow<McpState> = _connectionState.asStateFlow()

    suspend fun connectActive() {
        val instance = tokenStorage.getActiveInstance() ?: return
        if (mcpClient.isConnected) return
        _connectionState.value = McpState.Connecting
        mcpClient.connect(instance)
            .onSuccess { _connectionState.value = McpState.Connected }
            .onFailure { _connectionState.value = McpState.Failed(it) }
    }

    suspend fun disconnect() {
        mcpClient.disconnect()
        _connectionState.value = McpState.Disconnected
    }
}
