package com.kareemessam.openship.shared.viewmodel

import com.kareemessam.openship.shared.client.DiscoveryService
import com.kareemessam.openship.shared.client.HttpClientFactory
import com.kareemessam.openship.shared.model.HealthEnv
import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.storage.TokenStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FakeTokenStorage : TokenStorage {
    private val instances = mutableListOf<InstanceConfig>()
    private var activeId: String? = null

    override suspend fun saveInstance(config: InstanceConfig) {
        instances.removeAll { it.id == config.id }
        instances.add(config)
        activeId = config.id
    }

    override suspend fun loadInstances(): List<InstanceConfig> = instances.toList()

    override suspend fun getActiveInstance(): InstanceConfig? = instances.firstOrNull { it.id == activeId }

    override suspend fun setActiveInstance(id: String) {
        activeId = id
    }

    override suspend fun deleteInstance(id: String) {
        instances.removeAll { it.id == id }
        if (activeId == id) activeId = instances.firstOrNull()?.id
    }

    override suspend fun clearAll() {
        instances.clear()
        activeId = null
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private val storage = FakeTokenStorage()
    private val discovery = DiscoveryService(HttpClientFactory.create())

    @BeforeTest
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @AfterTest
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun initialState_hasSensibleDefaults() {
        val vm = ConnectViewModel(discovery, storage)
        val state = vm.state.value

        assertEquals("http://10.0.2.2:4000", state.url)
        assertEquals("My Openship Server", state.label)
        assertEquals("", state.pat)
        assertFalse(state.isProbing)
        assertFalse(state.isConnecting)
        assertFalse(state.isSuccess)
        assertNull(state.probeError)
        assertNull(state.connectError)
    }

    @Test
    fun onUrlChanged_resetsErrorsAndDiscoveredEnv() {
        val vm = ConnectViewModel(discovery, storage)
        vm.onUrlChanged("http://192.168.1.100:4000")

        assertEquals("http://192.168.1.100:4000", vm.state.value.url)
        assertNull(vm.state.value.probeError)
        assertNull(vm.state.value.discoveredEnv)
    }

    @Test
    fun onPatChanged_trimsWhitespaceAndClearsConnectError() {
        val vm = ConnectViewModel(discovery, storage)
        vm.onPatChanged("   opsh_pat_1234567890123456789012345678901234567890123   ")

        assertEquals("opsh_pat_1234567890123456789012345678901234567890123", vm.state.value.pat)
        assertNull(vm.state.value.connectError)
    }

    @Test
    fun connect_failsWhenPatIsBlankAndAuthModeIsRequired() = runTest(testDispatcher) {
        val vm = ConnectViewModel(discovery, storage)
        vm.onPatChanged("")
        vm.connect()

        assertEquals("Personal Access Token is required", vm.state.value.connectError)
        assertFalse(vm.state.value.isSuccess)
    }

    @Test
    fun connect_failsWhenPatDoesNotHaveCorrectPrefix() = runTest(testDispatcher) {
        val vm = ConnectViewModel(discovery, storage)
        vm.onPatChanged("invalid_prefix_1234567890123456789012345678901234567890123")
        vm.connect()

        assertEquals("Token must start with 'opsh_pat_'", vm.state.value.connectError)
        assertFalse(vm.state.value.isSuccess)
    }

    @Test
    fun connect_failsWhenPatIsTooShort() = runTest(testDispatcher) {
        val vm = ConnectViewModel(discovery, storage)
        vm.onPatChanged("opsh_pat_short")
        vm.connect()

        assertTrue(vm.state.value.connectError!!.contains("too short"))
        assertFalse(vm.state.value.isSuccess)
    }

    @Test
    fun connect_succeedsWithValidPatAndSavesInstance() = runTest(testDispatcher) {
        val vm = ConnectViewModel(discovery, storage)
        val validPat = "opsh_pat_" + "a".repeat(43)
        vm.onUrlChanged("http://localhost:4000")
        vm.onLabelChanged("Production Cluster")
        vm.onPatChanged(validPat)

        vm.connect()
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(vm.state.value.isSuccess)
        assertNull(vm.state.value.connectError)

        val saved = storage.getActiveInstance()
        assertEquals("Production Cluster", saved?.label)
        assertEquals("http://localhost:4000", saved?.url)
        assertEquals(validPat, saved?.pat)
    }
}
