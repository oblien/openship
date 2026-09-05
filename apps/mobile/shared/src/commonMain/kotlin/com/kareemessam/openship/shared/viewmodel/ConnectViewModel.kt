package com.kareemessam.openship.shared.viewmodel

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kareemessam.openship.shared.client.DiscoveryService
import com.kareemessam.openship.shared.model.HealthEnv
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@Immutable
data class ConnectUiState(
    val url: String = "http://10.0.2.2:4000",
    val label: String = "My Openship Server",
    val pat: String = "",
    val isProbing: Boolean = false,
    val discoveredEnv: HealthEnv? = null,
    val probeError: String? = null,
    val isConnecting: Boolean = false,
    val connectError: String? = null,
    val isSuccess: Boolean = false
)

class ConnectViewModel(
    private val discoveryService: DiscoveryService,
    private val tokenStorage: TokenStorage
) : ViewModel() {

    private val _state = MutableStateFlow(ConnectUiState())
    val state: StateFlow<ConnectUiState> = _state.asStateFlow()

    fun onUrlChanged(newUrl: String) {
        _state.update { it.copy(url = newUrl, discoveredEnv = null, probeError = null, connectError = null) }
    }

    fun onLabelChanged(newLabel: String) {
        _state.update { it.copy(label = newLabel) }
    }

    fun onPatChanged(newPat: String) {
        _state.update { it.copy(pat = newPat.trim(), connectError = null) }
    }

    fun probeUrl() {
        val currentUrl = _state.value.url.trim()
        if (currentUrl.isEmpty()) return

        viewModelScope.launch {
            _state.update { it.copy(isProbing = true, probeError = null, connectError = null) }
            val result = discoveryService.discoverInstance(currentUrl)
            result.onSuccess { env ->
                val suggestedLabel = env.machineName?.let { "$it (Openship)" }
                    ?: if (env.selfHosted) "Self-Hosted Openship" else "Openship Cloud"
                _state.update {
                    it.copy(
                        isProbing = false,
                        discoveredEnv = env,
                        label = if (it.label == "My Openship Server" || it.label.isBlank()) suggestedLabel else it.label,
                        probeError = null
                    )
                }
            }.onFailure { error ->
                _state.update {
                    it.copy(
                        isProbing = false,
                        discoveredEnv = null,
                        probeError = error.message ?: "Failed to connect to Openship instance."
                    )
                }
            }
        }
    }

    private fun validatePat(pat: String, authMode: String): String? {
        if (authMode == "none") return null
        if (pat.isBlank()) return "Personal Access Token is required"
        if (!pat.startsWith("opsh_pat_")) return "Token must start with 'opsh_pat_'"
        if (pat.length < 52) return "Token appears to be too short (expected opsh_pat_ + 43 characters)"
        return null
    }

    fun connect() {
        val currentState = _state.value
        val normalizedUrl = discoveryService.normalizeUrl(currentState.url)
        val pat = currentState.pat.trim()
        val env = currentState.discoveredEnv
        val authMode = env?.authMode ?: "local"

        val patError = validatePat(pat, authMode)
        if (patError != null) {
            _state.update { it.copy(connectError = patError) }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isConnecting = true, connectError = null) }
            try {
                val now = com.kareemessam.openship.shared.util.currentTimeMillis()
                val instanceId = "inst_$now"
                val config = InstanceConfig(
                    id = instanceId,
                    label = currentState.label.ifBlank { "Openship Server" },
                    url = normalizedUrl,
                    pat = pat,
                    authMode = authMode,
                    version = env?.version,
                    isDefault = tokenStorage.getActiveInstance() == null,
                    createdAt = now
                )
                tokenStorage.saveInstance(config)
                _state.update { it.copy(isConnecting = false, isSuccess = true) }
            } catch (e: Exception) {
                _state.update { it.copy(isConnecting = false, connectError = e.message ?: "Failed to save instance.") }
            }
        }
    }
}

