package com.kareemessam.openship.shared.storage

import com.kareemessam.openship.shared.model.InstanceConfig
import com.kareemessam.openship.shared.viewmodel.FakeTokenStorage
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TokenStorageTest {

    @Test
    fun save_and_retrieve_instances() = runTest {
        val storage = FakeTokenStorage()
        val inst1 = InstanceConfig(id = "1", label = "Server A", url = "http://a:4000", pat = "opsh_pat_1")
        val inst2 = InstanceConfig(id = "2", label = "Server B", url = "http://b:4000", pat = "opsh_pat_2")

        storage.saveInstance(inst1)
        storage.saveInstance(inst2)

        val list = storage.loadInstances()
        assertEquals(2, list.size)
        assertEquals("2", storage.getActiveInstance()?.id)

        storage.setActiveInstance("1")
        assertEquals("Server A", storage.getActiveInstance()?.label)

        storage.deleteInstance("1")
        assertEquals(1, storage.loadInstances().size)
        assertEquals("2", storage.getActiveInstance()?.id)

        storage.clearAll()
        assertEquals(0, storage.loadInstances().size)
        assertNull(storage.getActiveInstance())
    }
}
