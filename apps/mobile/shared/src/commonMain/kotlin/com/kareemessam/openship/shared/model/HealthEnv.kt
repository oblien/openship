package com.kareemessam.openship.shared.model

import kotlinx.serialization.Serializable

@Serializable
data class HealthEnv(
    val selfHosted: Boolean = true,
    val deployMode: String? = null,
    val isServerHost: Boolean = false,
    val hostControlEnabled: Boolean = false,
    val version: String = "",
    val authMode: String = "local",
    val productMode: String? = null,
    val teamMode: String? = null,
    val migrationTargetUrl: String? = null,
    val migrationInProgress: Boolean = false,
    val cloudAuthUrl: String? = null,
    val cloudApiUrl: String? = null,
    val machineName: String? = null,
    val hostDomain: String? = null
)
