package com.kareemessam.openship.shared.model

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HealthEnvTest {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    @Test
    fun testHealthEnvDeserialization_withKnownFields() {
        val jsonString = """
            {
                "selfHosted": true,
                "deployMode": "desktop",
                "isServerHost": true,
                "hostControlEnabled": true,
                "version": "0.6.7",
                "authMode": "none",
                "productMode": "platform",
                "teamMode": "single_user",
                "migrationTargetUrl": null,
                "migrationInProgress": false,
                "cloudAuthUrl": "https://cloud.openship.io",
                "cloudApiUrl": "https://api.openship.io",
                "machineName": "MacBook-Pro",
                "hostDomain": "localhost"
            }
        """.trimIndent()

        val parsed = json.decodeFromString<HealthEnv>(jsonString)
        assertTrue(parsed.selfHosted)
        assertEquals("desktop", parsed.deployMode)
        assertEquals("0.6.7", parsed.version)
        assertEquals("none", parsed.authMode)
        assertEquals("MacBook-Pro", parsed.machineName)
    }

    @Test
    fun testHealthEnvDeserialization_withUnexpectedAdditiveFields() {
        // API has no versioning — test that unknown fields do not crash parsing
        val jsonString = """
            {
                "selfHosted": false,
                "version": "0.7.0",
                "authMode": "cloud",
                "brandNewFeatureFlag": true,
                "unexpectedNestedObject": { "foo": "bar", "count": 42 }
            }
        """.trimIndent()

        val parsed = json.decodeFromString<HealthEnv>(jsonString)
        assertFalse(parsed.selfHosted)
        assertEquals("0.7.0", parsed.version)
        assertEquals("cloud", parsed.authMode)
    }
}
