package com.kareemessam.openship.shared.di

import com.kareemessam.openship.shared.client.DeployActionsRepository
import com.kareemessam.openship.shared.client.DeployLogsRepository
import com.kareemessam.openship.shared.client.DeploymentsRepository
import com.kareemessam.openship.shared.client.DiscoveryService
import com.kareemessam.openship.shared.client.HttpClientFactory
import com.kareemessam.openship.shared.client.McpClient
import com.kareemessam.openship.shared.client.McpConnectionManager
import com.kareemessam.openship.shared.client.MonitorRepository
import com.kareemessam.openship.shared.client.ProjectsRepository
import com.kareemessam.openship.shared.viewmodel.ConnectViewModel
import com.kareemessam.openship.shared.viewmodel.DeployLogsViewModel
import com.kareemessam.openship.shared.viewmodel.DeploymentHistoryViewModel
import com.kareemessam.openship.shared.viewmodel.MonitorViewModel
import com.kareemessam.openship.shared.viewmodel.ProjectsViewModel
import org.koin.core.module.dsl.viewModel
import org.koin.dsl.module

val sharedModule = module {
    single { HttpClientFactory.create() }
    single { DiscoveryService(get()) }
    single { ProjectsRepository(get(), get()) }
    single { DeployLogsRepository(get(), get()) }
    single { MonitorRepository(get(), get()) }
    single { McpClient(get(), get()) }
    single { McpConnectionManager(get(), get()) }
    single { DeployActionsRepository(get()) }
    single { DeploymentsRepository(get(), get()) }
    viewModel { ConnectViewModel(get(), get()) }
    viewModel { ProjectsViewModel(get(), get(), get(), get()) }
    viewModel { DeployLogsViewModel(get(), get()) }
    viewModel { MonitorViewModel(get(), get()) }
    viewModel { DeploymentHistoryViewModel(get(), get()) }
}
