package com.kareemessam.openship.shared.viewmodel

import com.kareemessam.openship.shared.client.DeployActionsRepository
import com.kareemessam.openship.shared.client.DeploymentsRepository
import com.kareemessam.openship.shared.client.DiscoveryService
import com.kareemessam.openship.shared.client.HttpClientFactory
import com.kareemessam.openship.shared.client.McpClient
import com.kareemessam.openship.shared.model.DeploymentDto
import com.kareemessam.openship.shared.model.InstanceConfig
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
class DeploymentHistoryViewModelTest {

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
        label = "Local",
        url = "http://localhost:4000",
        pat = "opsh_pat_test"
    )

    private fun deployment(id: String, status: String, createdAt: String? = "2026-08-20T10:00:00.000Z") =
        DeploymentDto(
            id = id,
            projectId = "proj_1",
            branch = "main",
            commitSha = "abc1234",
            commitMessage = "msg",
            status = status,
            createdAt = createdAt
        )

    private fun mcpClient() = McpClient(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create()))

    private class FakeDeployActionsRepository(mcpClient: McpClient) : DeployActionsRepository(mcpClient) {
        var available: Boolean = false
        var result: Result<String?> = Result.success(null)
        var gate: CompletableDeferred<Unit>? = null

        override fun isRollbackAvailable() = available

        override suspend fun rollback(instance: InstanceConfig, deploymentId: String): Result<String?> {
            gate?.await()
            return result
        }
    }

    private fun fakeDeployments(result: Result<List<DeploymentDto>>) =
        object : DeploymentsRepository(HttpClientFactory.create(), DiscoveryService(HttpClientFactory.create())) {
            override suspend fun getDeploymentHistory(
                instance: InstanceConfig,
                projectId: String
            ): Result<List<DeploymentDto>> = result
        }

    private fun createVm(
        deployActions: DeployActionsRepository = FakeDeployActionsRepository(mcpClient()),
        deployments: Result<List<DeploymentDto>> = Result.success(emptyList())
    ) = DeploymentHistoryViewModel(fakeDeployments(deployments), deployActions)

    // ── history loading ────────────────────────────────────────────────

    @Test
    fun loadHistory_emits_loading_then_loaded() {
        val gate = CompletableDeferred<Unit>()
        val repo = object : DeploymentsRepository(
            HttpClientFactory.create(),
            DiscoveryService(HttpClientFactory.create())
        ) {
            override suspend fun getDeploymentHistory(
                instance: InstanceConfig,
                projectId: String
            ): Result<List<DeploymentDto>> {
                gate.await()
                return Result.success(listOf(deployment("dep_1", "ready")))
            }
        }
        val vm = DeploymentHistoryViewModel(repo, FakeDeployActionsRepository(mcpClient()))

        vm.loadHistory(instance, "proj_1")
        assertTrue(vm.state.value.isLoading)
        assertEquals("proj_1", vm.state.value.projectId)

        gate.complete(Unit)
        assertFalse(vm.state.value.isLoading)
        assertEquals(1, vm.state.value.deployments.size)
        assertNull(vm.state.value.error)
    }

    @Test
    fun loadHistory_empty_state() {
        val vm = createVm(deployments = Result.success(emptyList()))
        vm.loadHistory(instance, "proj_1")
        assertFalse(vm.state.value.isLoading)
        assertTrue(vm.state.value.deployments.isEmpty())
        assertNull(vm.state.value.error)
    }

    @Test
    fun loadHistory_error_state() {
        val vm = createVm(deployments = Result.failure(Exception("connection refused")))
        vm.loadHistory(instance, "proj_1")
        assertFalse(vm.state.value.isLoading)
        assertEquals("connection refused", vm.state.value.error)
        assertTrue(vm.state.value.deployments.isEmpty())
    }

    @Test
    fun selectDeployment_and_clearSelection() {
        val vm = createVm()
        assertNull(vm.state.value.selectedDeploymentId)
        vm.selectDeployment("dep_2")
        assertEquals("dep_2", vm.state.value.selectedDeploymentId)
        vm.clearSelection()
        assertNull(vm.state.value.selectedDeploymentId)
    }

    // ── rollback eligibility ───────────────────────────────────────────

    @Test
    fun isRollbackEligible_ready_not_active() {
        assertTrue(isRollbackEligible(deployment("a", "ready"), "b"))
        assertTrue(isRollbackEligible(deployment("a", "success"), "b"))
        assertFalse(isRollbackEligible(deployment("a", "failed"), "b"))
        assertFalse(isRollbackEligible(deployment("a", "building"), "b"))
        assertFalse(isRollbackEligible(deployment("a", "ready"), "a")) // active → not eligible
    }

    @Test
    fun eligibleForRollback_reads_active_from_state() {
        val vm = createVm()
        vm.loadHistory(instance, "proj_1", activeDeploymentId = "dep_active")
        assertTrue(vm.eligibleForRollback(deployment("dep_other", "ready")))
        assertFalse(vm.eligibleForRollback(deployment("dep_active", "ready")))
    }

    // ── rollback action ────────────────────────────────────────────────

    @Test
    fun onRollbackClick_sets_target_and_cancel_clears_it() {
        val vm = createVm()
        vm.onRollbackClick(deployment("dep_1", "ready"))
        assertEquals("dep_1", vm.state.value.rollbackTarget?.id)

        vm.cancelRollback()
        assertNull(vm.state.value.rollbackTarget)
    }

    @Test
    fun confirmRollback_success_sets_deployment_id_and_clears_loading() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { result = Result.success("dep_new") }
        val vm = createVm(deployActions = repo)
        vm.loadHistory(instance, "proj_1")
        vm.onRollbackClick(deployment("dep_1", "ready"))
        vm.confirmRollback()

        assertEquals("dep_new", vm.state.value.rollbackResultDeploymentId)
        assertFalse(vm.state.value.rollbackLoading)
        assertNull(vm.state.value.rollbackError)
    }

    @Test
    fun confirmRollback_loading_state_transitions() {
        val gate = CompletableDeferred<Unit>()
        val repo = FakeDeployActionsRepository(mcpClient()).apply {
            result = Result.success("dep_new")
            this.gate = gate
        }
        val vm = createVm(deployActions = repo)
        vm.loadHistory(instance, "proj_1")
        vm.onRollbackClick(deployment("dep_1", "ready"))
        vm.confirmRollback()

        assertTrue(vm.state.value.rollbackLoading)

        gate.complete(Unit)
        assertFalse(vm.state.value.rollbackLoading)
        assertEquals("dep_new", vm.state.value.rollbackResultDeploymentId)
    }

    @Test
    fun confirmRollback_failure_sets_error_and_keeps_dialog() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply {
            result = Result.failure(Exception("rollback boom"))
        }
        val vm = createVm(deployActions = repo)
        vm.loadHistory(instance, "proj_1")
        vm.onRollbackClick(deployment("dep_1", "ready"))
        vm.confirmRollback()

        assertEquals("rollback boom", vm.state.value.rollbackError)
        assertFalse(vm.state.value.rollbackLoading)
        assertNull(vm.state.value.rollbackResultDeploymentId)
        // Dialog stays open so the user can retry.
        assertEquals("dep_1", vm.state.value.rollbackTarget?.id)
    }

    @Test
    fun consumeRollbackResult_clears_deployment_id_and_target() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { result = Result.success("dep_new") }
        val vm = createVm(deployActions = repo)
        vm.loadHistory(instance, "proj_1")
        vm.onRollbackClick(deployment("dep_1", "ready"))
        vm.confirmRollback()
        assertEquals("dep_new", vm.state.value.rollbackResultDeploymentId)

        vm.consumeRollbackResult()
        assertNull(vm.state.value.rollbackResultDeploymentId)
        assertNull(vm.state.value.rollbackTarget)
    }

    @Test
    fun refreshRollbackAvailability_reflects_repo() {
        val repo = FakeDeployActionsRepository(mcpClient()).apply { available = true }
        val vm = createVm(deployActions = repo)
        vm.loadHistory(instance, "proj_1")
        assertTrue(vm.state.value.rollbackAvailable)

        repo.available = false
        vm.refreshRollbackAvailability()
        assertFalse(vm.state.value.rollbackAvailable)
    }

    // ── relative age formatting ────────────────────────────────────────

    @Test
    fun formatRelativeAge_computes_units_from_epoch_anchor() {
        val anchor = 946_684_800_000L // 2000-01-01T00:00:00Z
        assertEquals("3h ago", formatRelativeAge("2000-01-01T00:00:00.000Z", anchor + 3 * 3_600_000L))
        assertEquals("2d ago", formatRelativeAge("2000-01-01T00:00:00.000Z", anchor + 2 * 86_400_000L))
        assertEquals("just now", formatRelativeAge("2000-01-01T00:00:00.000Z", anchor + 10_000L))
        assertEquals("", formatRelativeAge(null, anchor))
    }

    @Test
    fun parseIsoToMillis_matches_known_epochs() {
        assertEquals(946_684_800_000L, parseIsoToMillis("2000-01-01T00:00:00.000Z"))
        assertEquals(0L, parseIsoToMillis("1970-01-01T00:00:00.000Z"))
        // 02:00 +02:00 == 00:00 UTC == epoch anchor
        assertEquals(946_684_800_000L, parseIsoToMillis("2000-01-01T02:00:00.000+02:00"))
        assertNull(parseIsoToMillis("not-a-date"))
    }
}
