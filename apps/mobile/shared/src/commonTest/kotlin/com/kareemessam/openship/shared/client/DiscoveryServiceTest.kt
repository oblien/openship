package com.kareemessam.openship.shared.client

import kotlin.test.Test
import kotlin.test.assertEquals

class DiscoveryServiceTest {

    @Test
    fun testNormalizeUrl() {
        val dummyClient = HttpClientFactory.create()
        val service = DiscoveryService(dummyClient)

        assertEquals("http://10.0.2.2:4000", service.normalizeUrl("10.0.2.2:4000"))
        assertEquals("http://10.0.2.2:4000", service.normalizeUrl("10.0.2.2:4000/"))
        assertEquals("http://192.168.1.50:4000", service.normalizeUrl("http://192.168.1.50:4000/"))
        assertEquals("https://api.openship.io", service.normalizeUrl("https://api.openship.io/"))
        assertEquals("https://api.openship.io", service.normalizeUrl("  https://api.openship.io  "))
    }
}
