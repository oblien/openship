package com.kareemessam.openship.di

import com.kareemessam.openship.shared.platform.AndroidTokenStorage
import com.kareemessam.openship.shared.storage.TokenStorage
import org.koin.android.ext.koin.androidContext
import org.koin.dsl.module

val androidPlatformModule = module {
    single<TokenStorage> { AndroidTokenStorage(androidContext()) }
}
