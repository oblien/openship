package com.kareemessam.openship.shared.viewmodel

import com.kareemessam.openship.shared.client.DeployActionsRepository
import com.kareemessam.openship.shared.client.DiscoveryService
import com.kareemessam.openship.shared.client.HttpClientFactory
import com.kareemessam.openship.shared.client.McpClient
import com.kareemessam.openship.shared.client.McpConnectionManager
import com.kareemessam.openship.shared.client.ProjectsRepository
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.model.ProjectStatus
import com.kareemessam.openship.shared.model.ProjectSummary
import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ProjectsViewModelRedeployTest {

    @BeforeTest
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @AfterTest
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private val instance = InstanceConfig(
        id = "inst_1",
        label = "test",
        url = "http://127.0.0.1:1",
        pat = ""
    )

    private val project = ProjectSummary(
        id = "proj_1",
        name = "web",
        slug = "web",
        framework = "nextjs",
        gitRepo = "o/r",
        gitBranch = "main",
        port = 8080,
        hostPort = 8080,
        status = ProjectStatus.READY,
        statusText = "Ready",
        activeDeploymentId = "dep_abc",
        commitMessage = null,
        commitShaShort = null,
        updatedAt = null
    )

    private class FakeTokenStorage(private val instances: List<InstanceConfig>) : TokenStorage {
        override suspend fun saveInstance(config: InstanceConfig) {}
        override suspend fun loadInstances(): List<InstanceConfig> = instances
        override suspend fun getActiveInstance(): InstanceConfig? = instances.firstOrNull()
        override suspend fun setActiveInstance(id: String) {}
        override suspend fun deleteInstance(id: String) {}
        override suspend fun clearAll() {}
    }

    private class FakeDeployActionsRepository(
        mcpClient: McpClient
    ) : DeployActionsRepository(mcpClient) {
        var available: Boolean = true
        var result: Result<String?> = Result.success(null)
        var gate: CompletableDeferred<Unit>? = null

        override fun isRedeployAvailable() = available

        override suspend fun redeploy(instance: InstanceConfig, project: ProjectSummary): Result<String?> {
            gate?.await()
            return result
        }
    }

    private fun createVm(deployRepo: DeployActionsRepository): ProjectsViewModel {
        val http = HttpClientFactory.create()
        val projectsRepository = ProjectsRepository(http, DiscoveryService(http))
        val tokenStorage = FakeTokenStorage(listOf(instance))
        val mcp = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))
        return ProjectsViewModel(projectsRepository, tokenStorage, deployRepo, McpConnectionManager(mcp, tokenStorage))
    }

    private fun mcpClient() = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))

    @Test
    fun onRedeployClick_sets_target_and_cancel_clears_it() {
        val vm = createVm(FakeDeployActionsRepository(mcpClient()))
        vm.onRedeployClick(project)
        assertEquals(project, vm.state.value.redeployTarget)

        vm.cancelRedeploy()
        assertNull(vm.state.value.redeployTarget)
    }

    @Test
    fun confirmRedeploy_success_sets_deployment_id_and_clears_loading() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { result = Result.success("dep_new") }
        val vm = createVm(repo)
        vm.onRedeployClick(project)
        vm.confirmRedeploy()

        assertEquals("dep_new", vm.state.value.redeployResultDeploymentId)
        assertFalse(vm.state.value.redeployLoading)
        assertNull(vm.state.value.redeployError)
    }

    @Test
    fun confirmRedeploy_loading_state_transitions() {
        val gate = CompletableDeferred<Unit>()
        val repo = FakeDeployActionsRepository(mcpClient()).apply {
            result = Result.success("dep_new")
            this.gate = gate
        }
        val vm = createVm(repo)
        vm.onRedeployClick(project)
        vm.confirmRedeploy()

        assertTrue(vm.state.value.redeployLoading)

        gate.complete(Unit)
        assertFalse(vm.state.value.redeployLoading)
        assertEquals("dep_new", vm.state.value.redeployResultDeploymentId)
    }

    @Test
    fun confirmRedeploy_failure_sets_error_and_keeps_dialog() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply {
            result = Result.failure(Exception("redeploy boom"))
        }
        val vm = createVm(repo)
        vm.onRedeployClick(project)
        vm.confirmRedeploy()

        assertEquals("redeploy boom", vm.state.value.redeployError)
        assertFalse(vm.state.value.redeployLoading)
        assertNull(vm.state.value.redeployResultDeploymentId)
        // Dialog stays open so the user can retry.
        assertEquals(project, vm.state.value.redeployTarget)
    }

    @Test
    fun consumeRedeployResult_clears_deployment_id_and_target() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { result = Result.success("dep_new") }
        val vm = createVm(repo)
        vm.onRedeployClick(project)
        vm.confirmRedeploy()
        assertEquals("dep_new", vm.state.value.redeployResultDeploymentId)

        vm.consumeRedeployResult()
        assertNull(vm.state.value.redeployResultDeploymentId)
        assertNull(vm.state.value.redeployTarget)
    }

    @Test
    fun refreshRedeployAvailability_reflects_repo() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { available = false }
        val vm = createVm(repo)
        assertFalse(vm.state.value.redeployAvailable)
    }
}
