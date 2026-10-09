package com.kareemessam.openship.shared.viewmodel

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kareemessam.openship.shared.client.DeployActionsRepository
import com.kareemessam.openship.shared.client.McpConnectionManager
import com.kareemessam.openship.shared.client.McpState
import com.kareemessam.openship.shared.client.ProjectsRepository
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.ProjectSummary
import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@Immutable
data class ProjectsUiState(
    val activeInstance: InstanceConfig? = null,
    val allInstances: List<InstanceConfig> = emptyList(),
    val projects: List<ProjectSummary> = emptyList(),
    val searchQuery: String = "",
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val redeployAvailable: Boolean = false,
    val redeployTarget: ProjectSummary? = null,
    val redeployLoading: Boolean = false,
    val redeployError: String? = null,
    val redeployResultDeploymentId: String? = null
)

class ProjectsViewModel(
    private val projectsRepository: ProjectsRepository,
    private val tokenStorage: TokenStorage,
    private val deployActionsRepository: DeployActionsRepository,
    private val mcpConnectionManager: McpConnectionManager
) : ViewModel() {

    private val _state = MutableStateFlow(ProjectsUiState())
    val state: StateFlow<ProjectsUiState> = _state.asStateFlow()

    init {
        loadInstancesAndProjects()
        // MCP connect finishes asynchronously after first composition — re-check
        // tool availability once the catalog is populated (also covers foreground reconnect).
        viewModelScope.launch {
            mcpConnectionManager.connectionState.collect { state ->
                if (state == McpState.Connected) refreshRedeployAvailability()
            }
        }
    }

    fun loadInstancesAndProjects() {
        viewModelScope.launch {
            val instances = tokenStorage.loadInstances()
            val active = tokenStorage.getActiveInstance() ?: instances.firstOrNull()

            _state.update {
                it.copy(
                    activeInstance = active,
                    allInstances = instances
                )
            }
            refreshRedeployAvailability()

            if (active != null) {
                fetchProjects(active, isRefresh = false)
            } else {
                _state.update { it.copy(isLoading = false, projects = emptyList()) }
            }
        }
    }

    fun refreshRedeployAvailability() {
        _state.update { it.copy(redeployAvailable = deployActionsRepository.isRedeployAvailable()) }
    }

    fun refresh() {
        val active = _state.value.activeInstance ?: return
        fetchProjects(active, isRefresh = true)
    }

    fun onSearchQueryChanged(query: String) {
        _state.update { it.copy(searchQuery = query) }
    }

    fun switchInstance(instanceId: String) {
        viewModelScope.launch {
            tokenStorage.setActiveInstance(instanceId)
            loadInstancesAndProjects()
        }
    }

    fun deleteInstance(instanceId: String) {
        viewModelScope.launch {
            tokenStorage.deleteInstance(instanceId)
            loadInstancesAndProjects()
        }
    }

    fun onRedeployClick(project: ProjectSummary) {
        _state.update { it.copy(redeployTarget = project, redeployError = null) }
    }

    fun confirmRedeploy() {
        val instance = _state.value.activeInstance ?: return
        val project = _state.value.redeployTarget ?: return
        viewModelScope.launch {
            _state.update { it.copy(redeployLoading = true, redeployError = null) }
            deployActionsRepository.redeploy(instance, project)
                .onSuccess { deploymentId ->
                    _state.update {
                        it.copy(
                            redeployLoading = false,
                            redeployError = null,
                            redeployResultDeploymentId = deploymentId,
                            // Keep the target so the UI can navigate with the project;
                            // close the dialog when no id could be extracted (refresh-only success).
                            redeployTarget = if (deploymentId != null) it.redeployTarget else null
                        )
                    }
                    fetchProjects(instance, isRefresh = true)
                }
                .onFailure { err ->
                    _state.update {
                        it.copy(
                            redeployLoading = false,
                            redeployError = err.message ?: "Redeploy failed."
                        )
                    }
                }
        }
    }

    fun cancelRedeploy() {
        _state.update { it.copy(redeployTarget = null, redeployError = null) }
    }

    fun consumeRedeployResult() {
        _state.update { it.copy(redeployResultDeploymentId = null, redeployTarget = null) }
    }

    private fun fetchProjects(instance: InstanceConfig, isRefresh: Boolean) {
        viewModelScope.launch {
            _state.update {
                if (isRefresh) it.copy(isRefreshing = true, error = null)
                else it.copy(isLoading = true, error = null)
            }

            val result = projectsRepository.getProjects(instance)
            result.onSuccess { list ->
                _state.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        projects = list,
                        error = null
                    )
                }
            }.onFailure { err ->
                _state.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = err.message ?: "Failed to load projects."
                    )
                }
            }
        }
    }
}
