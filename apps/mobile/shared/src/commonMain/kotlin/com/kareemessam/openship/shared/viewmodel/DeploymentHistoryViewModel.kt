package com.kareemessam.openship.shared.viewmodel

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kareemessam.openship.shared.client.DeployActionsRepository
import com.kareemessam.openship.shared.client.DeploymentsRepository
import com.kareemessam.openship.shared.model.DeploymentDto
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.util.currentTimeMillis
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.datetime.Instant

@Immutable
data class DeploymentHistoryUiState(
    val isLoading: Boolean = false,
    val deployments: List<DeploymentDto> = emptyList(),
    val selectedDeploymentId: String? = null,
    val error: String? = null,
    val projectId: String? = null,
    val instance: InstanceConfig? = null,
    val activeDeploymentId: String? = null,
    val rollbackAvailable: Boolean = false,
    val rollbackTarget: DeploymentDto? = null,
    val rollbackLoading: Boolean = false,
    val rollbackError: String? = null,
    val rollbackResultDeploymentId: String? = null
) {
    val selectedDeployment: DeploymentDto?
        get() = deployments.firstOrNull { it.id == selectedDeploymentId }
}

/** Rollback-eligible when finished successfully and not the active deployment. */
internal fun isRollbackEligible(deployment: DeploymentDto, activeDeploymentId: String?): Boolean {
    val status = deployment.status?.lowercase()
    val ready = status == "ready" || status == "success"
    val active = activeDeploymentId != null && deployment.id == activeDeploymentId
    return ready && !active
}

class DeploymentHistoryViewModel(
    private val deploymentsRepository: DeploymentsRepository,
    private val deployActionsRepository: DeployActionsRepository
) : ViewModel() {

    private val _state = MutableStateFlow(DeploymentHistoryUiState())
    val state: StateFlow<DeploymentHistoryUiState> = _state.asStateFlow()

    fun loadHistory(instance: InstanceConfig, projectId: String, activeDeploymentId: String? = null) {
        _state.update {
            it.copy(
                isLoading = true,
                error = null,
                projectId = projectId,
                instance = instance,
                activeDeploymentId = activeDeploymentId,
                deployments = emptyList(),
                selectedDeploymentId = null
            )
        }
        refreshRollbackAvailability()
        fetchHistory(instance, projectId)
    }

    fun selectDeployment(id: String) {
        _state.update { it.copy(selectedDeploymentId = id) }
    }

    fun clearSelection() {
        _state.update { it.copy(selectedDeploymentId = null) }
    }

    fun eligibleForRollback(deployment: DeploymentDto): Boolean =
        isRollbackEligible(deployment, _state.value.activeDeploymentId)

    fun refreshRollbackAvailability() {
        _state.update { it.copy(rollbackAvailable = deployActionsRepository.isRollbackAvailable()) }
    }

    fun onRollbackClick(deployment: DeploymentDto) {
        _state.update { it.copy(rollbackTarget = deployment, rollbackError = null) }
    }

    fun confirmRollback() {
        val instance = _state.value.instance ?: return
        val target = _state.value.rollbackTarget ?: return
        viewModelScope.launch {
            _state.update { it.copy(rollbackLoading = true, rollbackError = null) }
            deployActionsRepository.rollback(instance, target.id)
                .onSuccess { deploymentId ->
                    _state.update {
                        it.copy(
                            rollbackLoading = false,
                            rollbackError = null,
                            rollbackResultDeploymentId = deploymentId,
                            // Keep target so the UI can navigate; close the dialog only
                            // when no id could be extracted (refresh-only success).
                            rollbackTarget = if (deploymentId != null) it.rollbackTarget else null
                        )
                    }
                    val projectId = _state.value.projectId ?: target.projectId
                    fetchHistory(instance, projectId)
                }
                .onFailure { err ->
                    _state.update {
                        it.copy(
                            rollbackLoading = false,
                            rollbackError = err.message ?: "Rollback failed."
                        )
                    }
                }
        }
    }

    fun cancelRollback() {
        _state.update { it.copy(rollbackTarget = null, rollbackError = null) }
    }

    fun consumeRollbackResult() {
        _state.update { it.copy(rollbackResultDeploymentId = null, rollbackTarget = null) }
    }

    private fun fetchHistory(instance: InstanceConfig, projectId: String) {
        viewModelScope.launch {
            deploymentsRepository.getDeploymentHistory(instance, projectId)
                .onSuccess { list ->
                    _state.update { it.copy(isLoading = false, deployments = list, error = null) }
                }
                .onFailure { err ->
                    _state.update {
                        it.copy(
                            isLoading = false,
                            deployments = emptyList(),
                            error = err.message ?: "Failed to load deployment history."
                        )
                    }
                }
        }
    }
}

/**
 * Formats an ISO-8601 timestamp as a short relative age ("3h ago", "2d ago").
 * Falls back to the raw string when it can't be parsed or is older than 30 days.
 */
internal fun formatRelativeAge(iso: String?, nowMillis: Long = currentTimeMillis()): String {
    if (iso.isNullOrBlank()) return ""
    val millis = parseIsoToMillis(iso) ?: return iso
    val minutes = (nowMillis - millis) / 60_000
    if (minutes < 0) return iso
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 1_440 -> "${minutes / 60}h ago"
        minutes < 43_200 -> "${minutes / 1_440}d ago"
        else -> iso
    }
}

internal fun parseIsoToMillis(iso: String): Long? = runCatching {
    Instant.parse(iso).toEpochMilliseconds()
}.getOrNull()

