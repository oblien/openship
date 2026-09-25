package com.kareemessam.openship

import android.app.Application
import com.kareemessam.openship.di.androidPlatformModule
import com.kareemessam.openship.shared.di.sharedModule
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin

class OpenshipApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidLogger()
            androidContext(this@OpenshipApplication)
            modules(sharedModule, androidPlatformModule)
        }
    }
}
